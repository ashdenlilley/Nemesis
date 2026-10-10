import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHooks, matchesHook, runHookCommand } from '../src/hooks.js';
import { compactSession, findCutIndex, maybeCompact, estimateTokens } from '../src/compact.js';
import { Session } from '../src/session.js';
import { startMcpServers, mcpToolName } from '../src/mcp/manager.js';
import { loadAgentDefs, createSubagentRunner, createTaskTool, BUILTIN_AGENTS } from '../src/subagents.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { createCommandRegistry, parseSlash } from '../src/commands/index.js';
import { createPermissions } from '../src/permissions.js';
import { createUsage } from '../src/usage.js';
import { runOnboarding } from '../src/onboarding.js';
import { loadEnvFile } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import { parseArgs } from '../src/cli.js';
import { createUI } from '../src/ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sink = () => ({ write() { return true; }, isTTY: false });
const quietUI = () => createUI({ out: sink(), err: sink(), color: false });

async function tempDir(prefix = 'nemesis-f-') {
  return mkdtemp(path.join(tmpdir(), prefix));
}

// ---------- hooks ----------

test('matchesHook: empty matches all, regex alternation, case-insensitive', () => {
  assert.ok(matchesHook(undefined, 'bash'));
  assert.ok(matchesHook('*', 'bash'));
  assert.ok(matchesHook('edit_file|write_file', 'write_file'));
  assert.ok(matchesHook('BASH', 'bash'));
  assert.ok(!matchesHook('edit_file', 'bash'));
});

test('hooks: PreToolUse matcher blocks only matching tools; exit 2 gives the reason', async () => {
  const config = {
    hooks: {
      PreToolUse: [{ matcher: 'edit_file|write_file', hooks: [{ type: 'command', command: 'block-edits' }] }],
    },
  };
  const runner = async (cmd) => ({ code: 2, stdout: '', stderr: 'no edits on main' });
  const hooks = createHooks(config, { cwd: '.', runner });
  assert.equal(hooks.count(), 1);

  assert.equal((await hooks.fire('PreToolUse', {}, { toolName: 'bash' })).blocked, false);
  const blocked = await hooks.fire('PreToolUse', {}, { toolName: 'edit_file' });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'no edits on main');
});

test('hooks: JSON decision block on exit 0 blocks; plain stdout on SessionStart becomes context', async () => {
  const config = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ command: 'policy' }] }],
      SessionStart: [{ hooks: [{ command: 'ctx' }] }],
    },
  };
  const runner = async (cmd) => (cmd === 'policy'
    ? { code: 0, stdout: '{"decision":"block","reason":"no secrets"}', stderr: '' }
    : { code: 0, stdout: 'branch: main', stderr: '' });
  const hooks = createHooks(config, { cwd: '.', runner });
  const blocked = await hooks.fire('UserPromptSubmit', { prompt: 'x' });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'no secrets');

  const start = await hooks.fire('SessionStart', {});
  assert.deepEqual(start.context, ['branch: main']);
});

test('hooks: stdin receives the event JSON; real runner passes exit code 2 through', async () => {
  const seen = [];
  const hooks = createHooks({ hooks: { Stop: [{ hooks: [{ command: 'x' }] }] } }, {
    cwd: '.', getSessionId: () => 'sess-1', runner: async (cmd, opts) => { seen.push(opts.input); return { code: 0, stdout: '', stderr: '' }; },
  });
  await hooks.fire('Stop', { stop_reason: 'end_turn' });
  assert.equal(seen[0].hook_event_name, 'Stop');
  assert.equal(seen[0].session_id, 'sess-1');
  assert.equal(seen[0].stop_reason, 'end_turn');

  const real = await runHookCommand('node -e "process.exit(2)"', { input: {}, cwd: here, timeoutMs: 20_000 });
  assert.equal(real.code, 2);
});

// ---------- compaction ----------

test('findCutIndex lands on a plain user-text message, never inside a tool exchange', () => {
  const messages = [
    { role: 'user', content: 'goal' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'glob', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: 'next ask' },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    { role: 'user', content: 'follow up' },
    { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
  ];
  assert.equal(findCutIndex(messages, 4), 4);
  assert.equal(findCutIndex(messages.slice(0, 3), 4), -1);
});

test('compactSession: summary replaces old turns, original kept as .bak, list ignores the backup', async () => {
  const dir = await tempDir();
  const session = await Session.create(dir);
  for (const m of [
    { role: 'user', content: 'first goal' },
    { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    { role: 'user', content: 'second goal' },
    { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    { role: 'user', content: 'third' },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    { role: 'user', content: 'fourth' },
    { role: 'assistant', content: [{ type: 'text', text: 'c' }] },
  ]) await session.append(m);

  const provider = {
    calls: [],
    async createMessage(req) {
      this.calls.push(req);
      return { content: [{ type: 'text', text: 'SUMMARY-OF-EARLY-WORK' }], stopReason: 'end_turn' };
    },
  };
  const result = await compactSession({ session, provider });
  assert.equal(result.compacted, true);
  assert.match(session.messages[0].content, /SUMMARY-OF-EARLY-WORK/);
  assert.equal(session.messages.at(-1).content[0].text, 'c');
  assert.match(provider.calls[0].messages[0].content, /first goal/);

  const files = await readdir(dir);
  assert.equal(files.filter((f) => f.includes('.bak-')).length, 1);
  assert.equal((await Session.list(dir)).length, 1);
});

test('maybeCompact only fires past the threshold', async () => {
  const session = Session.memory();
  for (let i = 0; i < 6; i++) {
    await session.append({ role: 'user', content: `turn ${i} `.repeat(200) });
    await session.append({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  }
  const provider = { async createMessage() { return { content: [{ type: 'text', text: 'S' }] }; } };
  const notes = [];
  const ui = { info: (t) => notes.push(t) };
  const used = estimateTokens('sys', session.messages);

  assert.equal(await maybeCompact({ session, provider, config: { contextWindow: used * 100 }, system: 'sys', ui }), false);
  assert.equal(await maybeCompact({ session, provider, config: { contextWindow: used, compactThreshold: 0.5 }, system: 'sys', ui }), true);
  assert.ok(notes.some((n) => /compacting/.test(n)));
});

// ---------- MCP ----------

test('MCP: stdio client lists and calls a tool through the manager', async () => {
  const fixture = path.join(here, 'fixtures', 'mcp-echo-server.mjs');
  const mcp = await startMcpServers({ echo: { command: process.execPath, args: [fixture] } }, { cwd: here });
  try {
    assert.equal(mcp.status[0].state, 'connected');
    assert.equal(mcp.tools.length, 1);
    const tool = mcp.tools[0];
    assert.equal(tool.name, 'mcp__echo__echo');
    assert.equal(tool.risk, 'exec');
    assert.equal(await tool.run({ text: 'hi' }, { signal: undefined }), 'echo: hi');
  } finally {
    await mcp.close();
  }
});

test('MCP: a server that fails to start is reported, not fatal', async () => {
  const mcp = await startMcpServers({ broken: { command: process.execPath, args: ['-e', 'process.exit(3)'] } }, { cwd: here });
  try {
    assert.equal(mcp.status[0].state, 'failed');
    assert.equal(mcp.tools.length, 0);
  } finally {
    await mcp.close();
  }
});

test('MCP tool names are sanitized to provider-safe identifiers', () => {
  assert.equal(mcpToolName('my.server', 'do thing'), 'mcp__my_server__do_thing');
});

// ---------- sub-agents and frontmatter ----------

test('frontmatter parses flat keys and body', () => {
  const { data, body } = parseFrontmatter('---\nname: "reviewer"\ntools: read_file, grep\n---\nYou review.\n');
  assert.equal(data.name, 'reviewer');
  assert.equal(data.tools, 'read_file, grep');
  assert.equal(body, 'You review.');
});

test('loadAgentDefs: builtins plus project markdown; project overrides by name', async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews diffs\ntools: read_file, grep\nmaxSteps: 7\n---\nReview carefully.');
  await writeFile(path.join(dir, 'explore.md'), '---\nname: explore\ndescription: custom explore\ntools: glob\n---\nOverridden.');
  const defs = await loadAgentDefs([dir, path.join(dir, 'missing')]);
  assert.equal(defs.get('reviewer').maxSteps, 7);
  assert.deepEqual(defs.get('reviewer').tools, ['read_file', 'grep']);
  assert.equal(defs.get('explore').description, 'custom explore');
  assert.ok(defs.has('general'));
  assert.equal(BUILTIN_AGENTS.length, 2);
});

test('sub-agent runs in its own context, restricted to its tools, and returns the final text', async () => {
  const dir = await tempDir();
  const agents = await loadAgentDefs([path.join(dir, 'none')]);
  const calls = [];
  const provider = {
    async createMessage(req) {
      calls.push({ ...req, messages: structuredClone(req.messages) });
      return { content: [{ type: 'text', text: 'found it at src/a.js:3' }], stopReason: 'end_turn' };
    },
  };
  const allTools = [
    { name: 'read_file', risk: 'read', parameters: { type: 'object', properties: {} }, run: async () => '' },
    { name: 'bash', risk: 'exec', parameters: { type: 'object', properties: {} }, run: async () => '' },
  ];
  const runner = createSubagentRunner({
    agents,
    allTools,
    getRuntime: () => ({ provider, config: { maxSteps: 5, outputStyle: 'default' } }),
    permissions: createPermissions({ policy: { read: 'allow', write: 'allow', exec: 'allow' } }),
    ui: quietUI(),
    hooks: null,
    cwd: dir,
  });
  const task = createTaskTool(runner);
  const out = await task.run({ prompt: 'where is A?', subagent_type: 'explore' }, { signal: undefined, cwd: dir });
  assert.equal(out, 'found it at src/a.js:3');
  assert.deepEqual(calls[0].tools.map((t) => t.name), ['read_file']);
  assert.equal(calls[0].messages.length, 1);
  assert.equal(calls[0].messages[0].content, 'where is A?');
  assert.match(calls[0].system, /read-only exploration/);
  await assert.rejects(task.run({ prompt: 'x', subagent_type: 'ghost' }, {}), /unknown agent "ghost"/);
});

// ---------- commands ----------

function fakeState(overrides = {}) {
  const messages = [];
  const state = {
    cwd: tempDirSync(),
    home: tempDirSync(),
    sessionsDir: tempDirSync(),
    ui: quietUI(),
    config: { outputStyle: 'default', provider: 'anthropic', model: 'm1', apiKey: 'k', contextWindow: 1000, permissions: { read: 'allow', write: 'ask', exec: 'ask' }, maxSteps: 3 },
    session: Session.memory(),
    custom: new Map([['hello', { name: 'hello', description: 'greet', body: 'Say hi to $ARGUMENTS' }]]),
    permissions: createPermissions({ policy: { read: 'allow', write: 'ask', exec: 'ask' } }),
    hooks: createHooks({}, { cwd: '.' }),
    mcp: { status: [], tools: [] },
    agents: new Map(),
    usage: createUsage(),
    roots: [],
    tools: [],
    planMode: false,
    args: { readOnly: false },
    provider: null,
    messages,
    setSession(s) { this.session = s; },
    ...overrides,
  };
  state.registry = createCommandRegistry(state);
  return state;
}

function tempDirSync() {
  return path.join(tmpdir(), `nemesis-cmd-${Math.random().toString(36).slice(2)}`);
}

test('parseSlash splits name and args', () => {
  assert.deepEqual(parseSlash('/Add-Dir  some path '), { name: 'add-dir', args: 'some path' });
  assert.deepEqual(parseSlash('/help'), { name: 'help', args: '' });
});

test('custom markdown commands expand $ARGUMENTS into a prompt', async () => {
  const state = fakeState();
  const r = await state.registry.dispatch('/hello world');
  assert.equal(r.handled, true);
  assert.equal(r.prompt, 'Say hi to world');
  assert.equal((await state.registry.dispatch('/nope')).handled, false);
});

test('/permissions sets and reports per-tool rules', async () => {
  const state = fakeState();
  await state.registry.dispatch('/permissions allow bash');
  assert.equal(state.permissions.getRules().bash, 'allow');
  await state.registry.dispatch('/permissions reset');
  assert.deepEqual(state.permissions.getRules(), {});
  await assert.rejects(state.registry.dispatch('/permissions wat'), /usage: \/permissions/);
});

test('/clear starts a new session; /exit sets exit flag; /plan flips read-only policy', async () => {
  const state = fakeState();
  const before = state.session.id;
  await state.registry.dispatch('/clear');
  assert.notEqual(state.session.id, before);
  await state.registry.dispatch('/exit');
  assert.equal(state.exit, true);
  // no file session in memory-only state; plan toggle still updates policy
  const perms = createPermissions({ policy: { read: 'allow', write: 'ask', exec: 'ask' } });
  state.permissions = perms;
  await state.registry.dispatch('/plan');
  assert.equal(perms.getPolicy().write, 'deny');
  await state.registry.dispatch('/plan');
  assert.equal(perms.getPolicy().write, 'ask');
});

test('/output-style validates and /model updates config and remembers it', async () => {
  const state = fakeState();
  await assert.rejects(state.registry.dispatch('/output-style loud'), /unknown style/);
  await state.registry.dispatch('/output-style concise');
  assert.equal(state.config.outputStyle, 'concise');
  await state.registry.dispatch('/model gpt-test');
  assert.equal(state.config.model, 'gpt-test');
});

test('every Claude Code default command name is registered', () => {
  const names = createCommandRegistry(fakeState()).builtins.map((c) => c.name);
  const expected = [
    'add-dir', 'agents', 'bug', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'exit',
    'export', 'help', 'hooks', 'ide', 'init', 'install-github-app', 'login', 'logout', 'mcp', 'memory',
    'model', 'output-style', 'permissions', 'plan', 'pr_comments', 'release-notes', 'resume', 'review',
    'status', 'terminal-setup', 'upgrade', 'vim', 'todos',
  ];
  for (const name of expected) assert.ok(names.includes(name), `missing /${name}`);
});

// ---------- onboarding ----------

test('onboarding (OpenAI-compatible): asks, writes key to .env and provider to config, next run needs no prompt', async () => {
  const home = await tempDir('nemesis-onb-');
  const cwd = await tempDir('nemesis-onb-cwd-');
  const answers = ['2', 'http://localhost:11434/v1', 'llama3', 'sk-local'];
  const rl = {
    _writeToOutput() {},
    async question() { return answers.shift() ?? ''; },
  };
  const env = {};
  const result = await runOnboarding({ rl, ui: quietUI(), home, env, out: sink() });
  assert.deepEqual(result, { provider: 'openai', model: 'llama3', baseUrl: 'http://localhost:11434/v1' });
  assert.equal(env.OPENAI_API_KEY, 'sk-local');

  // Next run: fresh process env, key comes from ~/.nemesis/.env, provider from config.
  const nextEnv = {};
  await loadEnvFile({ home, env: nextEnv });
  const config = await loadConfig({ cwd, home, env: nextEnv });
  assert.equal(config.provider, 'openai');
  assert.equal(config.model, 'llama3');
  assert.equal(config.apiKey, 'sk-local');
  assert.equal(config.baseUrl, 'http://localhost:11434/v1');
});

test('onboarding rejects an empty key', async () => {
  const home = await tempDir('nemesis-onb2-');
  const rl = { _writeToOutput() {}, async question() { return ''; } };
  await assert.rejects(
    runOnboarding({ rl, ui: quietUI(), home, env: {}, preferredProvider: 'anthropic', out: sink() }),
    /no key entered/,
  );
});

// ---------- CLI args ----------

test('parseArgs: prompt joining, flags, repeatable --add-dir, validation', () => {
  const a = parseArgs(['find', 'todos', '--no-stream', '--add-dir', '../lib', '--add-dir', '../x', '-m', 'mod', '--plan']);
  assert.equal(a.prompt, 'find todos');
  assert.equal(a.overrides.stream, false);
  assert.equal(a.overrides.model, 'mod');
  assert.deepEqual(a.addDirs, ['../lib', '../x']);
  assert.equal(a.plan, true);
  assert.throws(() => parseArgs(['--output-style', 'loud']), /--output-style must be one of/);
  assert.throws(() => parseArgs(['--max-steps', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
});

test('usage accumulates Anthropic and OpenAI field names', () => {
  const u = createUsage();
  u.add({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 });
  u.add({ prompt_tokens: 3, completion_tokens: 1 });
  assert.deepEqual(u.totals(), { requests: 2, input: 13, output: 3, cacheRead: 5, cacheWrite: 0 });
});
