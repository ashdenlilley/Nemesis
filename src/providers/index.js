import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';

const FACTORIES = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider,
};

export function createProvider(config) {
  const factory = FACTORIES[config.provider];
  if (!factory) {
    throw new Error(`unknown provider "${config.provider}" (expected: ${Object.keys(FACTORIES).join(', ')})`);
  }
  return factory(config);
}
