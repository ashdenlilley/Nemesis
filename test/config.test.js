import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS, PROVIDERS, loadConfig, saveUserConfig, userConfigFile } from '../src/config.js';
import { envFilePath, loadEnvFile, parseEnv, setEnvKeys } from '../src/env.js';
import { Session } from '../src/session.js';
import { buildSystemPrompt } from '../src/prompt.js';

async function dirs() {
  return {
    cwd: await mkdtemp(path.join(tmpdir(), 'nemesis-cwd-')),
    home: await mkdtemp(path.join(tmpdir(), 'nemesis-home-')),
  };
}

test('loadConfig: CLI overrides env, project overrides defaults, permissions merge', async () => {
  const { cwd, home } = await dirs();
  await mkdir(path.join(cwd, '.nemesis'));
  await writeFile(path.join(cwd, '.nemesis', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'project-model',
    permissions: { exec: 'deny' },
  }));
  const config = await loadConfig({
    cwd,
    home,
    env: { NEMESIS_MODEL: 'env-model', ANTHROPIC_API_KEY: 'sk-test' },
    overrides: { model: 'cli-model' },
  });
  assert.equal(config.model, 'cli-model');
  assert.equal(config.permissions.exec, 'deny');
  assert.equal(config.permissions.read, DEFAULTS.permissions.read);
  assert.equal(config.apiKey, 'sk-test');
});

test('loadConfig: remembered provider and per-provider profile are used on next run', async () => {
  const { cwd, home } = await dirs();
  await saveUserConfig({ provider: 'openai', profiles: { openai: { model: 'llama3', baseUrl: 'http://localhost:11434/v1' } } }, home);
  const env = { OPENAI_API_KEY: 'k-openai' };

  const config = await loadConfig({ cwd, home, env });
  assert.equal(config.provider, 'openai');
  assert.equal(config.model, 'llama3');
  assert.equal(config.baseUrl, 'http://localhost:11434/v1');
  assert.equal(config.apiKey, 'k-openai');

  // Switching provider via flag must not leak the openai model or base URL.
  const other = await loadConfig({ cwd, home, env, overrides: { provider: 'anthropic' } });
  assert.equal(other.model, PROVIDERS.anthropic.defaultModel);
  assert.equal(other.baseUrl, PROVIDERS.anthropic.defaultBaseUrl);
  assert.equal(other.apiKey, null);
});

test('loadConfig: project model applies only to the provider it was written for', async () => {
  const { cwd, home } = await dirs();
  await mkdir(path.join(cwd, '.nemesis'));
  await writeFile(path.join(cwd, '.nemesis', 'config.json'), JSON.stringify({ provider: 'openai', model: 'gpt-x' }));
  const onOpenAI = await loadConfig({ cwd, home, env: {} });
  assert.equal(onOpenAI.model, 'gpt-x');
  const onAnthropic = await loadConfig({ cwd, home, env: {}, overrides: { provider: 'anthropic' } });
  assert.equal(onAnthropic.model, PROVIDERS.anthropic.defaultModel);
});

test('loadConfig rejects unknown providers', async () => {
  const { cwd, home } = await dirs();
  await assert.rejects(loadConfig({ cwd, home, env: {}, overrides: { provider: 'nope' } }), /unknown provider/);
});

test('saveUserConfig merges profiles per provider and keeps other keys', async () => {
  const { home } = await dirs();
  await saveUserConfig({ provider: 'anthropic', profiles: { anthropic: { model: 'a1' } } }, home);
  const next = await saveUserConfig({ profiles: { openai: { model: 'o1' } } }, home);
  assert.equal(next.provider, 'anthropic');
  assert.equal(next.profiles.anthropic.model, 'a1');
  assert.equal(next.profiles.openai.model, 'o1');
  assert.equal(JSON.parse(await readFile(userConfigFile(home), 'utf8')).profiles.openai.model, 'o1');
});

test('env file: set, reload, remove, and real env vars win over file values', async () => {
  const { home } = await dirs();
  const env = {};
  await setEnvKeys({ OPENAI_API_KEY: 'sk-1', ANTHROPIC_API_KEY: 'sk-2' }, { home, env });
  assert.equal(env.OPENAI_API_KEY, 'sk-1');
  const text = await readFile(envFilePath(home), 'utf8');
  assert.match(text, /OPENAI_API_KEY=sk-1/);

  const fresh = {};
  await loadEnvFile({ home, env: fresh });
  assert.equal(fresh.ANTHROPIC_API_KEY, 'sk-2');

  const realWins = { ANTHROPIC_API_KEY: 'from-shell' };
  await loadEnvFile({ home, env: realWins });
  assert.equal(realWins.ANTHROPIC_API_KEY, 'from-shell');

  await setEnvKeys({ OPENAI_API_KEY: null }, { home, env });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.doesNotMatch(await readFile(envFilePath(home), 'utf8'), /OPENAI_API_KEY/);
});

test('parseEnv handles export, quotes, comments, and blank lines', () => {
  assert.deepEqual(parseEnv('# c\n\nexport A=1\nB="two"\nC=\'three\'\nbad line\n'), { A: '1', B: 'two', C: 'three' });
});

test('Session round-trips messages through JSONL and list is newest first', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nemesis-sess-'));
  const s = await Session.create(dir);
  await s.append({ role: 'user', content: 'hello' });
  await s.append({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] });

  const reopened = await Session.open(s.file);
  assert.deepEqual(reopened.messages, s.messages);
  const latest = await Session.latest(dir);
  assert.equal(latest.id, s.id);
  assert.equal(await Session.latest(path.join(dir, 'missing')), null);
});

test('memory session never touches disk', async () => {
  const s = Session.memory();
  await s.append({ role: 'user', content: 'x' });
  assert.equal(s.file, null);
  assert.equal(s.messages.length, 1);
});

test('buildSystemPrompt includes environment, style, extra context, and first instruction file only', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'nemesis-prompt-'));
  await writeFile(path.join(cwd, 'AGENTS.md'), 'use tabs');
  await writeFile(path.join(cwd, 'CLAUDE.md'), 'ignored');
  const text = await buildSystemPrompt({
    cwd, platform: 'linux', now: new Date('2026-01-02T00:00:00Z'), outputStyle: 'concise', extra: ['hook says hi'],
  });
  assert.match(text, /Date: 2026-01-02/);
  assert.match(text, /Keep responses to a few sentences/);
  assert.match(text, /Context from hooks:\nhook says hi/);
  assert.match(text, /Project instructions \(AGENTS\.md\):\nuse tabs/);
  assert.doesNotMatch(text, /ignored/);
});
