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


test('Anthropic stream that closes before message_stop is a retryable failure, not a silent partial reply', async () => {
  const body = sseBody([
    anthropicEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    anthropicEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hal' } }),
  ]);
  await assert.rejects(readAnthropicStream(body), (err) => err.retryable === true && /closed before/.test(err.message));
});

test('Anthropic overloaded error event is retryable', async () => {
  const body = sseBody([anthropicEvent({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })]);
  await assert.rejects(readAnthropicStream(body), (err) => err.retryable === true);
});

test('OpenAI stream with no finish_reason and no [DONE] is a retryable failure', async () => {
  const body = sseBody([openaiChunk({ choices: [{ delta: { content: 'Hi' } }] })]);
  await assert.rejects(readOpenAIStream(body), (err) => err.retryable === true);
});

test('a stream that goes silent is cut off after idleMs with a stall error', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(anthropicEvent({ type: 'message_start', message: {} })));
      // then nothing: the connection hangs
    },
  });
  const started = Date.now();
  await assert.rejects(
    readAnthropicStream(new Response(stream), null, { idleMs: 50 }),
    (err) => err.retryable === true && /stalled/.test(err.message),
  );
  assert.ok(Date.now() - started < 2000);
});

test('network errors before a response are retried, then succeed', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { status: 200 });
  };
  try {
    const retries = [];
    const provider = createProvider({ provider: 'anthropic', apiKey: 'k', model: 'm', maxTokens: 10, stream: false });
    const res = await provider.createMessage({ system: 's', messages: [], tools: [], onRetry: (r) => retries.push(r) });
    assert.equal(calls, 2);
    assert.equal(res.content[0].text, 'ok');
    assert.match(retries[0].error.message, /ECONNRESET/);
  } finally {
    globalThis.fetch = realFetch;
  }
});


// Captures request bodies sent through fetch; replies with `reply(body)`.
async function withFetch(reply, fn) {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return reply(body);
  };
  try {
    await fn(bodies);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('Anthropic: effort and reasoning settings go into the request; unset ones are omitted', async () => {
  const ok = () => new Response(JSON.stringify({ content: [], stop_reason: 'end_turn' }), { status: 200 });
  await withFetch(ok, async (bodies) => {
    const base = { provider: 'anthropic', apiKey: 'k', model: 'm', maxTokens: 10, stream: false };
    await createProvider({ ...base, effort: 'high', reasoning: 'summarized' }).createMessage({ system: 's', messages: [], tools: [] });
    await createProvider(base).createMessage({ system: 's', messages: [], tools: [] });
    assert.deepEqual(bodies[0].output_config, { effort: 'high' });
    assert.deepEqual(bodies[0].thinking, { type: 'adaptive', display: 'summarized' });
    assert.equal('output_config' in bodies[1], false);
    assert.equal('thinking' in bodies[1], false);
  });
});

test('Anthropic stream keeps thinking blocks with their signature and streams thinking text', async () => {
  const body = sseBody([
    anthropicEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    anthropicEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me see' } }),
    anthropicEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } }),
    anthropicEvent({ type: 'content_block_stop', index: 0 }),
    anthropicEvent({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'xyz' } }),
    anthropicEvent({ type: 'content_block_stop', index: 1 }),
    anthropicEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    anthropicEvent({ type: 'message_stop' }),
  ]);
  const thought = [];
  const res = await readAnthropicStream(body, null, {}, (d) => thought.push(d));
  assert.deepEqual(thought, ['Let me see']);
  assert.deepEqual(res.content, [
    { type: 'thinking', thinking: 'Let me see', signature: 'sig123' },
    { type: 'redacted_thinking', data: 'xyz' },
  ]);
});

test('OpenAI: streams ask for usage, effort becomes reasoning_effort, and reasoning text is streamed', async () => {
  const stream = () => new Response([
    openaiChunk({ choices: [{ delta: { reasoning_content: 'hmm' } }] }),
    openaiChunk({ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }),
    openaiChunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    'data: [DONE]\n\n',
  ].join(''), { status: 200 });
  await withFetch(stream, async (bodies) => {
    const thought = [];
    const provider = createProvider({ provider: 'openai', apiKey: 'k', model: 'm', maxTokens: 10, effort: 'low' });
    const res = await provider.createMessage({ system: 's', messages: [], tools: [], onThinking: (d) => thought.push(d) });
    assert.deepEqual(bodies[0].stream_options, { include_usage: true });
    assert.equal(bodies[0].reasoning_effort, 'low');
    assert.deepEqual(thought, ['hmm']);
    assert.deepEqual(res.usage, { prompt_tokens: 3, completion_tokens: 1 });
  });
});

test('OpenAI: a server that rejects stream_options is retried without it', async () => {
  const reply = (body) => (body.stream_options
    ? new Response(JSON.stringify({ error: { message: 'Unrecognized request argument: stream_options' } }), { status: 400 })
    : new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 }));
  await withFetch(reply, async (bodies) => {
    const provider = createProvider({ provider: 'openai', apiKey: 'k', model: 'm', maxTokens: 10 });
    const res = await provider.createMessage({ system: 's', messages: [], tools: [] });
    assert.equal(res.content[0].text, 'ok');
    assert.equal(bodies.length, 2);
    await provider.createMessage({ system: 's', messages: [], tools: [] });
    assert.equal('stream_options' in bodies[2], false, 'remembered for later requests');
  });
});
