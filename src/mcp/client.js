import { spawn } from 'node:child_process';
import path from 'node:path';

// MCP over stdio: newline-delimited JSON-RPC 2.0 on the child's stdin/stdout.
const PROTOCOL_VERSION = '2024-11-05';

export class McpClient {
  constructor({ name, command, args = [], env = {}, cwd, timeoutMs = 30_000 }) {
    Object.assign(this, { name, command, args, env, cwd, timeoutMs });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = '';
    this.child = null;
    this.serverInfo = null;
  }

  async start() {
    const isWin = process.platform === 'win32';
    // Shell mode only for bare names on Windows (npx, uvx resolve to .cmd shims there).
    const useShell = isWin && !path.isAbsolute(this.command);
    // Shell mode concatenates the command line, so paths with spaces need quotes.
    const command = useShell && this.command.includes(' ') && !this.command.startsWith('"')
      ? `"${this.command}"`
      : this.command;
    this.child = spawn(command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000); });
    this.child.stdin.on('error', (err) => this.#failAll(err));
    this.child.on('error', (err) => this.#failAll(err));
    this.child.on('exit', (code) => {
      const last = this.stderrTail.trim().split('\n').at(-1);
      this.#failAll(new Error(`server exited (code ${code})${last ? `: ${last}` : ''}`));
    });

    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nemesis', version: '0.9.0' },
    });
    this.serverInfo = init.serverInfo ?? {};
    this.notify('notifications/initialized');
    return init;
  }

  #onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line) this.#handle(line);
    }
  }

  #handle(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stray stdout noise from the server; ignore
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else waiter.resolve(msg.result ?? {});
    } else if (msg.method !== undefined && msg.id !== undefined) {
      // Server-to-client request: answer ping, refuse the rest (we expose no client features).
      const reply = msg.method === 'ping'
        ? { result: {} }
        : { error: { code: -32601, message: `unsupported: ${msg.method}` } };
      this.#send({ jsonrpc: '2.0', id: msg.id, ...reply });
    }
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.#send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  #send(obj) {
    if (!this.child?.stdin.writable) throw new Error(`server ${this.name} is not running`);
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  #failAll(err) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const res = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(res.tools ?? []));
      cursor = res.nextCursor;
    } while (cursor);
    return tools;
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args ?? {} }, Math.max(this.timeoutMs, 120_000));
  }

  async close() {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      this.child.stdin.end();
      this.child.kill();
    }
  }
}
