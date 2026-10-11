import { readSSE } from '../providers/sse.js';

// MCP over Streamable HTTP: each JSON-RPC message is a POST to one URL. The reply is either a JSON body
// or an SSE stream that carries the response. The server may return an Mcp-Session-Id to echo back.
const PROTOCOL_VERSION = '2024-11-05';

// ${VAR} in header values is replaced from the environment, so tokens stay out of config.json.
export function expandHeaders(headers = {}, env = process.env) {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [
    k,
    String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env[name] ?? ''),
  ]));
}

// Reads an SSE reply until the message with `id` arrives.
async function sseReply(res, id) {
  for await (const { data } of readSSE(res, { idleMs: 120_000 })) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      continue;
    }
    if (msg.id === id) return msg;
  }
  throw new Error('server closed the stream before answering');
}

export class McpHttpClient {
  constructor({ name, url, headers = {}, auth = null, timeoutMs = 30_000, fetchImpl = fetch }) {
    Object.assign(this, { name, url, headers: expandHeaders(headers), auth, timeoutMs, fetchImpl });
    this.nextId = 1;
    this.sessionId = null;
    this.serverInfo = null;
  }

  async #post(body, id, timeoutMs, retried = false) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.headers,
    };
    const token = await this.auth?.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 401) {
      await res.body?.cancel();
      if (this.auth && !retried && (await this.auth.refresh())) return this.#post(body, id, timeoutMs, true);
      throw new Error(`${this.name} needs login: run /mcp login ${this.name}`);
    }
    if (id === null || res.status === 202) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) return sseReply(res, id);
    return res.json();
  }

  async request(method, params, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    const msg = await this.#post({ jsonrpc: '2.0', id, method, params }, id, timeoutMs);
    if (!msg) throw new Error(`${method}: no reply`);
    if (msg.error) throw new Error(`${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg.result ?? {};
  }

  async notify(method, params) {
    await this.#post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, null, this.timeoutMs);
  }

  async start() {
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nemesis', version: '0.10.0' },
    });
    this.serverInfo = init.serverInfo ?? {};
    await this.notify('notifications/initialized');
    return init;
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
    if (!this.sessionId) return;
    const headers = { ...this.headers, 'mcp-session-id': this.sessionId };
    const token = await this.auth?.token().catch(() => null);
    if (token) headers.authorization = `Bearer ${token}`;
    await this.fetchImpl(this.url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5_000) })
      .then((r) => r.body?.cancel())
      .catch(() => {});
  }
}
