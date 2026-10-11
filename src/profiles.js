import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PROVIDERS, nemesisHome, userConfigFile } from './config.js';
import { setEnvKeys } from './env.js';
import { askSecret, checkKey } from './onboarding.js';

// A profile: { provider, baseUrl?, models?: [...], model, keyEnv?, keyless?, contextWindow?, effort?, reasoning? }.
// Stored under "profiles" in ~/.nemesis/config.json. Keys live in ~/.nemesis/.env under keyEnv.
export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

// The variable a profile's key is stored in. A profile named after its provider uses the provider's variable,
// so existing keys keep working; any other profile gets NEMESIS_KEY_<NAME>.
export function profileKeyEnv(name, provider) {
  if (name === provider) return PROVIDERS[provider].keyEnv;
  return `NEMESIS_KEY_${name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

// Entries written before profiles existed are keyed by provider and have no provider field.
export function normalizeProfile(name, raw = {}) {
  return !raw.provider && PROVIDERS[name] ? { ...raw, provider: name } : raw;
}

// /profile list: one line per profile, marking the active one and whether its key is set.
export function profileSummary(profiles = {}, active = null, env = process.env) {
  const names = Object.keys(profiles);
  if (!names.length) return 'no profiles yet. Add one with /profile add';
  return names.map((name) => {
    const entry = normalizeProfile(name, profiles[name]);
    const keyEnv = entry.keyEnv ?? PROVIDERS[entry.provider]?.keyEnv;
    const key = entry.keyless ? 'no key needed' : env[keyEnv] ? 'key set' : 'NO KEY';
    const models = entry.models?.length ? entry.models.join(', ') : entry.model;
    return `${name === active ? '*' : ' '} ${name.padEnd(14)} ${entry.provider}  ${entry.baseUrl ? `${entry.baseUrl}  ` : ''}${models}  (${key})`;
  }).join('\n');
}

async function readUserConfig(home) {
  try {
    return JSON.parse(await readFile(userConfigFile(home), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

// Replaces one profile wholesale (saveUserConfig merges, which cannot drop a field such as keyless).
export async function replaceUserProfile(home, name, entry) {
  const config = await readUserConfig(home);
  config.profiles = { ...config.profiles, [name]: entry };
  await mkdir(nemesisHome(home), { recursive: true });
  await writeFile(userConfigFile(home), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

// Removes a profile from the config. Its key stays in .env, so re-adding it needs no new key.
export async function removeUserProfile(home, name) {
  const config = await readUserConfig(home);
  if (!config.profiles?.[name]) throw new Error(`no profile "${name}" in the user config`);
  delete config.profiles[name];
  if (config.activeProfile === name) config.activeProfile = null;
  await writeFile(userConfigFile(home), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

// Interactive add or edit. With `existing`, each question offers the current value as its default.
// Returns { name, entry }. Keys are only written when a new one is typed.
export async function profileWizard({ rl, ui, home, env = process.env, name = null, existing = null, takenNames = [], check = checkKey }) {
  const current = existing ? normalizeProfile(name, existing) : null;

  let profileName = name;
  if (!profileName) {
    profileName = (await rl.question('Profile name (e.g. claude, ollama, lab-server): ')).trim().toLowerCase().replace(/\s+/g, '-');
    if (!PROFILE_NAME.test(profileName)) throw new Error('profile names use a-z, 0-9 and dashes, and start with a letter or digit');
    if (takenNames.includes(profileName)) throw new Error(`profile "${profileName}" already exists; use /profile edit ${profileName}`);
  }

  const defaultProvider = current?.provider ?? 'anthropic';
  const providerAnswer = (await rl.question(`Provider: 1) Anthropic (Claude)  2) OpenAI-compatible [${defaultProvider === 'openai' ? 2 : 1}]: `)).trim();
  let provider;
  if (providerAnswer === '') provider = defaultProvider;
  else if (providerAnswer === '1') provider = 'anthropic';
  else if (providerAnswer === '2') provider = 'openai';
  else throw new Error('invalid choice; profile not saved');
  const meta = PROVIDERS[provider];

  let baseUrl = null;
  let keyless = false;
  if (provider === 'openai') {
    const fallback = current?.baseUrl ?? meta.defaultBaseUrl;
    baseUrl = (await rl.question(`Base URL [${fallback}]: `)).trim() || fallback;
    const answer = (await rl.question(`Local server with no key? [${current?.keyless ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
    keyless = answer === '' ? Boolean(current?.keyless) : answer.startsWith('y');
  }

  const modelDefault = current?.models?.length ? current.models.join(', ') : (current?.model ?? meta.defaultModel);
  const modelsAnswer = (await rl.question(`Models, comma-separated [${modelDefault}]: `)).trim();
  const models = modelsAnswer
    ? [...new Set(modelsAnswer.split(',').map((m) => m.trim()).filter(Boolean))]
    : (current?.models?.length ? current.models : [current?.model ?? meta.defaultModel]);
  let model = models[0];
  if (models.length > 1) {
    const pick = (await rl.question(`Default model [${current?.model && models.includes(current.model) ? current.model : models[0]}]: `)).trim();
    if (pick) {
      // A number picks from the list above, as well as a name.
      const byIndex = /^\d+$/.test(pick) ? models[Number(pick) - 1] : undefined;
      if (!models.includes(pick) && !byIndex) throw new Error(`"${pick}" is not in the model list`);
      model = byIndex ?? pick;
    } else if (current?.model && models.includes(current.model)) {
      model = current.model;
    }
  }

  const keyEnv = profileKeyEnv(profileName, provider);
  let key = null;
  if (!keyless) {
    const hasKey = Boolean(env[keyEnv]);
    key = (await askSecret(rl, hasKey ? 'Key (blank keeps the saved key): ' : 'Key: ')).trim();
    if (!key && !hasKey) throw new Error('no key entered; profile not saved');
  }

  if (key) {
    const result = await check({ provider, baseUrl, key, model });
    if (result.ok) ui.info('key and model accepted');
    else ui.warn(`could not confirm the key and model: ${result.error}. Saved anyway.`);
    await setEnvKeys({ [keyEnv]: key }, { home, env });
  }

  const entry = {
    provider,
    model,
    models,
    ...(baseUrl ? { baseUrl } : {}),
    ...(keyless ? { keyless: true } : keyEnv !== meta.keyEnv ? { keyEnv } : {}),
    ...(current?.contextWindow ? { contextWindow: current.contextWindow } : {}),
    ...(current?.effort ? { effort: current.effort } : {}),
    ...(current?.reasoning ? { reasoning: current.reasoning } : {}),
  };
  await replaceUserProfile(home, profileName, entry);
  return { name: profileName, entry };
}

// /setup-style loop: add, edit, or leave. profiles is the current map; returns the names that changed.
export async function manageProfiles({ rl, ui, home, env = process.env, profiles = {} }) {
  const changed = [];
  for (;;) {
    const names = Object.keys(profiles);
    const options = ['Add a profile', ...names.map((n) => `Edit ${n}`), 'Done'];
    const pick = await rl.choose({ title: 'Profiles', options });
    if (pick < 0 || pick === options.length - 1) return changed;
    const result = pick === 0
      ? await profileWizard({ rl, ui, home, env, takenNames: names })
      : await profileWizard({ rl, ui, home, env, name: names[pick - 1], existing: profiles[names[pick - 1]] });
    profiles[result.name] = result.entry;
    changed.push(result.name);
    ui.info(`saved profile ${result.name}`);
  }
}

// Used by /profile add and /profile edit: runs the wizard and asks whether to switch to the result.
export async function manageProfile({ rl, ui, home, env, name = null, existing = null, takenNames = [] }) {
  return profileWizard({ rl, ui, home, env, name, existing, takenNames });
}
