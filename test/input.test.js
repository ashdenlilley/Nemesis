import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { applyInput, layout, viewport, createLineReader, MAX_INPUT_ROWS } from '../src/input.js';

const blank = () => ({ text: '', cur: 0, top: 0, pasting: false });
const type = (st, s) => applyInput(st, s);

test('Enter submits; Ctrl+J and Alt+Enter insert a newline', () => {
  const st = blank();
  type(st, 'one');
  assert.equal(type(st, '\x1b\r'), null);
  type(st, '\n');
  type(st, 'two');
  assert.equal(st.text, 'one\n\ntwo');
  assert.equal(type(st, '\r'), 'submit');
});

test('a multi-character chunk is a paste: newlines stay in the text and do not submit', () => {
  const st = blank();
  assert.equal(type(st, 'line a\r\nline b\rline c'), null);
  assert.equal(st.text, 'line a\nline b\nline c');
});

test('bracketed paste inserts literally, including Enter characters', () => {
  const st = blank();
  type(st, '\x1b[200~first\r\nsecond\x1b[201~');
  assert.equal(st.text, 'first\nsecond');
  assert.equal(st.pasting, false);
});

test('backspace, delete, arrows, and Ctrl+W edit at the cursor', () => {
  const st = blank();
  type(st, 'hello world');
  type(st, '\x17');
  assert.equal(st.text, 'hello ');
  type(st, '\x1b[D\x1b[D');
  type(st, '\x7f');
  assert.equal(st.text, 'helo ');
  assert.equal(st.cur, 3);
});

test('Up and Down keep the column across lines', () => {
  const st = blank();
  type(st, 'abcdef\nxy\nlonger line');
  type(st, '\x1b[A');
  assert.equal(st.cur, 'abcdef\nxy'.length, 'Up lands at end of shorter line');
  type(st, '\x1b[A');
  assert.equal(st.cur, 2);
});

test('Ctrl+C clears a non-empty prompt, and on an empty one reports interrupt', () => {
  const st = blank();
  type(st, 'draft');
  assert.equal(type(st, '\x03'), null);
  assert.equal(st.text, '');
  assert.equal(type(st, '\x03'), 'interrupt');
});

test('Ctrl+D on an empty prompt reports eof', () => {
  assert.equal(applyInput(blank(), '\x04'), 'eof');
});

test('layout wraps long lines and places the cursor on the wrapped row', () => {
  const r = layout('abcdefghij', 7, 4);
  assert.deepEqual(r.rows, ['abcd', 'efgh', 'ij']);
  assert.equal(r.cursorRow, 1);
  assert.equal(r.cursorCol, 3);
});

test('viewport keeps the cursor row on screen and caps the box height', () => {
  assert.deepEqual(viewport(3, 2, 0), { start: 0, end: 3 });
  const v = viewport(20, 19, 0);
  assert.equal(v.end - v.start, MAX_INPUT_ROWS);
  assert.ok(v.start <= 19 && 19 < v.end);
  const up = viewport(20, 0, 10);
  assert.deepEqual(up, { start: 0, end: MAX_INPUT_ROWS });
});

test('line reader refuses non-TTY input instead of hanging', async () => {
  const input = new PassThrough();
  const rl = createLineReader({ input, output: new PassThrough() });
  await assert.rejects(rl.question('> '), /needs a terminal/);
});

// Fake terminal: records what the reader writes and lets the test press keys.
const fakeTerminal = () => {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const chunks = [];
  const output = { isTTY: true, columns: 40, write: (s) => { chunks.push(s); return true; } };
  return { input, output, text: () => chunks.join('') };
};

test('choose: arrow keys and Enter pick an option; Esc cancels with -1', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  const picked = reader.choose({ title: 'Allow?', options: ['Yes', 'Always', 'No'] });
  term.input.write('\x1b[B');
  term.input.write('\r');
  assert.equal(await picked, 1);
  const cancelled = reader.choose({ title: 'Allow?', options: ['Yes', 'No'] });
  term.input.write('\x1b');
  assert.equal(await cancelled, -1);
});

test('watch: Enter goes to onSubmit and the box stays up; output written through wrap() redraws below it', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  const submitted = [];
  reader.watch({ label: '> ', onSubmit: (t) => submitted.push(t), onInterrupt: () => {} });
  term.input.write('later');
  term.input.write('\r');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(submitted, ['later']);
  const feed = reader.wrap({ columns: 40, isTTY: true });
  feed.write('tool ran\n');
  reader.unwatch();
  assert.match(term.text(), /tool ran\n/);
});

test('question with leave:false clears the box on submit instead of keeping it on screen', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  const answer = reader.question('> ', { leave: false });
  term.input.write('hi');
  await new Promise((r) => setImmediate(r));
  term.input.write('\r');
  assert.equal(await answer, 'hi');
  // The box is erased, not left behind, and raw mode stays on for the next prompt.
  assert.ok(term.text().endsWith('\x1b[J'));
  assert.doesNotMatch(term.text(), /\x1b\[\?2004l/);
});

test('raw mode stays on between prompts and turns off only on close', async () => {
  const term = fakeTerminal();
  const modes = [];
  term.input.setRawMode = (on) => modes.push(on);
  const reader = createLineReader({ input: term.input, output: term.output });
  const first = reader.question('> ');
  term.input.write('a');
  term.input.write('\r');
  await first;
  const second = reader.question('> ');
  term.input.write('b');
  term.input.write('\r');
  await second;
  assert.deepEqual(modes, [true]);
  reader.close();
  assert.deepEqual(modes, [true, false]);
});

test('keys pressed while no box is up go into the next box, including a paste', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  const first = reader.question('> ');
  term.input.write('x');
  term.input.write('\r');
  await first;
  term.input.write('\x1b[200~sk-pasted-key\x1b[201~');
  await new Promise((r) => setImmediate(r));
  const key = reader.question('Key: ', { secret: true });
  term.input.write('\r');
  assert.equal(await key, 'sk-pasted-key');
});

test('unsent text in a watch box carries into the next prompt', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  reader.watch({ label: '> ', onSubmit: () => {}, onInterrupt: () => {} });
  term.input.write('half typed');
  await new Promise((r) => setImmediate(r));
  reader.unwatch();
  const next = reader.question('> ', { leave: false });
  term.input.write(' more');
  await new Promise((r) => setImmediate(r));
  term.input.write('\r');
  assert.equal(await next, 'half typed more');
});

test('a secret question shows dots, never the characters', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  const key = reader.question('Key: ', { secret: true });
  term.input.write('abc');
  await new Promise((r) => setImmediate(r));
  term.input.write('\r');
  assert.equal(await key, 'abc');
  assert.match(term.text(), /•••/);
  assert.doesNotMatch(term.text(), /abc/);
});


test('slash suggestions: typing / lists matches, Down moves, Tab fills in, Enter runs the highlighted one', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  const commands = [{ name: '/help', description: 'Show all commands' }, { name: '/hooks', description: 'List hooks' }, { name: '/model', description: 'Model' }];
  const complete = (text) => (/^\/\S*$/.test(text) ? commands.filter((c) => c.name.startsWith(text)) : []);
  const answer = reader.question('> ', { leave: false, complete });
  const tick = () => new Promise((r) => setImmediate(r));
  term.input.write('/');
  await tick();
  term.input.write('h');
  await tick();
  assert.match(term.text(), /\/help {2,}Show all commands/);
  assert.match(term.text(), /\/hooks/);
  term.input.write('\x1b[B');
  await tick();
  term.input.write('\r');
  assert.equal(await answer, '/hooks');

  const second = reader.question('> ', { leave: false, complete });
  term.input.write('/');
  await tick();
  term.input.write('m');
  await tick();
  term.input.write('\t');
  await tick();
  term.input.write('x');
  await tick();
  term.input.write('\r');
  assert.equal(await second, '/model x');
});

test('Esc hides the suggestion list so Enter submits what was typed', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  const complete = (text) => (text.startsWith('/') ? [{ name: '/help', description: '' }] : []);
  const answer = reader.question('> ', { leave: false, complete });
  const tick = () => new Promise((r) => setImmediate(r));
  term.input.write('/');
  await tick();
  term.input.write('x');
  await tick();
  term.input.write('\x1b');
  await tick();
  term.input.write('\r');
  assert.equal(await answer, '/x');
});

test('status line sits above the watch box, and Esc interrupts the turn', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  let interrupted = false;
  reader.watch({ label: '> ', onSubmit() {}, onInterrupt: () => { interrupted = true; } });
  reader.setStatus('* Nms-ing...');
  assert.match(term.text(), /\* Nms-ing\.\.\.\r\n> /);
  term.input.write('\x1b');
  await new Promise((r) => setImmediate(r));
  assert.equal(interrupted, true);
  reader.setStatus(null);
  reader.unwatch();
});
