import { PROVIDERS, saveUserConfig } from './config.js';
import { envFilePath, setEnvKeys } from './env.js';

export const TUTORIAL = `Welcome to Nemesis, a terminal coding agent.

No API key is set for the active provider. Setup takes about 30 seconds:
  1. Pick a provider: Anthropic (Claude), or any OpenAI-compatible endpoint
     (OpenAI, OpenRouter, Ollama, LM Studio, vLLM, ...).
  2. Enter the base URL (OpenAI-compatible only), model, and API key.
     The key is written to ~/.nemesis/.env and loaded automatically next run.
  3. Provider and model are remembered. Override any time with
     --provider, --model, or /model.

Later: /login switches provider or key, /logout removes the key, /help lists commands.`;

// Read a secret without echoing it. The label stays visible; typed characters are not drawn.
export function askSecret(rl, question) {
  return rl.question(question, { secret: true });
}

// Interactive setup. Throws if the user cancels or enters nothing.
// preferredProvider skips the menu when --provider was passed.
export async function runOnboarding({ rl, ui, home, env = process.env, preferredProvider = null, out = process.stdout }) {
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

  await setEnvKeys({ [meta.keyEnv]: key }, { home, env });
  const profile = provider === 'openai' ? { model, baseUrl } : { model };
  await saveUserConfig({ provider, profiles: { [provider]: profile } }, home);

  ui.info(`saved key to ${envFilePath(home)}`);
  ui.info(`default provider: ${provider} (${model})`);
  return { provider, model, baseUrl };
}
