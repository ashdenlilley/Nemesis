import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accentOpen, colorDepth, hexToRgb, rgbTo256, ACCENT_HEX } from '../src/theme.js';
import { createUI, GHOST, stripAnsi } from '../src/ui.js';

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
  assert.match(err.text, /● Bash\(\{"command":"ls"\}\)/);
  assert.match(err.text, / {2}⎿ {2}ok/);
  assert.match(err.text, /Nemesis 0\.2\.0/);
});

test('UI with truecolor paints the accent #7F00FF on tool calls and prompt', () => {
  const err = buffer();
  const ui = createUI({ out: buffer(), err, depth: 'truecolor' });
  ui.toolCall({ name: 'bash', input: { command: 'x' } }, null);
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

test('streamed text chunks join on one line instead of each starting a new line', () => {
  const out = buffer();
  const ui = createUI({ out, err: out, color: false });
  for (const c of ['Hello! I', "'m Nemesis", ', ready', '\n\nNext paragraph']) ui.streamText(c);
  ui.endStream();
  assert.equal(out.text, "● Hello! I'm Nemesis, ready\n\n  Next paragraph\n");
});

test('streamed Markdown: inline code, bold, headings, bullets, and fenced code are styled, markers removed', () => {
  const out = buffer();
  const ui = createUI({ out, err: out, depth: 'truecolor' });
  const text = '# Title\nUse `npm test` and **care**.\n- one\n```js\nconst a = 1;\n```\ndone';
  for (const ch of text) ui.streamText(ch); // worst case: one character per chunk
  ui.endStream();
  const plain = stripAnsi(out.text);
  assert.equal(plain, '● Title\n  Use npm test and care.\n  • one\n  const a = 1;\n  done\n');
  assert.ok(out.text.includes('\x1b[1m'), 'bold is applied');
  assert.ok(out.text.includes('\x1b[38;2;'), 'code is colored');
});

test('long assistant lines wrap at word boundaries with a hanging indent', () => {
  const out = buffer();
  out.columns = 30;
  const ui = createUI({ out, err: out, color: false });
  ui.streamText('alpha beta gamma delta epsilon zeta eta theta');
  ui.endStream();
  const lines = out.text.trimEnd().split('\n');
  assert.ok(lines.every((l) => l.length < 30), lines.join('|'));
  assert.ok(lines.slice(1).every((l) => l.startsWith('  ')));
  assert.equal(lines.map((l) => l.replace(/^● /, '').trim()).join(' '), 'alpha beta gamma delta epsilon zeta eta theta');
});

test('an edit result shows a numbered diff instead of the raw tool output', () => {
  const err = buffer();
  const ui = createUI({ out: err, err, color: false });
  ui.toolCall({ name: 'edit_file', input: { path: 'src/v.js' } }, { describeCall: (i) => i.path });
  ui.toolResult({ name: 'edit_file' }, {
    content: 'edited src/v.js (1 replacement)',
    isError: false,
    display: { type: 'diff', path: 'src/v.js', line: 3, oldLines: ['a = 1'], newLines: ['a = 2'], replacements: 1 },
  });
  assert.match(err.text, /● Update\(src\/v\.js\)/);
  assert.match(err.text, /⎿ {2}Updated src\/v\.js \(\+1 -1\)/);
  assert.match(err.text, /3 -a = 1/);
  assert.match(err.text, /3 \+a = 2/);
});


test('a chunk ending in newlines keeps them when more text follows', () => {
  const out = buffer();
  const ui = createUI({ out, err: out, color: false });
  ui.streamText('First paragraph.\n\n');
  ui.streamText('Second.');
  ui.endStream();
  assert.equal(out.text, '● First paragraph.\n\n  Second.\n');
});


test('banner shows the pixel ghost beside the title', () => {
  const err = buffer();
  createUI({ out: err, err, color: false }).banner({ version: '0.7.0', provider: 'p', model: 'm', cwd: '/w', session: 's' });
  const titleLine = err.text.split('\n').find((l) => l.includes('Nemesis 0.7.0'));
  assert.ok(titleLine.includes(GHOST[0].trim()), titleLine);
});

test('rule and shaded rows use the full window width, not a fixed cap', () => {
  const out = buffer();
  out.columns = 160;
  const ui = createUI({ out, err: out, color: false });
  ui.rule();
  assert.equal(out.text.trim().length, 159);
});

test('banner on a phone-width terminal stacks the info lines under the logo', () => {
  const err = buffer();
  err.columns = 45;
  createUI({ out: buffer(), err, color: false }).banner({
    version: '0.12.0', provider: 'openai', model: 'gpt-4o', cwd: '/data/data/com.termux/files/home/Nemesis', session: '2026',
  });
  const lines = err.text.trimEnd().split('\n');
  assert.ok(lines.every((l) => l.length <= 44), lines.join('\n'));
  const titleAt = lines.findIndex((l) => l.includes('Nemesis 0.12.0'));
  const modelAt = lines.findIndex((l) => l.includes('openai/gpt-4o'));
  assert.ok(titleAt > 0 && modelAt > titleAt, 'info lines come after the logo, not beside it');
});
