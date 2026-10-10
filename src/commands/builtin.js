import { access, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_STYLES, PROVIDERS, saveUserConfig } from '../config.js';
import { setEnvKeys } from '../env.js';
import { compactSession, estimateTokens } from '../compact.js';
import { buildSystemPrompt } from '../prompt.js';
import { effectivePolicy } from '../permissions.js';
import { Session } from '../session.js';
import { runCommand } from '../tools/shell.js';
import { VERSION } from '../version.js';

const NOT_SUPPORTED = (name, hint) => ({ message: `/${name} is not available in Nemesis.${hint ? ` ${hint}` : ''}` });

async function canWrite(dir) {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, 2);
    return true;
  } catch {
    return false;
  }
}

function memoryFile(state) {
  return path.join(state.cwd, 'NEMESIS.md');
}

function transcriptMarkdown(session) {
  const parts = [`# Nemesis session ${session.id}\n`];
  for (const m of session.messages) {
    if (typeof m.content === 'string') {
      parts.push(`## ${m.role}\n\n${m.content}\n`);
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text') parts.push(`## ${m.role}\n\n${b.text}\n`);
      else if (b.type === 'tool_use') parts.push(`### tool: ${b.name}\n\n\`\`\`json\n${JSON.stringify(b.input, null, 2)}\n\`\`\`\n`);
      else if (b.type === 'tool_result') parts.push(`### result${b.is_error ? ' (error)' : ''}\n\n\`\`\`\n${String(b.content)}\n\`\`\`\n`);
    }
  }
  return parts.join('\n');
}

export function builtinCommands() {
  return [
    {
      name: 'help',
      description: 'Show all commands',
      run(_args, state) {
        const rows = state.registry.builtins.map((c) => `/${c.name.padEnd(18)} ${c.description}`);
        const custom = [...(state.custom?.values() ?? [])].map((c) => `/${c.name.padEnd(18)} ${c.description} (custom)`);
        state.ui.info([...rows, ...custom].join('\n'));
      },
    },
    {
      name: 'clear',
      aliases: ['reset', 'new'],
      description: 'Clear the conversation and start a new session',
      async run(_args, state) {
        state.setSession(await Session.create(state.sessionsDir));
        state.ui.info(`new session ${state.session.id}`);
      },
    },
    {
      name: 'compact',
      description: 'Summarize older turns to free context [instructions]',
      async run(args, state) {
        const r = await compactSession({ session: state.session, provider: state.provider, instructions: args });
        state.ui.info(r.compacted ? `compacted ${r.removed} messages; kept ${r.kept}` : r.reason);
      },
    },
    {
      name: 'context',
      description: 'Show estimated context usage',
      async run(_args, state) {
        const system = await buildSystemPrompt({ cwd: state.cwd, outputStyle: state.config.outputStyle });
        const sys = Math.ceil(system.length / 4);
        const msgs = estimateTokens('', state.session.messages);
        const window = state.config.contextWindow;
        const pct = (((sys + msgs) / window) * 100).toFixed(1);
        state.ui.info(`system ~${sys} tokens\nmessages ~${msgs} tokens (${state.session.messages.length} entries)\nwindow ${window} · ${pct}% used`);
      },
    },
    {
      name: 'cost',
      aliases: ['usage'],
      description: 'Show token usage for this run',
      run(_args, state) {
        const t = state.usage.totals();
        state.ui.info(`requests ${t.requests} · input ${t.input} · output ${t.output} · cache read ${t.cacheRead} · cache write ${t.cacheWrite} tokens`);
      },
    },
    {
      name: 'config',
      aliases: ['settings'],
      description: 'Show effective configuration',
      run(_args, state) {
        const shown = { ...state.config, apiKey: state.config.apiKey ? '(set)' : '(unset)' };
        state.ui.info(JSON.stringify(shown, null, 2));
      },
    },
    {
      name: 'doctor',
      description: 'Check installation, key, git, sessions, and MCP status',
      async run(_args, state) {
        const major = Number(process.versions.node.split('.')[0]);
        const git = await runCommand('git --version', { cwd: state.cwd, timeoutMs: 10_000 }).then((r) => r.code === 0).catch(() => false);
        const writable = await canWrite(state.sessionsDir);
        const connected = state.mcp.status.filter((s) => s.state === 'connected').length;
        const failed = state.mcp.status.filter((s) => s.state === 'failed');
        const checks = [
          [`node >= 20 (${process.versions.node})`, major >= 20],
          ['git on PATH', git],
          [`API key for ${state.config.provider} (${PROVIDERS[state.config.provider].keyEnv})`, Boolean(state.config.apiKey)],
          [`sessions dir writable (${state.sessionsDir})`, writable],
          [`MCP servers connected (${connected}/${state.mcp.status.length})`, failed.length === 0],
        ];
        state.ui.info(checks.map(([label, ok]) => `[${ok ? 'ok  ' : 'FAIL'}] ${label}`).join('\n'));
        for (const f of failed) state.ui.info(`  ${f.name}: ${f.error}`);
      },
    },
    {
      name: 'exit',
      aliases: ['quit'],
      description: 'Exit Nemesis',
      run(_args, state) {
        state.exit = true;
      },
    },
    {
      name: 'export',
      description: 'Export this session to Markdown [file]',
      async run(args, state) {
        const file = path.resolve(state.cwd, args || `nemesis-${state.session.id}.md`);
        await writeFile(file, transcriptMarkdown(state.session), 'utf8');
        state.ui.info(`exported to ${file}`);
      },
    },
    {
      name: 'hooks',
      description: 'List configured hooks',
      run(_args, state) {
        const table = state.hooks.list();
        const lines = Object.entries(table).flatMap(([event, groups]) =>
          groups.map((g) => `${event}${g.matcher ? ` [${g.matcher}]` : ''}: ${(g.hooks ?? []).map((h) => h.command).join(' ; ')}`));
        state.ui.info(lines.length ? lines.join('\n') : 'no hooks configured (add a "hooks" section to .nemesis/config.json)');
      },
    },
    {
      name: 'init',
      description: 'Analyze this repo and write NEMESIS.md',
      run() {
        return {
          prompt: 'Explore this repository and create NEMESIS.md at the project root. Cover: build, test, and lint commands; architecture overview; key directories; conventions; and non-obvious gotchas. Verify each command before recording it. Keep the file under 150 lines and write it with write_file.',
        };
      },
    },
    {
      name: 'login',
      description: 'Set or change provider, model, and API key',
      async run(_args, state) {
        if (!state.rl) throw new Error('/login needs an interactive terminal');
        await state.onboard();
        state.ui.info(`now using ${state.config.provider}/${state.config.model}`);
      },
    },
    {
      name: 'logout',
      description: 'Remove the saved API key for the active provider',
      async run(_args, state) {
        const { keyEnv } = PROVIDERS[state.config.provider];
        await setEnvKeys({ [keyEnv]: null }, { home: state.home });
        state.config.apiKey = null;
        state.ui.info(`removed ${keyEnv} from ~/.nemesis/.env. Run /login to add a key again.`);
      },
    },
    {
      name: 'mcp',
      description: 'Show MCP servers and their tools',
      run(_args, state) {
        if (state.mcp.status.length === 0) {
          state.ui.info('no MCP servers configured (add "mcpServers" to .nemesis/config.json)');
          return;
        }
        const lines = state.mcp.status.map((s) => `${s.name}: ${s.state}${s.error ? ` (${s.error})` : ` · ${s.tools} tools`}`);
        const names = state.mcp.tools.map((t) => `  ${t.name}`);
        state.ui.info([...lines, ...names].join('\n'));
      },
    },
    {
      name: 'memory',
      description: 'Show NEMESIS.md, or /memory add <note> to append a note',
      async run(args, state) {
        const file = memoryFile(state);
        if (args.startsWith('add ')) {
          const note = args.slice(4).trim();
          const existing = await readFile(file, 'utf8').catch(() => '');
          await writeFile(file, `${existing.trimEnd()}${existing ? '\n' : ''}- ${note}\n`, 'utf8');
          state.ui.info(`added to ${file}`);
          return;
        }
        const text = await readFile(file, 'utf8').catch(() => null);
        state.ui.info(text === null ? `no ${file} yet. Run /init or /memory add <note>.` : `${file}\n\n${text}`);
      },
    },
    {
      name: 'model',
      description: 'Show or change the model [name]; remembered per provider',
      async run(args, state) {
        if (args) {
          state.config.model = args;
          await saveUserConfig({ profiles: { [state.config.provider]: { model: args } } }, state.home);
        }
        state.ui.info(`model: ${state.config.provider}/${state.config.model}`);
      },
    },
    {
      name: 'output-style',
      description: `Set output style: ${OUTPUT_STYLES.join(', ')}`,
      async run(args, state) {
        if (!args) {
          state.ui.info(`output style: ${state.config.outputStyle}`);
          return;
        }
        if (!OUTPUT_STYLES.includes(args)) throw new Error(`unknown style "${args}" (use ${OUTPUT_STYLES.join(', ')})`);
        state.config.outputStyle = args;
        await saveUserConfig({ outputStyle: args }, state.home);
        state.ui.info(`output style: ${args}`);
      },
    },
    {
      name: 'permissions',
      aliases: ['allowed-tools'],
      description: 'Show or set per-tool rules: /permissions allow|deny|ask <tool>|reset',
      run(args, state) {
        const [verb, tool] = args.split(/\s+/);
        if (verb === 'reset') {
          for (const name of Object.keys(state.permissions.getRules())) state.permissions.setRule(name, 'ask');
        } else if (['allow', 'deny', 'ask'].includes(verb) && tool) {
          state.permissions.setRule(tool, verb);
        } else if (verb) {
          throw new Error('usage: /permissions allow|deny|ask <tool> | /permissions reset');
        }
        const rules = Object.entries(state.permissions.getRules()).map(([t, m]) => `  ${t}: ${m}`);
        state.ui.info(`policy: ${JSON.stringify(state.permissions.getPolicy())}\nrules:${rules.length ? `\n${rules.join('\n')}` : ' (none)'}`);
      },
    },
    {
      name: 'plan',
      description: 'Toggle plan mode (read-only tools only)',
      run(_args, state) {
        state.planMode = !state.planMode;
        state.permissions.setPolicy(effectivePolicy({ config: state.config, planMode: state.planMode, readOnly: state.args.readOnly }));
        state.ui.info(`plan mode ${state.planMode ? 'on: write and exec tools are disabled' : 'off'}`);
      },
    },
    {
      name: 'agents',
      description: 'List sub-agents available to the task tool',
      run(_args, state) {
        const lines = [...state.agents.values()].map((a) => {
          const tools = a.tools === '*' ? 'all tools' : a.tools.join(', ');
          return `${a.name.padEnd(12)} ${a.description} [${tools}]`;
        });
        state.ui.info(lines.join('\n'));
      },
    },
    {
      name: 'add-dir',
      description: 'Allow tools to access another directory [path]',
      run(args, state) {
        if (!args) throw new Error('usage: /add-dir <path>');
        const abs = path.resolve(state.cwd, args);
        if (!state.roots.includes(abs)) state.roots.push(abs);
        state.ui.info(`workspace roots: ${state.roots.join(', ')}`);
      },
    },
    {
      name: 'resume',
      aliases: ['continue'],
      description: 'List recent sessions, or /resume <id> to switch',
      async run(args, state) {
        if (!args) {
          const sessions = (await Session.list(state.sessionsDir)).slice(0, 10);
          const lines = sessions.map((s) => `${s.id === state.session.id ? '*' : ' '} ${s.id}`);
          state.ui.info(lines.length ? lines.join('\n') : 'no saved sessions');
          return;
        }
        const id = args.replace(/\.jsonl$/, '');
        const file = path.join(state.sessionsDir, `${id}.jsonl`);
        state.setSession(await Session.open(file));
        state.ui.info(`resumed ${id} (${state.session.messages.length} messages)`);
      },
    },
    {
      name: 'review',
      description: 'Review uncommitted changes [focus]',
      run(args) {
        return {
          prompt: `Review the uncommitted changes in this repository (git status, git diff HEAD, and untracked files). Look for correctness bugs, security problems, and missing tests. Report findings by severity with file:line references.${args ? ` Focus: ${args}` : ''}`,
        };
      },
    },
    {
      name: 'pr_comments',
      description: 'Fetch and address PR review comments [pr-number]',
      run(args) {
        return {
          prompt: `Fetch review comments for pull request ${args || '(the PR for the current branch)'} using the gh CLI (gh pr view --comments, gh api). Summarize each unresolved comment, then apply the fixes that are clearly correct and list the rest.`,
        };
      },
    },
    {
      name: 'status',
      description: 'Show version, model, session, and policy',
      run(_args, state) {
        state.ui.info([
          `version      ${VERSION}`,
          `provider     ${state.config.provider}/${state.config.model}`,
          `session      ${state.session.id}`,
          `cwd          ${state.cwd}`,
          `roots        ${state.roots.join(', ')}`,
          `plan mode    ${state.planMode ? 'on' : 'off'}`,
          `output style ${state.config.outputStyle}`,
          `tools        ${state.tools.length} (${state.mcp.tools.length} from MCP)`,
          `hooks        ${state.hooks.count()}`,
        ].join('\n'));
      },
    },
    {
      name: 'bug',
      aliases: ['feedback'],
      description: 'Show how to report a bug',
      run(_args, state) {
        state.ui.info(`Report the problem with the steps you ran. Attach the session file: ${state.session.file ?? '(in-memory)'}`);
      },
    },
    {
      name: 'release-notes',
      description: 'Show the current version',
      run(_args, state) {
        state.ui.info(`Nemesis ${VERSION}. Release history is in git log.`);
      },
    },
    {
      name: 'version',
      description: 'Show the version',
      run(_args, state) {
        state.ui.info(`nemesis ${VERSION}`);
      },
    },
    {
      name: 'ide',
      description: 'IDE integration',
      run(_args, state) { state.ui.info(NOT_SUPPORTED('ide', 'Use the terminal alongside your editor.').message); },
    },
    {
      name: 'install-github-app',
      description: 'GitHub app setup',
      run(_args, state) { state.ui.info(NOT_SUPPORTED('install-github-app', 'Use the gh CLI for GitHub operations.').message); },
    },
    {
      name: 'terminal-setup',
      description: 'Terminal keybinding setup',
      run(_args, state) { state.ui.info(NOT_SUPPORTED('terminal-setup').message); },
    },
    {
      name: 'upgrade',
      description: 'Upgrade instructions',
      run(_args, state) { state.ui.info(NOT_SUPPORTED('upgrade', 'Update the repository with git pull.').message); },
    },
    {
      name: 'vim',
      description: 'Vim input mode',
      run(_args, state) { state.ui.info(NOT_SUPPORTED('vim').message); },
    },
    {
      name: 'todos',
      description: 'Show the task list the agent keeps this session',
      run(_args, state) {
        const last = [...state.session.messages].reverse().find((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use' && b.name === 'todo_write'));
        if (!last) return state.ui.info('no task list yet');
        const use = last.content.find((b) => b.type === 'tool_use' && b.name === 'todo_write');
        state.ui.info((use.input.todos ?? []).map((t) => `[${t.status ?? 'pending'}] ${t.content}`).join('\n') || 'empty');
      },
    },
  ];
}
