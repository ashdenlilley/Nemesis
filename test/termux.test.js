import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellInvocation } from '../src/tools/shell.js';
import { browserCommand } from '../src/mcp/oauth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('package.json allows Termux (platform android), or npm refuses the install', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.os.includes('android'));
});

test('shellInvocation: Termux has no /bin/sh, so android resolves sh via PATH', () => {
  assert.deepEqual(shellInvocation('ls', 'android'), { file: 'sh', args: ['-c', 'ls'] });
  assert.deepEqual(shellInvocation('ls', 'linux'), { file: '/bin/sh', args: ['-c', 'ls'] });
});

test('browserCommand: android uses termux-open-url, others unchanged', () => {
  assert.deepEqual(browserCommand('https://x.test', 'android'), ['termux-open-url', ['https://x.test']]);
  assert.deepEqual(browserCommand('https://x.test', 'linux'), ['xdg-open', ['https://x.test']]);
  assert.deepEqual(browserCommand('https://x.test', 'darwin'), ['open', ['https://x.test']]);
});
