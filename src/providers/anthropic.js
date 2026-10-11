import { openStream, postJson, ProviderError } from './http.js';
import { readSSE } from './sse.js';

const API_VERSION = '2023-06-01';

function parseToolJson(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

// Fold Anthropic SSE events into the same response shape as a non-streaming call.
// A stream that closes before message_stop was cut off, so it is reported as a retryable failure.
export async function readAnthropicStream(response, onText, sseOpts = {}) {
  const blocks = [];
  let stopReason = 'end_turn';
  let usage = {};
  let stopped = false;
  for await (const { data } of readSSE(response, sseOpts)) {
    const ev = JSON.parse(data);
    switch (ev.type) {
      case 'message_start':
        usage = { ...usage, ...ev.message?.usage };
        break;
      case 'content_block_start': {
        const cb = ev.content_block ?? {};
        if (cb.type === 'text') blocks[ev.index] = { type: 'text', text: cb.text ?? '' };
        else if (cb.type === 'tool_use') {
          blocks[ev.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {}, _json: '' };
        }
        break;
      }
      case 'content_block_delta': {
        const b = blocks[ev.index];
        const d = ev.delta ?? {};
        if (b?.type === 'text' && d.type === 'text_delta') {
          b.text += d.text;
          onText?.(d.text);
        } else if (b?.type === 'tool_use' && d.type === 'input_json_delta') {
          b._json += d.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const b = blocks[ev.index];
        if (b?.type === 'tool_use') {
          b.input = parseToolJson(b._json);
          delete b._json;
        }
        break;
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        usage = { ...usage, ...ev.usage };
        break;
      case 'message_stop':
        stopped = true;
        break;
      case 'error': {
        const type = ev.error?.type ?? '';
        const retryable = /overloaded|api_error|rate_limit|timeout/.test(type);
        throw new ProviderError(`stream error: ${ev.error?.message ?? type ?? 'unknown'}`, undefined, { retryable });
      }
      default:
        break;
    }
  }
  if (!stopped) throw new ProviderError('connection closed before the response finished', undefined, { retryable: true });
  return { content: blocks.filter(Boolean), stopReason, usage };
}

// Provider contract shared by all adapters:
//   createMessage({ system, messages, tools, signal, onText, model, maxTokens })
//     -> { content, stopReason, usage }
// Messages use the internal block format (text / tool_use / tool_result).
export function createAnthropicProvider(config) {
  const baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');

  return {
    name: 'anthropic',
    async createMessage({ system, messages, tools, signal, onText, model, maxTokens, onActivity, onRetry }) {
      if (!config.apiKey) throw new Error('not logged in: run /login or set ANTHROPIC_API_KEY');
      const body = {
        model: model ?? config.model,
        max_tokens: maxTokens ?? config.maxTokens,
        system,
        messages,
      };
      if (tools.length) {
        body.tools = tools.map(({ name, description, parameters }) => ({
          name,
          description,
          input_schema: parameters,
        }));
      }
      const headers = { 'x-api-key': config.apiKey, 'anthropic-version': API_VERSION };
      const url = `${baseUrl}/v1/messages`;
      const idleMs = (config.idleTimeoutSec ?? 120) * 1000;

      if (config.stream === false) {
        // Without streaming no bytes arrive until the whole reply is ready, so allow longer.
        const data = await postJson(url, body, headers, { signal, onRetry, idleMs: idleMs * 5 });
        return { content: data.content ?? [], stopReason: data.stop_reason ?? 'end_turn', usage: data.usage };
      }
      const res = await openStream(url, body, headers, { signal, onRetry, idleMs });
      onActivity?.();
      return readAnthropicStream(res, onText, { idleMs, onActivity, signal });
    },
  };
}
