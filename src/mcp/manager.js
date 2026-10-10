import { McpClient } from './client.js';

// Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for provider APIs.
export function sanitizeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

export function mcpToolName(server, tool) {
  return `mcp__${sanitizeName(server)}__${sanitizeName(tool)}`.slice(0, 64);
}

function toolFromMcp(client, server, spec, risk) {
  return {
    name: mcpToolName(server, spec.name),
    mcpName: spec.name,
    server,
    description: `[MCP ${server}] ${spec.description ?? spec.name}`,
    risk,
    parameters: spec.inputSchema?.type === 'object' ? spec.inputSchema : { type: 'object', properties: {} },
    describeCall: (input) => `${server}.${spec.name} ${JSON.stringify(input ?? {}).slice(0, 80)}`,
    async run(input, ctx) {
      if (ctx?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const res = await client.callTool(spec.name, input);
      const text = (res.content ?? [])
        .map((c) => (c.type === 'text' ? c.text : `[${c.type} content]`))
        .join('\n');
      if (res.isError) throw new Error(text || 'MCP tool reported an error');
      return text || '(no output)';
    },
  };
}

// Start every configured server. A failing server is reported and skipped, never fatal.
// servers: { name: { command, args?, env?, cwd?, disabled?, risk? } }
export async function startMcpServers(servers, { cwd, ui } = {}) {
  const clients = [];
  const tools = [];
  const status = [];

  for (const [name, spec] of Object.entries(servers ?? {})) {
    if (spec.disabled) {
      status.push({ name, state: 'disabled', tools: 0 });
      continue;
    }
    const client = new McpClient({ name, command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd ?? cwd });
    try {
      await client.start();
      const specs = await client.listTools();
      for (const t of specs) tools.push(toolFromMcp(client, name, t, spec.risk ?? 'exec'));
      clients.push(client);
      status.push({ name, state: 'connected', tools: specs.length, server: client.serverInfo });
    } catch (err) {
      await client.close().catch(() => {});
      status.push({ name, state: 'failed', tools: 0, error: err.message });
      ui?.warn(`MCP server "${name}" failed: ${err.message}`);
    }
  }

  return {
    tools,
    status,
    close: () => Promise.all(clients.map((c) => c.close())),
  };
}
