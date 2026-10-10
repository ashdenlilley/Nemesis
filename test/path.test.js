import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isOnPath, shimDir, launcherName, setupPath, addToPosixPath } from '../src/path.js';

const quietUI = () => ({ info() {}, warn() {} });

test('isOnPath: case-insensitive with trailing slashes on Windows, exact on POSIX', () => {
  assert.equal(isOnPath('C:\\Users\\me\\npm\\', 'C:\\Windows;c:\\users\\me\\NPM', 'win32'), true);
  assert.equal(isOnPath('/opt/npm/bin', '/usr/bin:/opt/npm/bin/', 'linux'), true);
  assert.equal(isOnPath('/opt/npm/bin', '/usr/bin', 'linux'), false);
  assert.equal(isOnPath('/x', '', 'linux'), false);
});

test('shimDir and launcherName follow npm layout per platform', () => {
  assert.equal(shimDir('C:\\npm', 'win32'), 'C:\\npm');
  assert.equal(shimDir('/usr/local', 'linux'), '/usr/local/bin');
  assert.equal(launcherName('win32'), 'nemesis.cmd');
  assert.equal(launcherName('linux'), 'nemesis');
});

// Temp dirs on Windows contain a drive colon, which breaks the POSIX ':' PATH split.
const posixOnly = { skip: process.platform === 'win32' && 'POSIX PATH format' };

test('setupPath: already on PATH is a no-op', posixOnly, async () => {
  const prefix = await mkdtemp(path.join(tmpdir(), 'nemesis-path-'));
  const env = { PATH: `/bin:${shimDir(prefix, 'linux')}` };
  const rl = { async question() { throw new Error('should not prompt'); } };
  const r = await setupPath({ rl, ui: quietUI(), env, platform: 'linux', prefix, home: prefix });
  assert.equal(r.status, 'on-path');
});

test('setupPath: no launcher installed -> explains GitHub install, no prompt', async () => {
  const prefix = await mkdtemp(path.join(tmpdir(), 'nemesis-path-'));
  const notes = [];
  const rl = { async question() { throw new Error('should not prompt'); } };
  const r = await setupPath({ rl, ui: { info: (t) => notes.push(t), warn() {} }, env: { PATH: '/bin' }, platform: 'linux', prefix, home: prefix });
  assert.equal(r.status, 'no-launcher');
  assert.match(notes[0], /npm install -g github:ashdenlilley\/Nemesis/);
});

test('setupPath: declined -> nothing written', async () => {
  const prefix = await mkdtemp(path.join(tmpdir(), 'nemesis-path-'));
  const bin = shimDir(prefix, 'linux');
  await mkdir(bin);
  await writeFile(path.join(bin, 'nemesis'), '#!/bin/sh\n');
  const home = await mkdtemp(path.join(tmpdir(), 'nemesis-home-'));
  const rl = { async question() { return 'n'; } };
  const r = await setupPath({ rl, ui: quietUI(), env: { PATH: '/bin' }, platform: 'linux', prefix, home });
  assert.equal(r.status, 'declined');
});

test('setupPath (POSIX): accepted -> rc file gets one export line, rerun is idempotent', posixOnly, async () => {
  const prefix = await mkdtemp(path.join(tmpdir(), 'nemesis-path-'));
  const bin = shimDir(prefix, 'linux');
  await mkdir(bin);
  await writeFile(path.join(bin, 'nemesis'), '#!/bin/sh\n');
  const home = await mkdtemp(path.join(tmpdir(), 'nemesis-home-'));
  const env = { PATH: '/bin', SHELL: '/bin/zsh' };
  const rl = { async question() { return ''; } };

  const r = await setupPath({ rl, ui: quietUI(), env, platform: 'linux', prefix, home });
  assert.equal(r.status, 'added');
  assert.ok(env.PATH.startsWith(`${bin}:`));

  const rc = await readFile(path.join(home, '.zshrc'), 'utf8');
  assert.equal(rc.split(`export PATH="${bin}:$PATH"`).length - 1, 1);

  await addToPosixPath(bin, { home, shell: '/bin/zsh' });
  assert.equal((await readFile(path.join(home, '.zshrc'), 'utf8')).split(bin).length - 1, 1);
});
