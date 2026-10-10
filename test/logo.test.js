import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { halfBlocks, logoLines, parsePath, rasterize } from '../src/logo.js';

test('parsePath: M/L/H/V/Z square gives one ring of four corners', () => {
  const rings = parsePath('M0 0H10V10H0Z');
  assert.equal(rings.length, 1);
  assert.deepEqual(rings[0], [[0, 0], [10, 0], [10, 10], [0, 10]]);
});

test('parsePath: Q curves flatten to sampled points ending at the endpoint', () => {
  const [ring] = parsePath('M0 0Q5 10 10 0Z');
  assert.equal(ring.length, 1 + 8);
  assert.deepEqual(ring.at(-1), [10, 0]);
});

test('rasterize: filled square is all pixels, even-odd leaves a hole empty', () => {
  const solid = rasterize(parsePath('M0 0H4V4H0Z'), 4);
  assert.ok(solid.every((row) => row.every(Boolean)));

  const ring = parsePath('M0 0H9V9H0Z M3 3V6H6V3Z');
  const hole = rasterize(ring, 9);
  assert.equal(hole[4][4], false);
  assert.equal(hole[0][0], true);
});

test('halfBlocks packs two pixel rows per text row', () => {
  assert.deepEqual(halfBlocks([[true, false], [true, true]]), ['█▄']);
  assert.deepEqual(halfBlocks([[true, true]]), ['▀▀']);
});

test('logoLines renders the repo logo at the requested width', () => {
  const lines = logoLines(40);
  assert.ok(lines && lines.length > 0);
  assert.ok(lines.every((l) => [...l].length <= 40));
  assert.ok(lines.some((l) => /[█▀▄]/.test(l)));
});

test('logoLines returns null when the logo file is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nemesis-logo-'));
  assert.equal(logoLines(40, path.join(dir, 'nope.svg')), null);
  const bad = path.join(dir, 'bad.svg');
  await writeFile(bad, '<svg></svg>');
  assert.equal(logoLines(40, bad), null);
});
