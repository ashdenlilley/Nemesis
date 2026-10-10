import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createLineReader } from '../src/input.js';
import { askSecret } from '../src/onboarding.js';

// A stdin stand-in that looks like a TTY to the line reader.
const fakeTTY = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });

test('askSecret shows the label and does not echo the typed key', async () => {
  const input = fakeTTY();
  const chunks = [];
  const output = new PassThrough();
  output.on('data', (c) => chunks.push(c.toString()));
  const rl = createLineReader({ input, output });

  const pending = askSecret(rl, 'Key: ');
  input.write('sk-secret-123');
  input.write('\r');
  const answer = await pending;

  assert.equal(answer, 'sk-secret-123');
  const shown = chunks.join('');
  assert.ok(shown.includes('Key: '), `label missing from output: ${JSON.stringify(shown)}`);
  assert.ok(!shown.includes('sk-secret-123'), 'typed key was echoed');
});
