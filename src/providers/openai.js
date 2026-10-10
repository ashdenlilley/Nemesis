import { openStream, postJson } from './http.js';
import { readSSE } from './sse.js';

const STOP_REASONS = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens' };

// Internal block messages -> OpenAI chat-completions messages.
export function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === 'assistant') {
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = msg.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const entry = { role: 'assistant', content: text || null };
      if (toolCalls.length) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }
    // user: tool results must come first, directly after the assistant tool_calls turn.
    for (const b of msg.content.filter((b) => b.type === 'tool_result')) {
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
    }
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

function parseArgs(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    // Malformed arguments become a validation error the model can see and fix.
    return { _raw: raw };
  }
}

// OpenAI chat-completions response -> internal block format.
export function fromOpenAIResponse(data) {
  const choice = data.choices?.[0];
  if (!choice) throw new Error('OpenAI response has no choices');
  const msg = choice.message ?? {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const call of msg.tool_calls ?? []) {
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) });
  }
  return {
    content,
    stopReason: STOP_REASONS[choice.finish_reason] ?? 'end_turn',
    usage: data.usage,
  };
}

// Fold chat-completion SSE chunks, including tool-call argument fragments, into one response.
export async function readOpenAIStream(response, onText) {
  let text = '';
  const calls = [];
  let finish = null;
  let usage;
  for await (const { data } of readSSE(response)) {
    if (data === '[DONE]') break;
    const chunk = JSON.parse(data);
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (delta.content) {
      text += delta.content;
      onText?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const call = (calls[tc.index] ??= { id: '', name: '', args: '' });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name += tc.function.name;
      if (tc.function?.arguments) call.args += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const message = {
    content: text || null,
    tool_calls: calls.filter(Boolean).map((c) => ({ id: c.id, function: { name: c.name, arguments: c.args } })),
  };
  return fromOpenAIResponse({ choices: [{ finish_reason: finish, message }], usage });
}

export function createOpenAIProvider(config) {
  const baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');

  return {
    name: 'openai',
    async createMessage({ system, messages, tools, signal, onText, model, maxTokens }) {
      if (!config.apiKey) throw new Error('not logged in: run /login or set OPENAI_API_KEY');
      const body = {
        model: model ?? config.model,
        max_tokens: maxTokens ?? config.maxTokens,
        messages: toOpenAIMessages(system, messages),
      };
      if (tools.length) {
        body.tools = tools.map(({ name, description, parameters }) => ({
          type: 'function',
          function: { name, description, parameters },
        }));
      }
      const headers = { authorization: `Bearer ${config.apiKey}` };
      const url = `${baseUrl}/chat/completions`;

      if (config.stream === false) {
        return fromOpenAIResponse(await postJson(url, body, headers, { signal }));
      }
      const res = await openStream(url, body, headers, { signal });
      return readOpenAIStream(res, onText);
    },
  };
}
