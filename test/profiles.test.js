import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, saveUserConfig, userConfigFile } from '../src/config.js';
import { profileKeyEnv, profileSummary, profileWizard, removeUserProfile, normalizeProfile } from '../src/profiles.js';
import { profileModelRows, switchProfile } from '../src/commands/builtin.js';
import { JobRegistry, createJobTools, jobSummary } from '../src/jobs.js';
import { bashTool } from '../src/tools/shell.js';
import { createUI } from '../src/ui.js';

const sink = () => ({ write() { return true; }, isTTY: false });
const quietUI = () => createUI({ out: sink(), err: sink(), color: false });
const tempDir = (p) => mkdtemp(path.join(tmpdir(), p));

// ---------- profile resolution ----------

test('an active profile sets provider, base URL, model and key variable', async () => {
  const home = await tempDir('nemesis-prof-');
  const cwd = await tempDir('nemesis-prof-cwd-');
  await saveUserConfig({
    activeProfile: 'lab',
    profiles: {
      lab: { provider: 'openai', baseUrl: 'http://10.0.0.5:8000/v1', models: ['qwen', 'llama'], model: 'llama', keyless: true },
      claude: { provider: 'anthropic', models: ['claude-opus-5-5', 'claude-sonnet-5-5'], model: 'claude-sonnet-5-5', keyEnv: 'NEMESIS_KEY_CLAUDE' },
    },
  }, home);
  const lab = await loadConfig({ cwd, home, env: {} });
  assert.equal(lab.profile, 'lab');
  assert.equal(lab.provider, 'openai');
  assert.equal(lab.baseUrl, 'http://10.0.0.5:8000/v1');
  assert.equal(lab.model, 'llama');
  assert.equal(lab.apiKey, 'local');
  assert.deepEqual(lab.models, ['qwen', 'llama']);

  const claude = await loadConfig({ cwd, home, env: { NEMESIS_KEY_CLAUDE: 'sk-ant-x' }, overrides: { profile: 'claude' } });
  assert.equal(claude.provider, 'anthropic');
  assert.equal(claude.model, 'claude-sonnet-5-5');
  assert.equal(claude.apiKey, 'sk-ant-x');
});

test('--provider without --profile uses that provider\'s own profile, not the active one', async () => {
  const home = await tempDir('nemesis-prof2-');
  const cwd = await tempDir('nemesis-prof2-cwd-');
  await saveUserConfig({
    activeProfile: 'lab',
    profiles: { lab: { provider: 'openai', baseUrl: 'http://10.0.0.5/v1', model: 'qwen' }, anthropic: { model: 'claude-opus-5-5' } },
  }, home);
  const config = await loadConfig({ cwd, home, env: {}, overrides: { provider: 'anthropic' } });
  assert.equal(config.profile, 'anthropic');
  assert.equal(config.model, 'claude-opus-5-5');
});

test('a profile entry written before profiles existed still resolves by provider name', async () => {
  const home = await tempDir('nemesis-prof3-');
  const cwd = await tempDir('nemesis-prof3-cwd-');
  await saveUserConfig({ provider: 'openai', profiles: { openai: { model: 'gpt-4o-mini', baseUrl: 'https://example.test/v1' } } }, home);
  const config = await loadConfig({ cwd, home, env: { OPENAI_API_KEY: 'k' } });
  assert.equal(config.profile, 'openai');
  assert.equal(config.model, 'gpt-4o-mini');
  assert.equal(config.apiKey, 'k');
});

test('key variables: a profile named after its provider keeps the provider\'s variable', () => {
  assert.equal(profileKeyEnv('openai', 'openai'), 'OPENAI_API_KEY');
  assert.equal(profileKeyEnv('openrouter', 'openai'), 'NEMESIS_KEY_OPENROUTER');
  assert.equal(profileKeyEnv('lab-1', 'openai'), 'NEMESIS_KEY_LAB_1');
  assert.deepEqual(normalizeProfile('openai', { model: 'x' }), { model: 'x', provider: 'openai' });
});

test('profileSummary marks the active profile and whether its key is set', () => {
  const text = profileSummary({
    claude: { provider: 'anthropic', models: ['a', 'b'], keyEnv: 'K1' },
    lab: { provider: 'openai', baseUrl: 'http://x/v1', model: 'qwen', keyless: true },
  }, 'lab', { K1: 'set' });
  assert.match(text, /claude .*a, b .*\(key set\)/);
  assert.match(text, /\* lab .*no key needed/);
});

// ---------- add / edit / remove ----------

test('profileWizard adds a local keyless profile with a model list and a default', async () => {
  const home = await tempDir('nemesis-wiz-');
  const env = {};
  const answers = ['ollama', '2', 'http://localhost:11434/v1', 'y', 'qwen2.5-coder, llama3', '2'];
  const rl = { async question() { return answers.shift() ?? ''; } };
  const saved = await profileWizard({ rl, ui: quietUI(), home, env, takenNames: [], check: async () => ({ ok: true }) });
  assert.equal(saved.name, 'ollama');
  assert.equal(saved.entry.model, 'llama3');
  assert.deepEqual(saved.entry.models, ['qwen2.5-coder', 'llama3']);
  assert.equal(saved.entry.keyless, true);
  const config = await loadConfig({ cwd: home, home, env: {}, overrides: { profile: 'ollama' } });
  assert.equal(config.baseUrl, 'http://localhost:11434/v1');
  assert.equal(config.apiKey, 'local');
});

test('profileWizard stores a key in its own variable and refuses a taken name', async () => {
  const home = await tempDir('nemesis-wiz2-');
  const env = {};
  const answers = ['openrouter', '2', 'https://openrouter.ai/api/v1', '', 'openai/gpt-4o', 'sk-or-123'];
  const rl = { async question() { return answers.shift() ?? ''; } };
  const saved = await profileWizard({ rl, ui: quietUI(), home, env, takenNames: [], check: async () => ({ ok: true }) });
  assert.equal(env.NEMESIS_KEY_OPENROUTER, 'sk-or-123');
  assert.equal(saved.entry.keyEnv, 'NEMESIS_KEY_OPENROUTER');
  await assert.rejects(
    profileWizard({ rl: { async question() { return 'openrouter'; } }, ui: quietUI(), home, env, takenNames: ['openrouter'] }),
    /already exists/,
  );
});

test('editing keeps the saved key when the key prompt is left blank', async () => {
  const home = await tempDir('nemesis-wiz3-');
  const env = { ANTHROPIC_API_KEY: 'sk-saved' };
  const answers = ['1', '', ''];
  const rl = { async question() { return answers.shift() ?? ''; } };
  const existing = { provider: 'anthropic', models: ['claude-opus-5-5'], model: 'claude-opus-5-5' };
  const saved = await profileWizard({ rl, ui: quietUI(), home, env, name: 'anthropic', existing, check: async () => ({ ok: true }) });
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-saved');
  assert.equal(saved.entry.provider, 'anthropic');
});

test('removeUserProfile drops the entry and clears it as active', async () => {
  const home = await tempDir('nemesis-rm-');
  await saveUserConfig({ activeProfile: 'lab', profiles: { lab: { provider: 'openai', model: 'm' }, other: { provider: 'openai', model: 'n' } } }, home);
  await removeUserProfile(home, 'lab');
  const config = JSON.parse(await readFile(userConfigFile(home), 'utf8'));
  assert.equal(config.profiles.lab, undefined);
  assert.equal(config.activeProfile, null);
  assert.equal(config.profiles.other.model, 'n');
});

// ---------- /model and /profile use ----------

test('/model rows list every profile and model, and mark the current one', () => {
  const rows = profileModelRows(
    { claude: { provider: 'anthropic', models: ['a', 'b'] }, lab: { provider: 'openai', model: 'qwen' } },
    { profile: 'lab', model: 'qwen' },
  );
  assert.deepEqual(rows.map((r) => r.label), [
    'claude · anthropic/a',
    'claude · anthropic/b',
    'lab · openai/qwen  (current)',
  ]);
});

test('switchProfile saves the active profile and reloads the config', async () => {
  const home = await tempDir('nemesis-switch-');
  const cwd = await tempDir('nemesis-switch-cwd-');
  await saveUserConfig({ profiles: { lab: { provider: 'openai', baseUrl: 'http://x/v1', model: 'qwen', keyless: true } } }, home);
  const state = { home, cwd, overrides: { provider: 'anthropic', maxSteps: 7 }, config: {} };
  state.reload = async () => { state.config = await loadConfig({ cwd, home, env: {}, overrides: state.overrides }); };
  await state.reload();
  await switchProfile(state, 'lab', 'qwen-coder');
  assert.equal(state.config.profile, 'lab');
  assert.equal(state.config.model, 'qwen-coder');
  assert.deepEqual(state.overrides, { maxSteps: 7 });
  await assert.rejects(switchProfile(state, 'nope'), /no profile "nope"/);
});

// ---------- background shells ----------

const nodeCmd = (code) => `node -e "${code}"`;

test('background shell: output is read incrementally and the exit code is reported', async () => {
  const jobs = new JobRegistry();
  const job = jobs.start(nodeCmd("console.log('hello job')"), { cwd: process.cwd() });
  const [output] = createJobTools(jobs);
  const text = await output.run({ id: job.id, wait_ms: 15000 });
  assert.match(text, /exited \(exit 0\)/);
  assert.match(text, /hello job/);
  assert.match(await output.run({ id: job.id }), /\(no new output\)/);
  assert.match(jobSummary(jobs), /exited/);
});

test('background shell: kill_shell stops a running job', async () => {
  const jobs = new JobRegistry();
  const job = jobs.start(nodeCmd('setInterval(()=>{},1000)'), { cwd: process.cwd() });
  const [, kill] = createJobTools(jobs);
  assert.equal(jobs.get(job.id).status, 'running');
  await kill.run({ id: job.id });
  assert.equal(jobs.get(job.id).status, 'killed');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(jobs.get(job.id).status, 'killed', 'exit after kill keeps the killed status');
});

test('bash with run_in_background returns a shell id at once', async () => {
  const jobs = new JobRegistry();
  const out = await bashTool.run(
    { command: nodeCmd('setTimeout(()=>{},200)'), run_in_background: true },
    { cwd: process.cwd(), jobs, config: {} },
  );
  assert.match(out, /started background shell shell-1/);
  jobs.killAll();
});

test('background shell is refused under strict sandbox for network commands', async () => {
  await assert.rejects(
    bashTool.run({ command: 'curl https://example.com', run_in_background: true }, { cwd: process.cwd(), jobs: new JobRegistry(), config: { sandbox: 'strict' } }),
    /blocked by sandbox/,
  );
});

test('a profile named on the command line must exist', async () => {
  const home = await tempDir('nemesis-prof4-');
  await assert.rejects(loadConfig({ cwd: home, home, env: {}, overrides: { profile: 'ghost' } }), /no profile "ghost"/);
});
