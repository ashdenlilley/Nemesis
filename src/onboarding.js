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

// Read a secret without echoing it. The label is passed to readline itself, so it stays visible.
// readline writes the prompt once, then redraws the line on every keystroke; only the first write is kept.
export function askSecret(rl, question, out = process.stdout) {
  const realOutput = rl.output;
  if (!realOutput) return rl.question(question);
  let promptWritten = false;
  // readline writes to rl.output directly. Let writes through until the label has been drawn,
  // then drop everything else (typed characters and redraws) so the secret is never echoed.
  rl.output = new Proxy(realOutput, {
    get(target, prop) {
      if (prop === 'write') {
        return (chunk, ...rest) => {
          if (promptWritten) return true;
          if (String(chunk).includes(question)) promptWritten = true;
          return target.write(chunk, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return rl.question(question).finally(() => {
    rl.output = realOutput;
    out.write('\n');
  });
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
  const key = (await askSecret(rl, 'Key: ', out)).trim();
  if (!key) throw new Error('no key entered; setup cancelled');

  await setEnvKeys({ [meta.keyEnv]: key }, { home, env });
  const profile = provider === 'openai' ? { model, baseUrl } : { model };
  await saveUserConfig({ provider, profiles: { [provider]: profile } }, home);

  ui.info(`saved key to ${envFilePath(home)}`);
  ui.info(`default provider: ${provider} (${model})`);
  return { provider, model, baseUrl };
}
