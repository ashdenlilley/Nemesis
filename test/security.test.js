import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPermissions, isReadOnlyCommand, matchesPattern, segmentsOf } from '../src/permissions.js';
import { addLocalRules, loadConfig, saveUserConfig } from '../src/config.js';
import { createLineReader } from '../src/input.js';

const bash = { name: 'bash', risk: 'exec', target: (i) => i.command, describeCall: (i) => i.command };
const edit = { name: 'edit_file', risk: 'write', pathTarget: true, target: (i) => i.path, describeCall: (i) => i.path };
const read = { name: 'read_file', risk: 'read', pathTarget: true, target: (i) => i.path, describeCall: (i) => i.path };
const fetchTool = { name: 'web_fetch', risk: 'exec', target: (i) => i.url, describeCall: (i) => i.url };
const ALL_ALLOW = { read: 'allow', write: 'allow', exec: 'allow' };
const ASK = { read: 'allow', write: 'ask', exec: 'ask' };
const never = async () => -1;

// ---------- chained and substituted commands ----------

test('deny catches a dangerous command chained behind an allowed one (the reported hole)', async () => {
  const p = createPermissions({ policy: ALL_ALLOW, allow: ['bash'], deny: ['bash(rm:*)'] });
  assert.equal((await p.check(bash, { command: 'rm -rf x' })).allowed, false);
  assert.equal((await p.check(bash, { command: 'ls; rm -rf x' })).allowed, false);
  assert.equal((await p.check(bash, { command: 'ls && rm -rf x' })).allowed, false);
  assert.equal((await p.check(bash, { command: 'ls | rm -rf x' })).allowed, false);
  assert.equal((await p.check(bash, { command: 'echo $(rm -rf x)' })).allowed, false);
  assert.equal((await p.check(bash, { command: 'echo `rm -rf x`' })).allowed, false);
  assert.equal((await p.check(bash, { command: 'ls -la' })).allowed, true);
});

test('segmentsOf splits on separators and substitutions', () => {
  assert.deepEqual(segmentsOf('npm test && curl x; echo $(whoami)'), ['npm test', 'curl x', 'echo', 'whoami']);
});

test('an allow pattern applies only when every piece of a chained command matches', async () => {
  const p = createPermissions({ policy: ASK, allow: ['bash(npm test:*)'] });
  assert.equal((await p.check(bash, { command: 'npm test -w app' })).allowed, true);
  assert.equal((await p.check(bash, { command: 'npm test && curl evil.sh' })).allowed, false);
  assert.equal((await p.check(bash, { command: 'npm test $(curl evil.sh)' })).allowed, false);
});

test('prefix matching never accepts a chained command on its own', () => {
  assert.equal(matchesPattern('npm test:*', 'npm test; rm -rf /'), false);
  assert.equal(matchesPattern('npm test:*', 'npm testing'), false);
});

// ---------- precedence ----------

test('ask rule forces a prompt even under a broader allow', async () => {
  let asked = 0;
  const p = createPermissions({ policy: ALL_ALLOW, allow: ['bash'], ask: ['bash(git push:*)'], choose: async () => { asked++; return 0; } });
  assert.equal((await p.check(bash, { command: 'git push origin main' })).allowed, true);
  assert.equal(asked, 1);
  assert.equal((await p.check(bash, { command: 'ls' })).allowed, true);
  assert.equal(asked, 1, 'no prompt for an unrelated command');
});

test('deny beats ask beats allow', async () => {
  const p = createPermissions({ policy: ALL_ALLOW, allow: ['bash'], ask: ['bash(rm:*)'], deny: ['bash(rm -rf /:*)'], choose: async () => 0 });
  assert.equal((await p.check(bash, { command: 'rm -rf /' })).allowed, false);
  assert.equal((await p.check(bash, { command: 'rm file' })).allowed, true);
});

test('bypass policy still honors deny rules', async () => {
  const p = createPermissions({ policy: ALL_ALLOW, deny: ['bash(shutdown:*)'] });
  assert.equal((await p.check(bash, { command: 'shutdown now' })).allowed, false);
  assert.equal((await p.check(bash, { command: 'npm run build' })).allowed, true);
});

// ---------- read-only commands ----------

test('read-only shell commands run without asking; anything that writes still asks', async () => {
  const p = createPermissions({ policy: ASK, choose: never });
  for (const command of ['ls -la', 'cat README.md', 'git status', 'git diff --stat', 'grep -r foo src', 'find . -name "*.js"']) {
    assert.equal((await p.check(bash, { command })).allowed, true, command);
  }
  for (const command of ['echo hi > out.txt', 'cat x >> y', 'git push', 'git commit -m x', 'find . -delete', 'ls; rm x', 'cat $(rm x)']) {
    assert.equal((await p.check(bash, { command })).allowed, false, command);
  }
  assert.equal(isReadOnlyCommand('ls && curl x'), false);
});

test('read-only exec policy blocks even read-only commands', async () => {
  const p = createPermissions({ policy: { read: 'allow', write: 'deny', exec: 'deny' } });
  assert.equal((await p.check(bash, { command: 'ls' })).allowed, false);
});

// ---------- path and domain specifiers ----------

test('file rules match paths relative to the workspace, with ** across folders and * within one', async () => {
  const cwd = path.resolve('/work/project');
  const p = createPermissions({ policy: ASK, cwd, allow: ['edit_file(src/*.js)'], deny: ['read_file(.env)'] });
  assert.equal((await p.check(edit, { path: 'src/a.js' })).allowed, true);
  assert.equal((await p.check(edit, { path: 'src/deep/a.js' })).allowed, false, '* does not cross folders');
  assert.equal(matchesPattern('src/**', 'src/deep/a.js', { pathMode: true }), true);
  assert.equal((await p.check(read, { path: '.env' })).allowed, false);
  assert.equal((await p.check(read, { path: './.env' })).allowed, false, './ is normalized');
});

test('a path rule also matches the absolute path', async () => {
  const cwd = path.resolve('/work/project');
  const abs = path.resolve(cwd, 'src/a.js');
  const p = createPermissions({ policy: ASK, cwd, allow: [`edit_file(${abs.split(path.sep).join('/')})`] });
  assert.equal((await p.check(edit, { path: abs })).allowed, true);
});

test('domain rules match the host and its subdomains only', async () => {
  const p = createPermissions({ policy: ASK, allow: ['web_fetch(domain:example.com)'] });
  assert.equal((await p.check(fetchTool, { url: 'https://docs.example.com/x' })).allowed, true);
  assert.equal((await p.check(fetchTool, { url: 'https://example.com/' })).allowed, true);
  assert.equal((await p.check(fetchTool, { url: 'https://evil-example.com/' })).allowed, false);
});

// ---------- persistence and prompts ----------

test('"don\'t ask again" is saved to the project local config and holds on the next run', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'nemesis-persist-'));
  const home = await mkdtemp(path.join(tmpdir(), 'nemesis-persist-home-'));
  const picks = [1];
  const p = createPermissions({
    policy: ASK,
    cwd,
    choose: async () => picks.shift(),
    onPersist: (spec) => addLocalRules(cwd, { allowRules: [spec] }),
  });
  assert.equal((await p.check(bash, { command: 'npm test -w app' })).allowed, true);
  const saved = JSON.parse(await readFile(path.join(cwd, '.nemesis', 'config.local.json'), 'utf8'));
  assert.deepEqual(saved.allowRules, ['bash(npm test:*)']);

  const next = await loadConfig({ cwd, home, env: {} });
  assert.ok(next.allowRules.includes('bash(npm test:*)'));
});

test('rule lists add up across user and project layers instead of replacing each other', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'nemesis-layers-'));
  const home = await mkdtemp(path.join(tmpdir(), 'nemesis-layers-home-'));
  await saveUserConfig({ allowRules: ['bash(git status)'] }, home);
  await addLocalRules(cwd, { allowRules: ['bash(npm test:*)'], askRules: ['bash(git push:*)'] });
  const config = await loadConfig({ cwd, home, env: {} });
  assert.deepEqual(config.allowRules.sort(), ['bash(git status)', 'bash(npm test:*)']);
  assert.deepEqual(config.askRules, ['bash(git push:*)']);
});

test('prompts that arrive while one is open wait their turn instead of replacing it', async () => {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = { isTTY: true, columns: 60, write() { return true; } };
  const rl = createLineReader({ input, output });
  const first = rl.choose({ title: 'one', options: ['a', 'b'] });
  const second = rl.choose({ title: 'two', options: ['c', 'd'] });
  input.write('\r');
  assert.equal(await first, 0);
  input.write('\x1b[B');
  input.write('\r');
  assert.equal(await second, 1);
});
