import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLineReader } from '../src/input.js';
import { createUI, stripAnsi } from '../src/ui.js';
import { buildUserContent, mentionCompletions, mentionsIn } from '../src/attach.js';
import { appendHistory, appendNote, loadHistory, renameSession, runStatusLine, sessionSummaries, shellNote } from '../src/extras.js';
import { clipboardImage } from '../src/clipboard.js';
import { toOpenAIMessages } from '../src/providers/openai.js';

const tick = () => new Promise((r) => setImmediate(r));
const fakeTerminal = () => {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const chunks = [];
  const output = { isTTY: true, columns: 60, write: (s) => { chunks.push(s); return true; } };
  return { input, output, text: () => chunks.join('') };
};

// ---------- input: history, Ctrl+R, mode labels, footer ----------

test('Up and Down recall submitted prompts; Down past the newest returns the draft', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  reader.setHistory(['first prompt', 'second prompt']);
  const answer = reader.question('> ', { leave: false });
  term.input.write('draft');
  await tick();
  term.input.write('\x1b[A');
  await tick();
  term.input.write('\x1b[A');
  await tick();
  term.input.write('\x1b[B');
  await tick();
  term.input.write('\x1b[B');
  await tick();
  term.input.write('\r');
  assert.equal(await answer, 'draft');
});

test('Up recalls the newest prompt and Enter submits it', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  reader.setHistory(['alpha', 'beta']);
  const answer = reader.question('> ', { leave: false });
  term.input.write('\x1b[A');
  await tick();
  term.input.write('\r');
  assert.equal(await answer, 'beta');
});

test('Ctrl+R filters history by typed text; Enter takes the match into the box', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  reader.setHistory(['fix the login bug', 'write tests', 'fix the parser']);
  const answer = reader.question('> ', { leave: false });
  term.input.write('\x12');
  await tick();
  term.input.write('login');
  await tick();
  assert.match(term.text(), /reverse-search/);
  term.input.write('\r');
  await tick();
  term.input.write('\r');
  assert.equal(await answer, 'fix the login bug');
});

test('a label function changes the prompt for a leading ! or #', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  const answer = reader.question('> ', { leave: false, labelFor: (t) => (t[0] === '!' ? 'SHELL ' : '> ') });
  term.input.write('!');
  await tick();
  assert.match(stripAnsi(term.text()), /SHELL !/);
  term.input.write('\r');
  assert.equal(await answer, '!');
});

test('footer sits below the box and onKey runs its handler', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  let expanded = 0;
  reader.onKey('\x0f', () => { expanded++; });
  const answer = reader.question('> ', { leave: false });
  reader.setFooter('model · 3 tokens');
  term.input.write('\x0f');
  await tick();
  assert.equal(expanded, 1);
  assert.match(term.text(), /model · 3 tokens/);
  term.input.write('\r');
  await answer;
});

test('insert puts text at the cursor of the box that is up', async () => {
  const term = fakeTerminal();
  const reader = createLineReader({ input: term.input, output: term.output });
  const answer = reader.question('> ', { leave: false });
  term.input.write('look ');
  await tick();
  reader.insert('@a.png ');
  term.input.write('\r');
  assert.equal(await answer, 'look @a.png ');
});

// ---------- ui: condensed tool runs, mode prompts ----------

test('consecutive read-only calls collapse into one summary line; expandLast shows each result', async () => {
  const out = { text: '', write(s) { this.text += s; return true; } };
  const ui = createUI({ out, err: out, color: false });
  const a = { name: 'read_file', input: { path: 'a.js' } };
  const b = { name: 'grep', input: { pattern: 'x' } };
  const tool = { describeCall: (i) => i.path ?? i.pattern };
  ui.toolCall(a, tool);
  ui.toolResult(a, { content: 'line one', isError: false });
  ui.toolCall(b, { describeCall: (i) => i.pattern });
  ui.toolResult(b, { content: 'src/a.js:1', isError: false });
  assert.equal(out.text, '', 'nothing printed while the run is open');
  ui.info('next');
  assert.match(out.text, /● Read 1 file, searched 1 pattern \(ctrl\+o to expand\)/);
  out.text = '';
  ui.expandLast();
  assert.match(out.text, /Read\(a\.js\)/);
  assert.match(out.text, /line one/);
  assert.match(out.text, /src\/a\.js:1/);
});

test('a non-read tool breaks the run and prints on its own', () => {
  const out = { text: '', write(s) { this.text += s; return true; } };
  const ui = createUI({ out, err: out, color: false });
  ui.toolCall({ name: 'read_file', input: { path: 'a' } }, { describeCall: (i) => i.path });
  ui.toolResult({ name: 'read_file' }, { content: 'x', isError: false });
  ui.toolCall({ name: 'bash', input: { command: 'ls' } }, { describeCall: (i) => i.command });
  assert.match(out.text, /● Read 1 file/);
  assert.match(out.text, /● Bash\(ls\)/);
});

test('prompt labels: ! is yellow, # is cyan, default is the accent ❯', () => {
  const ui = createUI({ out: { write() {} }, err: { write() {} }, depth: 'truecolor' });
  assert.equal(stripAnsi(ui.prompt('!')), '! ');
  assert.equal(stripAnsi(ui.prompt('#')), '# ');
  assert.ok(ui.prompt('!').includes('\x1b[33m'));
  assert.ok(ui.prompt('#').includes('\x1b[36m'));
  assert.equal(stripAnsi(ui.prompt()), '❯ ');
});

// ---------- attachments ----------

test('@file mentions inline text files; missing and outside paths are left alone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nemesis-attach-'));
  await writeFile(path.join(root, 'notes.md'), 'hello file');
  const content = await buildUserContent('read @notes.md and @missing.txt and @../etc', { roots: root });
  assert.equal(typeof content, 'string');
  assert.match(content, /<file path="notes\.md">\nhello file\n<\/file>/);
  assert.doesNotMatch(content, /missing\.txt">/);
  assert.doesNotMatch(content, /etc">/);
});

test('@image mentions become base64 image blocks ahead of the text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nemesis-img-'));
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  await writeFile(path.join(root, 'shot.png'), png);
  const content = await buildUserContent('what is in @shot.png', { roots: root });
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.media_type, 'image/png');
  assert.equal(content[0].source.data, png.toString('base64'));
  assert.equal(content.at(-1).type, 'text');
});

test('OpenAI-compatible messages carry images as image_url parts', () => {
  const messages = toOpenAIMessages('sys', [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'text', text: 'describe' },
    ],
  }]);
  const user = messages.at(-1);
  assert.equal(user.content[0].type, 'text');
  assert.equal(user.content[1].image_url.url, 'data:image/png;base64,AAA');
});

test('mention completions list files in the named folder and apply in place', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nemesis-mention-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'cli.js'), '');
  await writeFile(path.join(root, 'README.md'), '');
  const items = mentionCompletions('look at @src/c', { cwd: root });
  assert.deepEqual(items.map((i) => i.name), ['@src/cli.js']);
  assert.equal(items[0].apply('look at @src/c'), 'look at @src/cli.js ');
  assert.deepEqual(mentionCompletions('@R', { cwd: root }).map((i) => i.name), ['@README.md']);
  assert.deepEqual(mentionsIn('a @x.md b @y.png'), ['x.md', 'y.png']);
});

// ---------- extras ----------

test('prompt history round-trips, keeps multi-line prompts, and skips damaged lines', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'nemesis-hist-'));
  await appendHistory(home, 'one\ntwo');
  await appendHistory(home, 'three');
  const file = path.join(home, '.nemesis', 'history.txt');
  await writeFile(file, `${await readFile(file, 'utf8')}not json\n`);
  assert.deepEqual(await loadHistory(home), ['one\ntwo', 'three']);
});

test('appendNote adds a line to NEMESIS.md, creating it when missing', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'nemesis-note-'));
  await appendNote(cwd, 'use pnpm');
  await appendNote(cwd, 'tests live in test/');
  assert.equal(await readFile(path.join(cwd, 'NEMESIS.md'), 'utf8'), '- use pnpm\n- tests live in test/\n');
});

test('shellNote keeps the command, exit status and output for the model', () => {
  const text = shellNote('npm test', { code: 0, timedOut: false, output: 'pass 3\n' });
  assert.equal(text, 'I ran `npm test` in the shell (exit 0):\npass 3');
});

test('session summaries use a rename or the first user message as the title', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nemesis-sess-'));
  await writeFile(path.join(dir, '2026-01-01T00-00-00-000Z-aaaaaa.jsonl'), `${JSON.stringify({ role: 'user', content: 'fix the parser please' })}\n`);
  await writeFile(path.join(dir, '2026-01-02T00-00-00-000Z-bbbbbb.jsonl'), `${JSON.stringify({ role: 'user', content: 'other' })}\n`);
  await renameSession(dir, '2026-01-02T00-00-00-000Z-bbbbbb', 'Release prep');
  const list = await sessionSummaries(dir);
  assert.deepEqual(list.map((s) => s.title), ['Release prep', 'fix the parser please']);
});

test('status line command: first output line is returned', async () => {
  const line = await runStatusLine("node -e \"console.log('hello status')\"", {}, { cwd: process.cwd() });
  assert.equal(line, 'hello status');
});

test('clipboard image: no tool or no image gives null', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nemesis-clip-'));
  assert.equal(await clipboardImage(dir, { platform: 'linux', run: async () => false }), null);
});
