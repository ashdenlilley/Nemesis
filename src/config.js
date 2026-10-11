import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// Provider metadata. profiles.<provider> in user config stores per-provider model and baseUrl.
export const PROVIDERS = Object.freeze({
  anthropic: {
    label: 'Anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-5-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    contextWindow: 200_000,
  },
  openai: {
    label: 'OpenAI-compatible',
    keyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o',
    defaultBaseUrl: 'https://api.openai.com/v1',
    contextWindow: 128_000,
  },
});

export const OUTPUT_STYLES = ['default', 'concise', 'explanatory'];
// effort: Anthropic output_config.effort / OpenAI reasoning_effort. null leaves the model's default.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// reasoning (Anthropic thinking): null omits the parameter, so the model's default applies.
//   adaptive: thinking on, text hidden. summarized: thinking on, summary shown in the feed.
//   disabled: thinking off (rejected with a 400 by models where thinking is always on).
export const REASONING_MODES = ['adaptive', 'summarized', 'disabled'];

export const DEFAULTS = Object.freeze({
  provider: 'anthropic',
  maxTokens: 8192,
  maxSteps: null, // tool rounds per turn; null = no limit (Esc or Ctrl+C stops a turn)
  activeProfile: null, // name of the profile in use; null means the provider's own profile
  stream: true,
  idleTimeoutSec: 120, // a model request with no data for this long is dropped and retried
  effort: null,
  reasoning: null,
  promptCaching: true, // Anthropic: cache the prompt prefix (cache reads cost about a tenth)
  sandbox: 'off', // 'off' | 'strict', see src/sandbox.js
  allowRules: [], // e.g. ["bash(npm test:*)", "web_fetch"]
  denyRules: [], // e.g. ["bash(rm:*)"]
  askRules: [], // always prompt for these, even under a broader allow
  statusLine: null, // shell command; its first output line replaces the default status line
  autoCompact: true,
  compactThreshold: 0.8,
  outputStyle: 'default',
  // Policy per tool risk class: 'allow' | 'ask' | 'deny'
  permissions: { read: 'allow', write: 'ask', exec: 'ask' },
  mcpServers: {},
  hooks: {},
  profiles: {},
});

export const READ_ONLY_POLICY = Object.freeze({ read: 'allow', write: 'deny', exec: 'deny' });

export function nemesisHome(home = homedir()) {
  return path.join(home, '.nemesis');
}

export function userConfigFile(home = homedir()) {
  return path.join(nemesisHome(home), 'config.json');
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`invalid config ${file}: ${err.message}`);
  }
}

const union = (a = [], b = []) => [...new Set([...a, ...b])];

function mergeLayer(base, layer = {}) {
  return {
    ...base,
    ...layer,
    // Rule lists add up across layers: a project rule does not replace a user rule.
    allowRules: union(base.allowRules, layer.allowRules),
    denyRules: union(base.denyRules, layer.denyRules),
    askRules: union(base.askRules, layer.askRules),
    permissions: { ...base.permissions, ...layer.permissions },
    mcpServers: { ...base.mcpServers, ...layer.mcpServers },
    hooks: { ...base.hooks, ...layer.hooks },
    profiles: { ...base.profiles, ...layer.profiles },
  };
}

const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');

// Precedence, lowest to highest:
//   defaults < user config < project config < local config < env < CLI flags.
// model and baseUrl resolve per provider: a project or local value only applies when its
// `provider` matches the active one, so switching provider never leaks another model name.
export async function loadConfig({ cwd, home = homedir(), env = process.env, overrides = {} } = {}) {
  const user = await readJson(userConfigFile(home));
  const project = await readJson(path.join(cwd, '.nemesis', 'config.json'));
  const local = await readJson(path.join(cwd, '.nemesis', 'config.local.json'));

  const fromEnv = {};
  if (env.NEMESIS_PROVIDER) fromEnv.provider = env.NEMESIS_PROVIDER;
  if (env.NEMESIS_MODEL) fromEnv.model = env.NEMESIS_MODEL;
  if (env.NEMESIS_BASE_URL) fromEnv.baseUrl = env.NEMESIS_BASE_URL;
  if (env.NEMESIS_PROFILE) fromEnv.profile = env.NEMESIS_PROFILE;

  const merged = [user, project, local, fromEnv, overrides].reduce(mergeLayer, structuredClone(DEFAULTS));

  // A profile is a named set of provider settings (provider, baseUrl, models, keyEnv, keyless, ...).
  // Choosing a provider on the command line without a profile picks that provider's profile.
  const explicitProvider = overrides.provider ?? fromEnv.provider;
  const chosen = overrides.profile ?? fromEnv.profile
    ?? (explicitProvider ? null : pick(local.activeProfile, project.activeProfile, user.activeProfile));
  const name = chosen ?? explicitProvider ?? merged.provider;
  // A profile named on the command line or in NEMESIS_PROFILE must exist. A stale activeProfile falls back instead.
  const named = overrides.profile ?? fromEnv.profile;
  if (named && !merged.profiles[named] && !PROVIDERS[named]) {
    throw new Error(`no profile "${named}". Add it with /profile add, or see /profile`);
  }
  // Entries written before profiles existed are keyed by provider name and have no provider field.
  const raw = merged.profiles[name] ?? {};
  const entry = !raw.provider && PROVIDERS[name] ? { ...raw, provider: name } : raw;

  const provider = pick(overrides.provider, fromEnv.provider, entry.provider, merged.provider);
  const meta = PROVIDERS[provider];
  if (!meta) {
    throw new Error(`unknown provider "${provider}" (expected: ${Object.keys(PROVIDERS).join(', ')})`);
  }
  // Profile values apply only when the profile's provider is the provider in use.
  const profile = entry.provider === provider ? entry : {};
  const scoped = (layer, key) => (!layer.provider || layer.provider === provider ? layer[key] : undefined);

  merged.profile = name;
  merged.provider = provider;
  merged.models = profile.models ?? [];
  merged.model = pick(
    overrides.model, fromEnv.model,
    scoped(local, 'model'), scoped(project, 'model'),
    profile.model, meta.defaultModel,
  );
  merged.baseUrl = pick(
    overrides.baseUrl, fromEnv.baseUrl,
    scoped(local, 'baseUrl'), scoped(project, 'baseUrl'),
    profile.baseUrl, meta.defaultBaseUrl,
  );
  // Model-dependent settings saved by /context-window, /effort and /reasoning live in the profile.
  merged.contextWindow = pick(overrides.contextWindow, profile.contextWindow, merged.contextWindow, meta.contextWindow);
  merged.effort = pick(overrides.effort, profile.effort, merged.effort) ?? null;
  merged.reasoning = pick(overrides.reasoning, profile.reasoning, merged.reasoning) ?? null;
  merged.keyEnv = profile.keyEnv ?? meta.keyEnv;
  // Local servers that need no key get a placeholder, since the API client insists on one.
  merged.apiKey = profile.keyless ? 'local' : (pick(env[merged.keyEnv], env.NEMESIS_API_KEY) ?? null);
  return merged;
}

// Adds rules to the project's local config (.nemesis/config.local.json, git-ignored), keeping existing ones.
export async function addLocalRules(cwd, { allowRules = [], denyRules = [], askRules = [] }) {
  const file = path.join(cwd, '.nemesis', 'config.local.json');
  const current = await readJson(file);
  const next = {
    ...current,
    allowRules: union(current.allowRules, allowRules),
    denyRules: union(current.denyRules, denyRules),
    askRules: union(current.askRules, askRules),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}
`, 'utf8');
  return next;
}

// Merge a patch into the user config file (~/.nemesis/config.json). Profiles merge per provider.
export async function saveUserConfig(patch, home = homedir()) {
  const file = userConfigFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  const current = await readJson(file);
  const next = { ...current, ...patch, profiles: { ...current.profiles } };
  for (const [name, values] of Object.entries(patch.profiles ?? {})) {
    next.profiles[name] = { ...current.profiles?.[name], ...values };
  }
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
