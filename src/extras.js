import { mkdir, appendFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { nemesisHome } from './config.js';
import { shellInvocation } from './tools/shell.js';

// ---------- prompt history (~/.nemesis/history.txt, one JSON string per line) ----------

export const historyFile = (home) => path.join(nemesisHome(home), 'history.txt');
const HISTORY_MAX = 500;

export async function loadHistory(home) {
  let text;
  try {
    text = await readFile(historyFile(home), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (typeof value === 'string') out.push(value);
    } catch {
      // a damaged line is skipped, not fatal
    }
  }
  return out.slice(-HISTORY_MAX);
}

export async function appendHistory(home, text) {
  await mkdir(nemesisHome(home), { recursive: true });
  await appendFile(historyFile(home), `${JSON.stringify(text)}\n`, 'utf8');
}

// ---------- shell and note modes ----------

// Output of a command typed after "!": shown to the user and kept as context for the model.
export function shellNote(command, { code, timedOut, output }) {
  const status = timedOut ? 'timed out' : `exit ${code}`;
  return `I ran \`${command}\` in the shell (${status}):\n${output.trimEnd()}`;
}

// "#text" appends a line to NEMESIS.md, which is loaded into the system prompt on every turn.
export async function appendNote(cwd, text) {
  const file = path.join(cwd, 'NEMESIS.md');
  let prefix = '';
  try {
    const existing = await readFile(file, 'utf8');
    prefix = existing.endsWith('\n') ? '' : '\n';
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await writeFile(file, '', 'utf8');
  }
  await appendFile(file, `${prefix}- ${text.trim()}\n`, 'utf8');
  return file;
}

// ---------- status line ----------

// Runs the user's statusLine command with a JSON description on stdin; returns its first line, or null.
export function runStatusLine(command, payload, { cwd, timeoutMs = 2000 } = {}) {
  const { file, args } = shellInvocation(command);
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.split('\n')[0].trim() || null);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

// ---------- session titles ----------

// The title is a sidecar file <id>.title, or the first user message when none was set.
const titlePath = (dir, id) => path.join(dir, `${id}.title`);

export async function renameSession(dir, id, title) {
  await writeFile(titlePath(dir, id), `${title.trim()}\n`, 'utf8');
}

export async function sessionSummaries(dir, limit = 20) {
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort().reverse().slice(0, limit);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const id = path.basename(name, '.jsonl');
    const file = path.join(dir, name);
    let title = null;
    try {
      title = (await readFile(titlePath(dir, id), 'utf8')).trim() || null;
    } catch {
      // no sidecar
    }
    if (!title) title = await firstUserMessage(file);
    const info = await stat(file).catch(() => null);
    out.push({ id, file, title: title ?? '(empty session)', modified: info?.mtime ?? null });
  }
  return out;
}

async function firstUserMessage(file) {
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.role !== 'user') continue;
    const body = typeof msg.content === 'string'
      ? msg.content
      : (msg.content ?? []).find((b) => b.type === 'text')?.text ?? '';
    if (body.trim()) return body.trim().replace(/\s+/g, ' ').slice(0, 60);
  }
  return null;
}
