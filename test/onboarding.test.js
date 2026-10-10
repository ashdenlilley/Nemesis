import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { askSecret } from '../src/onboarding.js';

test('askSecret shows the label and does not echo the typed key', async () => {
  const input = new PassThrough();
  const chunks = [];
  const output = new PassThrough();
  output.on('data', (c) => chunks.push(c.toString()));
  const rl = createInterface({ input, output, terminal: true });
  const sink = { write() {} };

  const pending = askSecret(rl, 'Key: ', sink);
  input.write('sk-secret-123\r');
  const answer = await pending;
  rl.close();

  assert.equal(answer, 'sk-secret-123');
  const shown = chunks.join('');
  assert.ok(shown.includes('Key: '), `label missing from output: ${JSON.stringify(shown)}`);
  assert.ok(!shown.includes('sk-secret-123'), 'typed key was echoed');
});
