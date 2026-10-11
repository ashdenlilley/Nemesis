import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Checkpoints } from '../src/checkpoints.js';
import { mapClaudeRule, readClaudePermissions } from '../src/claude-import.js';
import { runOnboarding, checkKey, PERMISSION_PRESETS } from '../src/onboarding.js';
import { loadConfig } from '../src/config.js';
import { createUI } from '../src/ui.js';

const sink = () => ({ write() { return true; }, isTTY: false });
const quietUI = () => createUI({ out: sink(), err: sink(), color: false });

test('checkpoints: a file is saved once per turn, before its first change', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nemesis-cp-'));
  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'v0');
  const cp = new Checkpoints(path.join(dir, 'cp'), 'sess-1');
  await cp.begin(0, 'first change');
  await cp.record(file);
  await writeFile(file, 'v1');
  await cp.record(file); // second change in the same turn: keeps v0
  await writeFile(file, 'v2');
  await cp.begin(2, 'second change');
  await cp.record(file);
  await writeFile(file, 'v3');
  const turns = await cp.list();
  assert.equal(turns[0].prompt, 'second change');
  assert.equal(turns[0].files[file], 'v2');
  assert.equal(turns[1].files[file], 'v0');
});

test('restoreFiles puts code back to before the chosen turn; a new file is deleted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nemesis-cp2-'));
  const kept = path.join(dir, 'kept.txt');
  const created = path.join(dir, 'new.txt');
  await writeFile(kept, 'original');
  const cp = new Checkpoints(path.join(dir, 'cp'), 'sess-2');
  await cp.begin(0, 'turn one');
  await cp.record(kept);
  await writeFile(kept, 'after one');
  await cp.begin(2, 'turn two');
  await cp.record(kept);
  await writeFile(kept, 'after two');
  await cp.record(created);
  await writeFile(created, 'made in turn two');

  const restored = await cp.restoreFiles(0);
  assert.equal(restored, 2);
  assert.equal(await readFile(kept, 'utf8'), 'original');
  await assert.rejects(access(created));
});

test('checkpoints survive a restart: a new instance reads the saved file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nemesis-cp3-'));
  const file = path.join(dir, 'x.txt');
  await writeFile(file, 'before');
  const first = new Checkpoints(path.join(dir, 'cp'), 'sess-3');
  await first.begin(0, 'edit x');
  await first.record(file);
  const second = new Checkpoints(path.join(dir, 'cp'), 'sess-3');
  assert.equal((await second.list())[0].count, 1);
});

test('dropFrom forgets turns from index i on', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nemesis-cp4-'));
  const cp = new Checkpoints(path.join(dir, 'cp'), 'sess-4');
  await cp.begin(0, 'a');
  await cp.begin(2, 'b');
  await cp.dropFrom(1);
  assert.deepEqual((await cp.list()).map((t) => t.prompt), ['a']);
});

test('Claude Code rules map to Nemesis rules; unknown tools are counted as skipped', () => {
  assert.equal(mapClaudeRule('Bash(npm test:*)'), 'bash(npm test:*)');
  assert.equal(mapClaudeRule('Read(./src/**)'), 'read_file(src/**)');
  assert.equal(mapClaudeRule('Edit'), 'edit_file');
  assert.equal(mapClaudeRule('MultiEdit'), 'edit_file');
  assert.equal(mapClaudeRule('Task'), null);
});

test('readClaudePermissions reads allow and deny lists from ~/.claude/settings.json', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'nemesis-claude-'));
  await mkdir(path.join(home, '.claude'));
  await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(git status)', 'Bash(npm test:*)', 'Task'], deny: ['Bash(rm:*)'] },
  }));
  const got = await readClaudePermissions(home);
  assert.deepEqual(got.allow, ['bash(git status)', 'bash(npm test:*)']);
  assert.deepEqual(got.deny, ['bash(rm:*)']);
  assert.equal(got.skipped, 1);
  assert.equal(await readClaudePermissions(await mkdtemp(path.join(tmpdir(), 'nemesis-none-'))), null);
});

test('onboarding with a terminal menu: saves the chosen permission preset and imports Claude rules', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'nemesis-onb3-'));
  await mkdir(path.join(home, '.claude'));
  await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } }));
  const answers = ['1', 'sk-test'];
  const menus = [1, 0]; // Auto-edit preset, then import Yes
  const rl = {
    async question() { return answers.shift() ?? ''; },
    async choose() { return menus.shift(); },
  };
  await runOnboarding({ rl, ui: quietUI(), home, env: {}, preferredProvider: 'anthropic', out: sink(), check: async () => ({ ok: true }) });
  const config = await loadConfig({ cwd: home, home, env: {} });
  assert.deepEqual(config.permissions, PERMISSION_PRESETS[1].policy);
  assert.deepEqual(config.allowRules, ['bash(npm test:*)']);
});

test('checkKey reports a failure instead of throwing', async () => {
  const result = await checkKey({ provider: 'openai', baseUrl: 'http://127.0.0.1:9', key: 'k', model: 'm' });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});
