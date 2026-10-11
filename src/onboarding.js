import { PROVIDERS, saveUserConfig } from './config.js';
import { envFilePath, setEnvKeys } from './env.js';
import { createProvider } from './providers/index.js';
import { readClaudePermissions } from './claude-import.js';

export const TUTORIAL = `Welcome to Nemesis, a terminal coding agent.

No API key is set for the active provider. Setup takes about 30 seconds:
  1. Pick a provider: Anthropic (Claude), or any OpenAI-compatible endpoint
     (OpenAI, OpenRouter, Ollama, LM Studio, vLLM, ...).
  2. Enter the base URL (OpenAI-compatible only), model, and API key.
     The key is checked with one small request, then written to ~/.nemesis/.env.
  3. Choose how much Nemesis may do without asking.
  4. Provider and model are remembered. Override any time with
     --provider, --model, or /model.

Later: /login switches provider or key, /logout removes the key, /help lists commands.`;

// Permission presets. Each is a policy over the three risk classes (read, write, exec).
export const PERMISSION_PRESETS = [
  { label: 'Balanced: reads allowed; file edits and commands ask (recommended)', policy: { read: 'allow', write: 'ask', exec: 'ask' } },
  { label: 'Auto-edit: reads and file edits allowed; commands ask', policy: { read: 'allow', write: 'allow', exec: 'ask' } },
  { label: 'Read-only: nothing is written and no commands run', policy: { read: 'allow', write: 'deny', exec: 'deny' } },
];

// Read a secret without echoing it. The label stays visible; typed characters are not drawn.
export function askSecret(rl, question) {
  return rl.question(question, { secret: true });
}

// One small request with the key and model. Resolves { ok: true } or { ok: false, error }.
export async function checkKey({ provider, baseUrl, key, model }) {
  try {
    const client = createProvider({ provider, apiKey: key, baseUrl, model, maxTokens: 8, stream: false });
    await client.createMessage({
      system: 'Reply with OK.',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [],
      signal: AbortSignal.timeout(20_000),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Interactive setup. Throws if the user cancels or enters nothing.
// preferredProvider skips the menu when --provider was passed.
// Menus (permissions, Claude Code import) need a terminal with choose(); without one they are skipped.
export async function runOnboarding({ rl, ui, home, env = process.env, preferredProvider = null, out = process.stdout, check = checkKey }) {
  out.write(`${TUTORIAL}\n\n`);

  let provider = preferredProvider;
  if (!provider) {
    out.write('Provider:\n  1) Anthropic (Claude)\n  2) OpenAI-compatible\n');
    const choice = (await rl.question('Choose [1/2] (default 1): ')).trim();
    if (choice === '' || choice === '1') provider = 'anthropic';
    else if (choice === '2') provider = 'openai';
    else throw new Error('invalid choice; setup cancelled');
  }
  const meta = PROVIDERS[provider];
  if (!meta) throw new Error(`unknown provider "${provider}"`);

  let baseUrl = meta.defaultBaseUrl;
  if (provider === 'openai') {
    const entered = (await rl.question(`Base URL [${meta.defaultBaseUrl}]: `)).trim();
    baseUrl = entered || meta.defaultBaseUrl;
  }
  const model = (await rl.question(`Model [${meta.defaultModel}]: `)).trim() || meta.defaultModel;
  const key = (await askSecret(rl, 'Key: ')).trim();
  if (!key) throw new Error('no key entered; setup cancelled');

  // A failed check does not block saving: the network may be down, or the key is for another model.
  const result = await check({ provider, baseUrl, key, model });
  if (result.ok) ui.info('key and model accepted');
  else ui.warn(`could not confirm the key and model: ${result.error}. Saved anyway; change them later with /login or /model.`);

  await setEnvKeys({ [meta.keyEnv]: key }, { home, env });
  const profile = provider === 'openai' ? { model, baseUrl } : { model };
  await saveUserConfig({ provider, activeProfile: provider, profiles: { [provider]: profile } }, home);

  if (rl.choose) {
    const picked = await rl.choose({ title: 'How much may Nemesis do without asking?', options: PERMISSION_PRESETS.map((p) => p.label) });
    if (picked >= 0) await saveUserConfig({ permissions: PERMISSION_PRESETS[picked].policy }, home);

    const imported = await readClaudePermissions(home);
    if (imported && imported.allow.length + imported.deny.length + imported.ask.length > 0) {
      const count = imported.allow.length + imported.deny.length + imported.ask.length;
      const answer = await rl.choose({
        title: `Import ${count} permission rules from ~/.claude/settings.json?${imported.skipped ? ` (${imported.skipped} with no Nemesis equivalent are skipped)` : ''}`,
        options: ['Yes', 'No'],
      });
      if (answer === 0) {
        await saveUserConfig({ allowRules: imported.allow, denyRules: imported.deny, askRules: imported.ask }, home);
        ui.info(`imported ${count} rules`);
      }
    }
  }

  ui.info(`saved key to ${envFilePath(home)}`);
  ui.info(`default provider: ${provider} (${model})`);
  return { provider, model, baseUrl };
}
