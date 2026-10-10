import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// Append-only JSONL transcript. One line per message, so a crash loses at most one turn.
// A session with file === null is in-memory only (used by sub-agents).
export class Session {
  constructor({ id, file, messages = [] }) {
    this.id = id;
    this.file = file;
    this.messages = messages;
  }

  static newId() {
    // Timestamp-prefixed ids sort chronologically by file name.
    return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  }

  static async create(dir) {
    await mkdir(dir, { recursive: true });
    const id = Session.newId();
    return new Session({ id, file: path.join(dir, `${id}.jsonl`) });
  }

  static memory() {
    return new Session({ id: `sub-${randomBytes(3).toString('hex')}`, file: null });
  }

  static async open(file) {
    const text = await readFile(file, 'utf8');
    const messages = text
      .split('\n')
      .filter((line) => line.trim())
      .map((line, i) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new Error(`corrupt session ${file} at line ${i + 1}`);
        }
      });
    return new Session({ id: path.basename(file, '.jsonl'), file, messages });
  }

  // Newest first. Only *.jsonl files count, so archives (*.bak-*) are ignored.
  static async list(dir) {
    let names;
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort().reverse();
    } catch {
      return [];
    }
    return names.map((n) => ({ id: path.basename(n, '.jsonl'), file: path.join(dir, n) }));
  }

  static async latest(dir) {
    const [first] = await Session.list(dir);
    return first ? Session.open(first.file) : null;
  }

  async append(message) {
    this.messages.push(message);
    if (this.file) await appendFile(this.file, `${JSON.stringify(message)}\n`, 'utf8');
  }

  // Replace the whole transcript (used by compaction). Keeps a .bak copy when archive is set.
  async replace(messages, { archive = false } = {}) {
    if (this.file) {
      if (archive) await copyFile(this.file, `${this.file}.bak-${Date.now()}`);
      await writeFile(this.file, messages.map((m) => `${JSON.stringify(m)}\n`).join(''), 'utf8');
    }
    this.messages = messages;
  }
}
