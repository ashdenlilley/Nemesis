import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPermissions, matchesPattern, parseRuleSpec, suggestRule } from '../src/permissions.js';
import { createLoopGuard, stableJson } from '../src/agent.js';
import { networkCommand, scrubEnv } from '../src/sandbox.js';
import { loadSkills, skillsPromptSection, createSkillTool } from '../src/skills.js';
import { htmlToText } from '../src/tools/web.js';
import { McpHttpClient, expandHeaders } from '../src/mcp/http.js';
import { discover, pkce, readAuthStore, tokenSource } from '../src/mcp/oauth.js';
import { createTaskTool, createTaskOutputTool, createSubagentRunner } from '../src/subagents.js';
import { bashTool } from '../src/tools/shell.js';

// ---------- permission rules ----------

test('rule specs: bare tool name, pattern, and Claude Code casing', () => {
  assert.deepEqual(parseRuleSpec('bash'), { tool: 'bash', pattern: null, spec: 'bash' });
  assert.deepEqual(parseRuleSpec('Bash(npm test:*)'), { tool: 'bash', pattern: 'npm test:*', spec: 'bash(npm test:*)' });
  assert.throws(() => parseRuleSpec('bash()'), /bad rule/);
  assert.throws(() => parseRuleSpec('bash(npm'), /bad rule/);
});

test('prefix pattern matches whole words only and never across shell chaining', () => {
  assert.equal(matchesPattern('npm test:*', 'npm test'), true);
  assert.equal(matchesPattern('npm test:*', 'npm test -w app'), true);
  assert.equal(matchesPattern('npm test:*', 'npm testing'), false);
  assert.equal(matchesPattern('npm test:*', 'npm test && rm -rf /'), false);
  assert.equal(matchesPattern('npm test:*', 'npm test; curl x'), false);
  assert.equal(matchesPattern('npm test:*', 'npm test $(whoami)'), false);
});

test('glob pattern: * matches anything, other characters are literal', () => {
  assert.equal(matchesPattern('src/*.js', 'src/a.js'), true);
  assert.equal(matchesPattern('src/*.js', 'src/a.ts'), false);
  assert.equal(matchesPattern('a.b', 'axb'), false);
});

test('pattern rule allows only matching calls; deny beats allow', async () => {
  const bash = { name: 'bash', risk: 'exec', target: (i) => i.command, describeCall: (i) => i.command };
  const p = createPermissions({ policy: { read: 'allow', write: 'ask', exec: 'ask' }, allow: ['bash(npm test:*)'] });
  assert.equal((await p.check(bash, { command: 'npm test' })).allowed, true);
  assert.equal((await p.check(bash, { command: 'npm publish' })).allowed, false);

  const q = createPermissions({ policy: { read: 'allow', write: 'allow', exec: 'allow' }, allow: ['bash'], deny: ['bash(rm:*)'] });
  assert.equal((await q.check(bash, { command: 'rm -rf x' })).allowed, false);
  assert.equal((await q.check(bash, { command: 'ls' })).allowed, true);
});

test('"don\'t ask again" offers a pattern for plain commands and the tool name otherwise', () => {
  const bash = { name: 'bash' };
  assert.equal(suggestRule(bash, { command: 'npm test -- --watch' }), 'bash(npm test:*)');
  assert.equal(suggestRule(bash, { command: 'npm test && curl evil' }), 'bash');
  assert.equal(suggestRule({ name: 'edit_file' }, { path: 'a' }), 'edit_file');
});

test('setRule accepts a pattern spec and getRules lists it', () => {
  const p = createPermissions({ policy: { read: 'allow', write: 'ask', exec: 'ask' } });
  p.setRule('bash(git status:*)', 'allow');
  assert.equal(p.getRules()['bash(git status:*)'], 'allow');
  p.setRule('bash(git status:*)', 'remove');
  assert.equal(p.getRules()['bash(git status:*)'], undefined);
});

// ---------- loop guard ----------

test('loop guard warns at 3 identical results and stops at 6', () => {
  const guard = createLoopGuard();
  const use = { name: 'bash', input: { command: 'x' } };
  const out = { content: 'exit code 1', isError: true };
  assert.equal(guard.note(use, out), null);
  assert.equal(guard.note(use, out), null);
  assert.match(guard.note(use, out).text, /3 times/);
  assert.equal(guard.note(use, out), null);
  assert.equal(guard.note(use, out), null);
  assert.equal(guard.note(use, out).stop, true);
});

test('loop guard resets when the result changes or the input differs', () => {
  const guard = createLoopGuard();
  const use = { name: 'bash', input: { command: 'x' } };
  for (let i = 0; i < 5; i++) assert.equal(guard.note(use, { content: `try ${i}`, isError: false }), null);
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
});

// ---------- sandbox ----------

test('sandbox: network-looking commands are flagged, local ones are not', () => {
  assert.equal(networkCommand('curl https://x'), 'curl');
  assert.equal(networkCommand('git push origin main'), 'git push');
  assert.equal(networkCommand('npm install left-pad'), 'npm install');
  assert.equal(networkCommand('npm test'), null);
  assert.equal(networkCommand('git status'), null);
});

test('sandbox: scrubEnv drops keys and tokens but keeps PATH', () => {
  const env = scrubEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', MY_SECRET: 's', HOME: '/h' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('strict sandbox refuses bash network commands before running them', async () => {
  await assert.rejects(
    bashTool.run({ command: 'curl https://example.com' }, { cwd: process.cwd(), config: { sandbox: 'strict' } }),
    /blocked by sandbox/,
  );
});

// ---------- skills ----------

test('skills load from SKILL.md folders; the prompt lists them and the skill tool returns the body', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nemesis-skills-'));
  await mkdir(path.join(root, 'release'));
  await writeFile(path.join(root, 'release', 'SKILL.md'), '---\nname: release\ndescription: Cut a release\n---\nStep 1: bump version.');
  await mkdir(path.join(root, 'empty'));
  const skills = await loadSkills([root, path.join(root, 'missing')]);
  assert.equal(skills.get('release').description, 'Cut a release');
  assert.match(skillsPromptSection(skills), /- release: Cut a release/);
  const out = await createSkillTool(skills).run({ name: 'RELEASE' }, {});
  assert.match(out, /Step 1: bump version\./);
  assert.throws(() => createSkillTool(skills).run({ name: 'nope' }, {}), /unknown skill/);
  assert.equal(skillsPromptSection(new Map()), '');
});

// ---------- web ----------

test('htmlToText keeps readable text and drops scripts and tags', () => {
  const text = htmlToText('<html><script>evil()</script><style>p{}</style><h1>Title</h1><p>Hello &amp; <b>bye</b></p><ul><li>one</li></ul></html>');
  assert.match(text, /Title/);
  assert.match(text, /Hello & bye/);
  assert.match(text, /- one/);
  assert.doesNotMatch(text, /evil|<|p\{\}/);
});

// ---------- MCP over HTTP ----------

// A minimal Streamable HTTP MCP server: JSON replies, an SSE reply for tools/call, and a session id.
function fakeMcp({ requireToken = null } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (requireToken && req.headers.authorization !== `Bearer ${requireToken}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200).end();
        return;
      }
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, headers: req.headers });
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        res.end(JSON.stringify(reply({ serverInfo: { name: 'fake' } })));
      } else if (msg.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] })));
      } else if (msg.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': keep-alive\n\n');
        res.end(`event: message\ndata: ${JSON.stringify(reply({ content: [{ type: 'text', text: `echo ${msg.params.arguments.text}` }] }))}\n\n`);
      } else {
        res.writeHead(404).end();
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

test('MCP HTTP: initialize, list tools, call a tool over SSE, and echo the session id', async () => {
  const { server, seen, url } = await fakeMcp();
  try {
    const client = new McpHttpClient({ name: 'fake', url, headers: { 'x-team': 'core' } });
    await client.start();
    const tools = await client.listTools();
    assert.equal(tools[0].name, 'echo');
    const res = await client.callTool('echo', { text: 'hi' });
    assert.equal(res.content[0].text, 'echo hi');
    const notified = seen.find((s) => s.method === 'notifications/initialized');
    assert.equal(notified.headers['mcp-session-id'], 'sess-1');
    assert.equal(seen[0].headers['x-team'], 'core');
    await client.close();
  } finally {
    server.close();
  }
});

test('MCP HTTP: a 401 without a login says how to sign in', async () => {
  const { server, url } = await fakeMcp({ requireToken: 'good' });
  try {
    const client = new McpHttpClient({ name: 'gh', url });
    await assert.rejects(client.start(), /needs login: run \/mcp login gh/);
  } finally {
    server.close();
  }
});

test('MCP HTTP: a stored OAuth token is sent as a bearer token', async () => {
  const { server, url } = await fakeMcp({ requireToken: 'good' });
  try {
    const auth = { token: async () => 'good', refresh: async () => false };
    const client = new McpHttpClient({ name: 'gh', url, auth });
    await client.start();
    assert.equal((await client.listTools()).length, 1);
  } finally {
    server.close();
  }
});

test('expandHeaders replaces ${VAR} from the environment', () => {
  assert.deepEqual(expandHeaders({ Authorization: 'Bearer ${GH_TOKEN}' }, { GH_TOKEN: 'abc' }), { Authorization: 'Bearer abc' });
  assert.deepEqual(expandHeaders({ X: '${MISSING}' }, {}), { X: '' });
});

// ---------- OAuth ----------

test('PKCE challenge is the base64url SHA-256 of the verifier', async () => {
  const { createHash } = await import('node:crypto');
  const { verifier, challenge } = pkce();
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
});

test('discover follows protected resource metadata to the authorization server', async () => {
  const docs = {
    'https://mcp.example/.well-known/oauth-protected-resource/mcp': { authorization_servers: ['https://auth.example'] },
    'https://auth.example/.well-known/oauth-authorization-server': {
      authorization_endpoint: 'https://auth.example/authorize',
      token_endpoint: 'https://auth.example/token',
      registration_endpoint: 'https://auth.example/register',
    },
  };
  const fetchImpl = async (url) => {
    const doc = docs[String(url)];
    return doc ? new Response(JSON.stringify(doc), { status: 200 }) : new Response('', { status: 404 });
  };
  const meta = await discover('https://mcp.example/mcp', fetchImpl);
  assert.equal(meta.token_endpoint, 'https://auth.example/token');
});

test('token source refreshes an expired token and saves the new one', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'nemesis-auth-'));
  const { writeFile: wf } = await import('node:fs/promises');
  await mkdir(path.join(home, '.nemesis'));
  await wf(path.join(home, '.nemesis', 'mcp-auth.json'), JSON.stringify({
    gh: { access_token: 'old', refresh_token: 'r1', expires_at: Date.now() - 1000, token_endpoint: 'https://auth.example/token', client_id: 'c', resource: 'x' },
  }));
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), 'https://auth.example/token');
    assert.match(init.body.toString(), /grant_type=refresh_token/);
    return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }), { status: 200 });
  };
  const source = tokenSource({ name: 'gh', home, fetchImpl });
  assert.equal(await source.token(), 'new');
  const saved = await readAuthStore(home);
  assert.equal(saved.gh.refresh_token, 'r2');
  assert.ok(saved.gh.expires_at > Date.now());
});

// ---------- background sub-agents ----------

test('background task returns at once; task_output collects the result', async () => {
  const agents = new Map([['general', { name: 'general', description: 'g', tools: '*', system: 's' }]]);
  const provider = {
    async createMessage() {
      await new Promise((r) => setTimeout(r, 30));
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done in background' }], usage: {} };
    },
  };
  const runner = createSubagentRunner({
    agents,
    allTools: [],
    getRuntime: () => ({ provider, config: { maxSteps: 3, outputStyle: 'default' } }),
    permissions: createPermissions({ policy: { read: 'allow', write: 'allow', exec: 'allow' } }),
    ui: { child: () => ({ toolCall() {}, toolResult() {}, assistant() {}, streamText() {}, endStream() {}, info() {}, warn() {}, error() {} }), warn() {}, error() {} },
    hooks: null,
    cwd: process.cwd(),
  });
  const task = createTaskTool(runner);
  const output = createTaskOutputTool(runner);
  const started = await task.run({ prompt: 'work', run_in_background: true }, { cwd: process.cwd() });
  assert.match(started, /task-1/);
  assert.match(await output.run({ id: 'task-1' }), /still running/);
  assert.equal(await output.run({ id: 'task-1', wait: true }), 'done in background');
  assert.equal(task.concurrent, true);
});
