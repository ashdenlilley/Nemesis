import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgentTurn, executeToolUse, settleDanglingToolUses } from '../src/agent.js';
import { createPermissions } from '../src/permissions.js';
import { Session } from '../src/session.js';
import { validateInput } from '../src/schema.js';

const silentUI = () => ({
  assistant() {}, toolCall() {}, toolResult() {}, warn() {}, error() {}, info() {}, userMessage() {},
});

// Scripted provider: returns each queued response in order and records what it was sent.
function scriptedProvider(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    async createMessage(req) {
      calls.push({ ...req, messages: structuredClone(req.messages) });
      if (queue.length === 0) throw new Error('script exhausted');
      return queue.shift();
    },
  };
}

const echoTool = {
  name: 'echo',
  risk: 'read',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  run: async ({ text }) => `echo: ${text}`,
};

const writeTool = {
  name: 'put',
  risk: 'write',
  parameters: { type: 'object', properties: {}, required: [] },
  describeCall: () => 'thing',
  run: async () => 'done',
};

async function newSession() {
  return Session.create(await mkdtemp(path.join(tmpdir(), 'nemesis-session-')));
}

test('validateInput checks required fields and primitive types', () => {
  const schema = echoTool.parameters;
  assert.equal(validateInput(schema, { text: 'hi' }), null);
  assert.match(validateInput(schema, {}), /missing required field "text"/);
  assert.match(validateInput(schema, { text: 5 }), /must be string/);
  assert.match(validateInput(schema, null), /must be an object/);
  assert.equal(validateInput({ properties: { n: { type: 'integer' } } }, { n: 1.5 })?.includes('integer'), true);
});

test('agent loop: tool_use -> tool_result -> final text', async () => {
  const session = await newSession();
  await session.append({ role: 'user', content: 'say hi via echo' });
  const provider = scriptedProvider([
    {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { text: 'hi' } }],
    },
    { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  ]);
  const permissions = createPermissions({ policy: { read: 'allow', write: 'deny', exec: 'deny' } });

  const result = await runAgentTurn({
    provider, config: {}, tools: [echoTool], system: 'sys', session, permissions,
    ui: silentUI(), ctx: { cwd: process.cwd() }, maxSteps: 5,
  });

  assert.equal(result.stopReason, 'end_turn');
  assert.equal(provider.calls.length, 2);
  // Second request must carry the tool_result paired to the tool_use id.
  const toolResultMsg = provider.calls[1].messages.at(-1);
  assert.equal(toolResultMsg.role, 'user');
  assert.deepEqual(toolResultMsg.content[0], {
    type: 'tool_result', tool_use_id: 't1', content: 'echo: hi', is_error: false,
  });
  assert.equal(session.messages.at(-1).content[0].text, 'done');
});

test('follow-ups queued mid-turn join the next tool results, not a new turn', async () => {
  const session = await newSession();
  await session.append({ role: 'user', content: 'check it' });
  const provider = scriptedProvider([
    { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { text: 'hi' } }] },
    { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  ]);
  const permissions = createPermissions({ policy: { read: 'allow', write: 'deny', exec: 'deny' } });
  const queue = ['also check the tests'];
  await runAgentTurn({
    provider, config: {}, tools: [echoTool], system: 'sys', session, permissions,
    ui: silentUI(), ctx: { cwd: process.cwd() }, maxSteps: 5, takeFollowUps: () => queue.splice(0),
  });
  const sent = provider.calls[1].messages.at(-1).content;
  assert.equal(sent[0].type, 'tool_result');
  assert.deepEqual(sent[1], { type: 'text', text: 'also check the tests' });
});

test('unknown tool and invalid input become error results, not crashes', async () => {
  const toolMap = new Map([[echoTool.name, echoTool]]);
  const permissions = createPermissions({ policy: { read: 'allow', write: 'allow', exec: 'allow' } });
  const ctx = { cwd: process.cwd() };

  const unknown = await executeToolUse({ id: 'x', name: 'nope', input: {} }, { toolMap, permissions, ctx });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /Unknown tool: nope/);

  const bad = await executeToolUse({ id: 'y', name: 'echo', input: {} }, { toolMap, permissions, ctx });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /missing required field/);
});

test('permissions: deny policy blocks, ask without terminal blocks, --yes approves', async () => {
  const denied = createPermissions({ policy: { read: 'allow', write: 'deny', exec: 'deny' } });
  assert.equal((await denied.check(writeTool, {})).allowed, false);

  const noTty = createPermissions({ policy: { read: 'allow', write: 'ask', exec: 'ask' } });
  const r = await noTty.check(writeTool, {});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /needs approval/);

  const yes = createPermissions({ policy: { read: 'allow', write: 'ask', exec: 'ask' }, autoApprove: true });
  assert.equal((await yes.check(writeTool, {})).allowed, true);
});

test('permissions: menu picks Yes / Yes-always / No, and always remembers for the session', async () => {
  const picks = [2, 1];
  const menus = [];
  const perms = createPermissions({
    policy: { read: 'allow', write: 'ask', exec: 'ask' },
    choose: async (spec) => { menus.push(spec); return picks.shift(); },
  });
  assert.equal((await perms.check(writeTool, {})).allowed, false);
  assert.equal((await perms.check(writeTool, {})).allowed, true);
  assert.equal((await perms.check(writeTool, {})).allowed, true); // remembered, no prompt
  assert.equal(menus.length, 2);
  assert.match(menus[0].title, /Allow put \(thing\)/);
  assert.equal(menus[0].options.length, 3);
});

test('permissions: cancelled menu (-1) denies', async () => {
  const perms = createPermissions({
    policy: { read: 'allow', write: 'ask', exec: 'ask' },
    choose: async () => -1,
  });
  assert.equal((await perms.check(writeTool, {})).allowed, false);
});

test('interrupted tool calls are settled so history stays valid', async () => {
  const session = await newSession();
  await session.append({ role: 'user', content: 'go' });
  await session.append({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'z1', name: 'echo', input: { text: 'x' } }],
  });
  await settleDanglingToolUses(session);
  const last = session.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].tool_use_id, 'z1');
  assert.equal(last.content[0].is_error, true);

  // Idempotent: a second call finds no dangling tool_use.
  await settleDanglingToolUses(session);
  assert.equal(session.messages.length, 3);
});

test('max steps stops a runaway loop', async () => {
  const session = await newSession();
  await session.append({ role: 'user', content: 'loop' });
  const forever = {
    stopReason: 'tool_use',
    content: [{ type: 'tool_use', id: 'l', name: 'echo', input: { text: 'again' } }],
  };
  const provider = scriptedProvider(Array.from({ length: 3 }, () => structuredClone(forever)));
  const permissions = createPermissions({ policy: { read: 'allow', write: 'allow', exec: 'allow' } });
  const result = await runAgentTurn({
    provider, config: {}, tools: [echoTool], system: '', session, permissions,
    ui: silentUI(), ctx: { cwd: process.cwd() }, maxSteps: 3,
  });
  assert.equal(result.stopReason, 'max_steps');
  assert.equal(provider.calls.length, 3);
});
