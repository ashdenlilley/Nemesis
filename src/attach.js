import { readdirSync } from 'node:fs';
import { readFile, stat as statAsync } from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_DIRS, resolveInWorkspace } from './tools/paths.js';

// @path mentions in a prompt. Text files are inlined in the message; images become image blocks.
// Paths outside the workspace and missing paths are left exactly as typed.
export const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_TEXT_BYTES = 200_000;
const MAX_IMAGE_BYTES = 5_000_000;
const MENTION = /(^|\s)@([^\s@]+)/g;

export function mentionsIn(text) {
  return [...String(text).matchAll(MENTION)].map((m) => m[2]);
}

// Message content for a prompt: a plain string, or [image blocks..., text] when images are attached.
export async function buildUserContent(text, { roots }) {
  const images = [];
  const files = [];
  for (const ref of new Set(mentionsIn(text))) {
    let abs;
    let info;
    try {
      abs = resolveInWorkspace(roots, ref);
      info = await statAsync(abs);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
    if (type) {
      if (info.size > MAX_IMAGE_BYTES) throw new Error(`image too large (over ${MAX_IMAGE_BYTES / 1e6} MB): ${ref}`);
      const data = (await readFile(abs)).toString('base64');
      images.push({ type: 'image', source: { type: 'base64', media_type: type, data } });
      continue;
    }
    const body = (await readFile(abs)).subarray(0, MAX_TEXT_BYTES);
    if (body.includes(0)) continue; // binary, not inlined
    files.push(`<file path="${ref}">\n${body.toString('utf8')}\n</file>`);
  }
  const full = files.length ? `${text}\n\n${files.join('\n\n')}` : text;
  return images.length ? [...images, { type: 'text', text: full }] : full;
}

// Completions for an @ token at the end of the text: files and folders in the directory it names.
// Synchronous, because the line editor asks for completions on every key.
export function mentionCompletions(text, { cwd }) {
  const m = /(^|\s)@([^\s]*)$/.exec(text);
  if (!m) return [];
  const token = m[2];
  const slash = token.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : token.slice(0, slash + 1);
  const base = token.slice(slash + 1).toLowerCase();
  let dir;
  let entries;
  try {
    dir = resolveInWorkspace(cwd, dirPart || '.');
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.name.toLowerCase().startsWith(base) && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 20)
    .map((e) => {
      const rel = dirPart + e.name + (e.isDirectory() ? '/' : '');
      return {
        name: `@${rel}`,
        description: e.isDirectory() ? 'folder' : '',
        apply: (t) => t.slice(0, t.length - token.length) + rel + (e.isDirectory() ? '' : ' '),
      };
    });
}
