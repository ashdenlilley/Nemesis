import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveInWorkspace } from './paths.js';

const DEFAULT_LINE_LIMIT = 2000;

async function readText(abs) {
  const text = await readFile(abs, 'utf8');
  if (text.includes('\0')) throw new Error('refusing to operate on a binary file');
  return text;
}

export const readFileTool = {
  name: 'read_file',
  description: 'Read a UTF-8 text file. Returns numbered lines. Use offset/limit for large files.',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root' },
      offset: { type: 'integer', description: '1-based line to start from' },
      limit: { type: 'integer', description: `Max lines to return (default ${DEFAULT_LINE_LIMIT})` },
    },
    required: ['path'],
  },
  describeCall: (input) => input.path,
  async run({ path: p, offset = 1, limit = DEFAULT_LINE_LIMIT }, ctx) {
    const abs = resolveInWorkspace(ctx.roots ?? ctx.cwd, p);
    const lines = (await readText(abs)).split('\n');
    const start = Math.max(1, offset);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join('\n');
    const more = start - 1 + limit < lines.length
      ? `\n... (${lines.length} lines total; continue with offset=${start + limit})`
      : '';
    return body + more;
  },
};

export const writeFileTool = {
  name: 'write_file',
  description: 'Create or overwrite a file with the given content. Parent directories are created.',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['path', 'content'],
  },
  describeCall: (input) => input.path,
  async run({ path: p, content }, ctx) {
    const abs = resolveInWorkspace(ctx.roots ?? ctx.cwd, p);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return `wrote ${Buffer.byteLength(content)} bytes to ${p}`;
  },
};

export const editFileTool = {
  name: 'edit_file',
  description: 'Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Read the file first.',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root' },
      old_string: { type: 'string', description: 'Exact text to replace, including whitespace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  describeCall: (input) => input.path,
  async run({ path: p, old_string: oldStr, new_string: newStr, replace_all: all = false }, ctx) {
    if (oldStr === newStr) throw new Error('old_string and new_string are identical');
    if (oldStr === '') throw new Error('old_string must not be empty');
    const abs = resolveInWorkspace(ctx.roots ?? ctx.cwd, p);
    const text = await readText(abs);
    const count = text.split(oldStr).length - 1;
    if (count === 0) throw new Error('old_string not found in file');
    if (count > 1 && !all) {
      throw new Error(`old_string matches ${count} times; add surrounding context or set replace_all`);
    }
    // Slice-based replacement avoids String.replace's $-pattern expansion on user text.
    const next = all
      ? text.split(oldStr).join(newStr)
      : text.slice(0, text.indexOf(oldStr)) + newStr + text.slice(text.indexOf(oldStr) + oldStr.length);
    await writeFile(abs, next, 'utf8');
    return `edited ${p} (${all ? count : 1} replacement${count === 1 && !all ? '' : 's'})`;
  },
};

export const fileTools = [readFileTool, writeFileTool, editFileTool];
