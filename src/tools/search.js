import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_DIRS, resolveInWorkspace, toPosix } from './paths.js';

const MAX_GLOB_RESULTS = 500;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;

// Glob to RegExp: ** crosses directories, * and ? stay within one segment.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

// Yields absolute file paths under root, skipping ignored directories.
export async function* walkFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // unreadable directory: skip silently
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield* walkFiles(path.join(root, entry.name));
    } else if (entry.isFile()) {
      yield path.join(root, entry.name);
    }
  }
}

export const globTool = {
  name: 'glob',
  description: 'Find files by glob pattern (e.g. "src/**/*.js"). Skips node_modules and .git.',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern relative to base path' },
      path: { type: 'string', description: 'Base directory, default workspace root' },
    },
    required: ['pattern'],
  },
  pathTarget: true,
  describeCall: (input) => input.pattern,
  async run({ pattern, path: base = '.' }, ctx) {
    const root = resolveInWorkspace(ctx.roots ?? ctx.cwd, base);
    const re = globToRegExp(pattern);
    const hits = [];
    for await (const file of walkFiles(root)) {
      const rel = toPosix(path.relative(root, file));
      if (re.test(rel)) {
        hits.push(rel);
        if (hits.length >= MAX_GLOB_RESULTS) break;
      }
    }
    hits.sort();
    if (hits.length === 0) return 'no files matched';
    const note = hits.length >= MAX_GLOB_RESULTS ? `\n(truncated at ${MAX_GLOB_RESULTS})` : '';
    return hits.join('\n') + note;
  },
};

export const grepTool = {
  name: 'grep',
  description: 'Search file contents with a JavaScript regular expression. Returns file:line: text.',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression' },
      path: { type: 'string', description: 'Directory or file to search, default workspace root' },
      glob: { type: 'string', description: 'Only search files whose relative path matches this glob' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive match' },
    },
    required: ['pattern'],
  },
  pathTarget: true,
  describeCall: (input) => input.pattern,
  async run({ pattern, path: base = '.', glob, ignore_case: ignoreCase = false }, ctx) {
    let re;
    try {
      re = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (err) {
      throw new Error(`invalid regular expression: ${err.message}`);
    }
    const target = resolveInWorkspace(ctx.roots ?? ctx.cwd, base);
    const fileFilter = glob ? globToRegExp(glob) : null;
    const info = await stat(target);
    const files = info.isFile() ? [target] : walkFiles(target);

    const out = [];
    for await (const file of files) {
      const rel = toPosix(path.relative(target, file)) || path.basename(file);
      if (fileFilter && !fileFilter.test(rel)) continue;
      const fileInfo = await stat(file);
      if (fileInfo.size > MAX_GREP_FILE_BYTES) continue;
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null || text.includes('\0')) continue;

      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push(`${toPosix(path.relative(ctx.cwd, file))}:${i + 1}: ${lines[i].trim()}`);
          if (out.length >= MAX_GREP_MATCHES) return out.join('\n') + `\n(truncated at ${MAX_GREP_MATCHES})`;
        }
      }
    }
    return out.length ? out.join('\n') : 'no matches';
  },
};

export const searchTools = [globTool, grepTool];
