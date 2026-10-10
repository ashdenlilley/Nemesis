import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromOpenAIResponse, readOpenAIStream, toOpenAIMessages } from '../src/providers/openai.js';
import { readAnthropicStream } from '../src/providers/anthropic.js';
import { createProvider } from '../src/providers/index.js';
import { parseEvent } from '../src/providers/sse.js';

const sseBody = (chunks) => new Response(chunks.map((c) => c).join(''));
const anthropicEvent = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const openaiChunk = (data) => `data: ${JSON.stringify(data)}\n\n`;

test('toOpenAIMessages: tool results become role=tool messages after the assistant tool_calls turn', () => {
  const messages = [
    { role: 'user', content: 'list files' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'c1', name: 'glob', input: { pattern: '*.js' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'a.js', is_error: false }],
    },
  ];
  const out = toOpenAIMessages('SYS', messages);
  assert.deepEqual(out[0], { role: 'system', content: 'SYS' });
  assert.deepEqual(out[2], {
    role: 'assistant',
    content: 'checking',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*.js"}' } }],
  });
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'c1', content: 'a.js' });
  assert.equal(out.length, 4);
});

test('fromOpenAIResponse: tool_calls become tool_use blocks; malformed args surface as _raw', () => {
  const res = fromOpenAIResponse({
    choices: [{
      finish_reason: 'tool_calls',
      message: { tool_calls: [{ id: 'q1', function: { name: 'grep', arguments: '{"pattern":"x"}' } }] },
    }],
  });
  assert.equal(res.stopReason, 'tool_use');
  assert.deepEqual(res.content, [{ type: 'tool_use', id: 'q1', name: 'grep', input: { pattern: 'x' } }]);

  const bad = fromOpenAIResponse({
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'q2', function: { name: 'bash', arguments: '{oops' } }] } }],
  });
  assert.equal(bad.content[0].input._raw, '{oops');
});

test('createProvider rejects unknown providers and returns named adapters', () => {
  assert.throws(() => createProvider({ provider: 'nope' }), /unknown provider/);
  assert.equal(createProvider({ provider: 'openai', apiKey: 'k', model: 'm', maxTokens: 1 }).name, 'openai');
  assert.equal(createProvider({ provider: 'anthropic', apiKey: null }).name, 'anthropic');
});

test('SSE parser reads event and multi-line data', () => {
  assert.deepEqual(parseEvent('event: ping\ndata: a\ndata: b'), { event: 'ping', data: 'a\nb' });
  assert.equal(parseEvent(': comment only'), null);
});

test('Anthropic stream: text deltas fire onText and tool JSON is assembled', async () => {
  const body = sseBody([
    anthropicEvent({ type: 'message_start', message: { usage: { input_tokens: 5 } } }),
    anthropicEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    anthropicEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
    anthropicEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
    anthropicEvent({ type: 'content_block_stop', index: 0 }),
    anthropicEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'glob', input: {} } }),
    anthropicEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pat' } }),
    anthropicEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'tern":"*.js"}' } }),
    anthropicEvent({ type: 'content_block_stop', index: 1 }),
    anthropicEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }),
    anthropicEvent({ type: 'message_stop' }),
  ]);
  const seen = [];
  const res = await readAnthropicStream(body, (d) => seen.push(d));
  assert.deepEqual(seen, ['Hel', 'lo']);
  assert.deepEqual(res.content, [
    { type: 'text', text: 'Hello' },
    { type: 'tool_use', id: 't1', name: 'glob', input: { pattern: '*.js' } },
  ]);
  assert.equal(res.stopReason, 'tool_use');
  assert.deepEqual(res.usage, { input_tokens: 5, output_tokens: 7 });
});

test('Anthropic stream: error event throws', async () => {
  const body = sseBody([anthropicEvent({ type: 'error', error: { message: 'overloaded' } })]);
  await assert.rejects(readAnthropicStream(body), /overloaded/);
});

test('OpenAI stream: content and tool-call argument fragments are joined', async () => {
  const body = sseBody([
    openaiChunk({ choices: [{ delta: { content: 'Hi' } }] }),
    openaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'grep', arguments: '{"pat' } }] } }] }),
    openaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] }, finish_reason: 'tool_calls' }] }),
    openaiChunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    'data: [DONE]\n\n',
  ]);
  const seen = [];
  const res = await readOpenAIStream(body, (d) => seen.push(d));
  assert.deepEqual(seen, ['Hi']);
  assert.equal(res.stopReason, 'tool_use');
  assert.deepEqual(res.content, [
    { type: 'text', text: 'Hi' },
    { type: 'tool_use', id: 'c1', name: 'grep', input: { pattern: 'x' } },
  ]);
});
