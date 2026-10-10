import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { editFileTool, readFileTool, writeFileTool } from '../src/tools/files.js';
import { globToRegExp, grepTool, globTool } from '../src/tools/search.js';
import { resolveInWorkspace } from '../src/tools/paths.js';
import { shellInvocation } from '../src/tools/shell.js';
import { truncateMiddle } from '../src/tools/text.js';

async function workspace(files = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'nemesis-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(cwd, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return { cwd, ctx: { cwd } };
}

test('resolveInWorkspace blocks escapes and allows nested paths', () => {
  const cwd = path.resolve('/work/project');
  assert.equal(resolveInWorkspace(cwd, 'src/a.js'), path.join(cwd, 'src', 'a.js'));
  assert.equal(resolveInWorkspace(cwd, '..foo.txt'), path.join(cwd, '..foo.txt'));
  assert.throws(() => resolveInWorkspace(cwd, '../secret'), /outside the workspace/);
  assert.throws(() => resolveInWorkspace(cwd, path.resolve('/elsewhere/x')), /outside the workspace/);
  assert.throws(() => resolveInWorkspace(cwd, ''), /non-empty/);
});

test('read_file numbers lines and honors offset and limit', async () => {
  const { ctx } = await workspace({ 'a.txt': 'one\ntwo\nthree\nfour' });
  const out = await readFileTool.run({ path: 'a.txt', offset: 2, limit: 2 }, ctx);
  assert.match(out, /^\s+2\ttwo\n\s+3\tthree/);
  assert.match(out, /continue with offset=4/);
});

test('read_file refuses binary files', async () => {
  const { ctx } = await workspace({ 'b.bin': 'abc\0def' });
  await assert.rejects(readFileTool.run({ path: 'b.bin' }, ctx), /binary/);
});

test('write_file creates parent directories', async () => {
  const { cwd, ctx } = await workspace();
  await writeFileTool.run({ path: 'deep/nested/x.txt', content: 'hi' }, ctx);
  assert.equal(await readFile(path.join(cwd, 'deep/nested/x.txt'), 'utf8'), 'hi');
});

test('edit_file requires a unique match unless replace_all', async () => {
  const { cwd, ctx } = await workspace({ 'f.js': 'const a = 1;\nconst b = 1;\n' });
  await assert.rejects(
    editFileTool.run({ path: 'f.js', old_string: '= 1', new_string: '= 2' }, ctx),
    /matches 2 times/,
  );
  await assert.rejects(
    editFileTool.run({ path: 'f.js', old_string: 'nope', new_string: 'x' }, ctx),
    /not found/,
  );

  await editFileTool.run({ path: 'f.js', old_string: 'const a', new_string: 'let a' }, ctx);
  assert.equal(await readFile(path.join(cwd, 'f.js'), 'utf8'), 'let a = 1;\nconst b = 1;\n');

  await editFileTool.run({ path: 'f.js', old_string: '= 1', new_string: '= $&', replace_all: true }, ctx);
  assert.equal(await readFile(path.join(cwd, 'f.js'), 'utf8'), 'let a = $&;\nconst b = $&;\n');
});

test('globToRegExp: ** crosses directories, * does not', () => {
  assert.ok(globToRegExp('src/**/*.js').test('src/a.js'));
  assert.ok(globToRegExp('src/**/*.js').test('src/x/y/a.js'));
  assert.ok(!globToRegExp('src/*.js').test('src/x/a.js'));
  assert.ok(!globToRegExp('*.js').test('a.ts'));
  assert.ok(globToRegExp('a.b').test('a.b') && !globToRegExp('a.b').test('axb'));
});

test('glob skips node_modules and .git', async () => {
  const { ctx } = await workspace({
    'src/index.js': '',
    'node_modules/pkg/index.js': '',
    '.git/hooks/x.js': '',
  });
  const out = await globTool.run({ pattern: '**/*.js' }, ctx);
  assert.equal(out, 'src/index.js');
});

test('grep returns file:line matches and honors glob filter', async () => {
  const { ctx } = await workspace({
    'a.js': 'const needle = 1;\nnothing\n',
    'b.md': 'needle in docs\n',
  });
  const all = await grepTool.run({ pattern: 'needle' }, ctx);
  assert.match(all, /a\.js:1: const needle = 1;/);
  assert.match(all, /b\.md:1: needle in docs/);

  const jsOnly = await grepTool.run({ pattern: 'needle', glob: '**/*.js' }, ctx);
  assert.match(jsOnly, /a\.js:1/);
  assert.doesNotMatch(jsOnly, /b\.md/);

  assert.equal(await grepTool.run({ pattern: 'absent' }, ctx), 'no matches');
  await assert.rejects(grepTool.run({ pattern: '(' }, ctx), /invalid regular expression/);
});

test('shellInvocation picks PowerShell on Windows and sh elsewhere', () => {
  assert.equal(shellInvocation('dir', 'win32').file, 'powershell.exe');
  assert.deepEqual(shellInvocation('ls', 'linux'), { file: '/bin/sh', args: ['-c', 'ls'] });
});

test('truncateMiddle keeps head and tail', () => {
  const text = 'a'.repeat(100) + 'b'.repeat(100);
  const out = truncateMiddle(text, 50);
  assert.ok(out.startsWith('a'.repeat(25)));
  assert.ok(out.endsWith('b'.repeat(25)));
  assert.match(out, /truncated/);
  assert.equal(truncateMiddle('short', 50), 'short');
});
