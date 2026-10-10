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
