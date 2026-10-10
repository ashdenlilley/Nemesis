import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accentOpen, colorDepth, hexToRgb, rgbTo256, ACCENT_HEX } from '../src/theme.js';
import { createUI, stripAnsi } from '../src/ui.js';

const buffer = () => {
  const chunks = [];
  return { write: (s) => { chunks.push(s); return true; }, get text() { return chunks.join(''); } };
};

test('ACCENT_HEX #7F00FF maps to rgb(127,0,255)', () => {
  assert.equal(ACCENT_HEX, '#7F00FF');
  assert.deepEqual(hexToRgb('#7F00FF'), [127, 0, 255]);
  assert.deepEqual(hexToRgb('7f00ff'), [127, 0, 255]);
  assert.throws(() => hexToRgb('#7F00'), /bad hex color/);
});

test('accent escape per depth: truecolor, 256-palette nearest, basic magenta, none', () => {
  assert.equal(accentOpen('truecolor'), '\x1b[38;2;127;0;255m');
  assert.equal(rgbTo256([127, 0, 255]), 93);
  assert.equal(accentOpen('256'), '\x1b[38;5;93m');
  assert.equal(accentOpen('basic'), '\x1b[35m');
  assert.equal(accentOpen('none'), '');
});

test('colorDepth: NO_COLOR and non-TTY disable color; truecolor detected from env', () => {
  assert.equal(colorDepth({}, false), 'none');
  assert.equal(colorDepth({ NO_COLOR: '' }, true), 'none');
  assert.equal(colorDepth({ COLORTERM: 'truecolor' }, true), 'truecolor');
  assert.equal(colorDepth({ WT_SESSION: 'abc' }, true), 'truecolor');
  assert.equal(colorDepth({ TERM: 'xterm-256color' }, true), '256');
  assert.equal(colorDepth({ TERM: 'xterm' }, true), 'basic');
});

test('UI with color off emits no escape codes', () => {
  const err = buffer();
  const out = buffer();
  const ui = createUI({ out, err, color: false });
  ui.toolCall({ name: 'bash', input: { command: 'ls' } }, null);
  ui.toolResult({ name: 'bash' }, { content: 'ok', isError: false });
  ui.banner({ version: '0.2.0', provider: 'anthropic', model: 'm', cwd: '/w', session: 's1' });
  assert.equal(err.text.includes('\x1b['), false);
  assert.match(err.text, /⏺ bash\(\{"command":"ls"\}\)/);
  assert.match(err.text, /Nemesis 0\.2\.0/);
});

test('UI with truecolor paints the accent #7F00FF on tool calls and prompt', () => {
  const err = buffer();
  const ui = createUI({ out: buffer(), err, depth: 'truecolor' });
  ui.toolCall({ name: 'grep', input: { pattern: 'x' } }, null);
  assert.ok(err.text.includes('\x1b[38;2;127;0;255m'));
  assert.ok(ui.prompt().includes('\x1b[38;2;127;0;255m'));
  assert.equal(stripAnsi(ui.prompt()), '❯ ');
});

test('banner prints the logo rows with session info beside them', () => {
  const err = buffer();
  createUI({ out: buffer(), err, color: false }).banner({
    version: '0.2.0', provider: 'openai', model: 'gpt-4o', cwd: 'C:\\Developer\\Github\\Nemesis', session: 'x',
  });
  const lines = err.text.trimEnd().split('\n');
  assert.ok(lines.length >= 4);
  assert.match(lines.join('\n'), /Nemesis 0\.2\.0/);
  assert.match(lines.join('\n'), /openai\/gpt-4o/);
});
