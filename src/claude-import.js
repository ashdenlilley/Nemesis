import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Claude Code permission rules -> Nemesis rules. Tools Nemesis has no equivalent for are skipped and counted.
const TOOL_MAP = {
  Bash: 'bash',
  Read: 'read_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  Write: 'write_file',
  Grep: 'grep',
  Glob: 'glob',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
};

export function mapClaudeRule(rule) {
  const m = /^\s*([A-Za-z]+)\s*(?:\((.*)\))?\s*$/.exec(String(rule ?? ''));
  const tool = m && TOOL_MAP[m[1]];
  if (!tool) return null;
  const pattern = m[2]?.trim().replace(/^\.\//, '');
  return pattern ? `${tool}(${pattern})` : tool;
}

// Reads ~/.claude/settings.json. Returns null when there is no such file.
export async function readClaudePermissions(home) {
  let data;
  try {
    data = JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8'));
  } catch {
    return null;
  }
  const perms = data.permissions ?? {};
  const convert = (list = []) => {
    const out = [];
    let skipped = 0;
    for (const rule of list) {
      const mapped = mapClaudeRule(rule);
      if (mapped) out.push(mapped);
      else skipped++;
    }
    return { rules: [...new Set(out)], skipped };
  };
  const allow = convert(perms.allow);
  const deny = convert(perms.deny);
  const ask = convert(perms.ask);
  return { allow: allow.rules, deny: deny.rules, ask: ask.rules, skipped: allow.skipped + deny.skipped + ask.skipped };
}
