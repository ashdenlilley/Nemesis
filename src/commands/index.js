import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import { builtinCommands } from './builtin.js';

// Slash command contract:
//   { name, aliases?: string[], description, run(args, state) -> void | { prompt } }
// Returning { prompt } sends that text to the model as a user turn (used by /init, /review, custom commands).

export function parseSlash(line) {
  const body = line.slice(1).trim();
  const space = body.search(/\s/);
  const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const args = space === -1 ? '' : body.slice(space + 1).trim();
  return { name, args };
}

// Markdown files in .nemesis/commands (project) and ~/.nemesis/commands (user).
// Project overrides user. $ARGUMENTS in the body is replaced with the typed arguments.
export async function loadCustomCommands(dirs) {
  const commands = new Map();
  for (const dir of dirs) {
    let names;
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
    } catch {
      continue;
    }
    for (const file of names) {
      const { data, body } = parseFrontmatter(await readFile(path.join(dir, file), 'utf8'));
      const name = path.basename(file, '.md').toLowerCase();
      commands.set(name, { name, description: data.description ?? 'custom command', body });
    }
  }
  return commands;
}

export function createCommandRegistry(state) {
  const builtins = new Map();
  for (const cmd of builtinCommands()) {
    builtins.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) builtins.set(alias, cmd);
  }
  return {
    builtins: builtinCommands(),
    async dispatch(line) {
      const { name, args } = parseSlash(line);
      const cmd = builtins.get(name);
      if (cmd) {
        const result = await cmd.run(args, state);
        return { handled: true, prompt: result?.prompt ?? null };
      }
      const custom = state.custom?.get(name);
      if (custom) {
        return { handled: true, prompt: custom.body.replaceAll('$ARGUMENTS', args) };
      }
      return { handled: false, error: `unknown command /${name}; try /help` };
    },
    allNames() {
      return [...builtinCommands().map((c) => c.name), ...(state.custom?.keys() ?? [])];
    },
  };
}
