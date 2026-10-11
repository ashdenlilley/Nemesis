import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// File snapshots for /rewind. Before write_file or edit_file changes a file, its previous content is kept,
// once per user turn (the first change in that turn). Files changed by shell commands are not tracked.
// Stored per session in <dir>/<session id>.json, so rewinding still works after a restart.
export class Checkpoints {
  constructor(dir, sessionId) {
    this.dir = dir;
    this.sessionId = sessionId;
    this.turns = []; // { messageIndex, prompt, files: { [absPath]: previousContent | null } }
    this.current = null; // the turn in progress
    this.ready = readFile(this.file, 'utf8')
      .then((text) => { this.turns = JSON.parse(text); })
      .catch(() => {});
  }

  get file() {
    return path.join(this.dir, `${this.sessionId}.json`);
  }

  // A new user turn. messageIndex is where its prompt sits in the session, so the conversation can be cut there.
  async begin(messageIndex, prompt) {
    await this.ready;
    this.current = { messageIndex, prompt: prompt.trim().slice(0, 200), files: {} };
    this.turns.push(this.current);
  }

  // Called before a file changes. Keeps the content from before the turn's first change to it.
  async record(absPath) {
    await this.ready;
    if (!this.current || absPath in this.current.files) return;
    this.current.files[absPath] = await readFile(absPath, 'utf8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    await this.save();
  }

  async save() {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file, JSON.stringify(this.turns), 'utf8');
  }

  // Turns newest first, each with its index into this.turns.
  async list() {
    await this.ready;
    return this.turns.map((t, i) => ({ ...t, i, count: Object.keys(t.files).length })).reverse();
  }

  // Puts every file changed in turns i and later back to its content before turn i. Returns the file count.
  async restoreFiles(i) {
    await this.ready;
    const earliest = new Map();
    for (let k = i; k < this.turns.length; k++) {
      for (const [abs, content] of Object.entries(this.turns[k].files)) {
        if (!earliest.has(abs)) earliest.set(abs, content);
      }
    }
    for (const [abs, content] of earliest) {
      if (content === null) await unlink(abs).catch(() => {});
      else await writeFile(abs, content, 'utf8');
    }
    return earliest.size;
  }

  // Forget turn i and later, after the conversation was cut back to before it.
  async dropFrom(i) {
    await this.ready;
    this.turns = this.turns.slice(0, i);
    this.current = null;
    await this.save();
  }
}
