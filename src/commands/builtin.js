import { access, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { EFFORT_LEVELS, OUTPUT_STYLES, PROVIDERS, REASONING_MODES, saveUserConfig } from '../config.js';
import { setEnvKeys } from '../env.js';
import { compactSession, estimateTokens } from '../compact.js';
import { buildSystemPrompt } from '../prompt.js';
import { effectivePolicy, parseRuleSpec } from '../permissions.js';
import { renameSession, sessionSummaries } from '../extras.js';
import { manageProfile, profileSummary, removeUserProfile, renameProfile } from '../profiles.js';
import { jobSummary } from '../jobs.js';
import { clipboardImage } from '../clipboard.js';
import { login } from '../mcp/oauth.js';
import { SANDBOX_MODES } from '../sandbox.js';
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

// "200k", "1m", "128000" -> tokens. NaN when it is not a size.
export function parseTokenCount(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text.trim());
  if (!m) return NaN;
  const scale = { '': 1, k: 1_000, m: 1_000_000 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * scale);
}

// Save a setting for the active provider (profiles.<provider>) and apply it to this session.
// A command-line flag for the same setting no longer overrides it.
async function setProfileSetting(state, key, value) {
  state.config[key] = value;
  delete state.overrides[key];
  await saveUserConfig({ profiles: { [state.config.profile]: { [key]: value } } }, state.home);
}

// One row per profile and model: profiles with no model list show their current model.
export function profileModelRows(profiles = {}, current = {}) {
  const rows = [];
  for (const [name, raw] of Object.entries(profiles)) {
    const entry = !raw.provider && PROVIDERS[name] ? { ...raw, provider: name } : raw;
    const provider = entry.provider ?? name;
    const models = entry.models?.length ? entry.models : [entry.model ?? PROVIDERS[provider]?.defaultModel].filter(Boolean);
    for (const model of models) {
      const here = name === current.profile && model === current.model;
      rows.push({ name, model, provider, label: `${name} · ${provider}/${model}${here ? '  (current)' : ''}` });
    }
  }
  return rows;
}

// Make a profile active, optionally with a model. Clears command-line overrides, as /login does.
export async function switchProfile(state, name, model = null) {
  if (!state.config.profiles?.[name] && !PROVIDERS[name]) throw new Error(`no profile "${name}"; see /profile`);
  const patch = { activeProfile: name };
  if (model) patch.profiles = { [name]: { model } };
  await saveUserConfig(patch, state.home);
  state.overrides = state.overrides.maxSteps ? { maxSteps: state.overrides.maxSteps } : {};
  await state.reload();
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
        const r = await compactSession({ session: state.session, provider: state.provider, instructions: args, signal: state.controller?.signal });
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
        const { keyEnv } = state.config;
        await setEnvKeys({ [keyEnv]: null }, { home: state.home, env: process.env });
        state.config.apiKey = null;
        state.ui.info(`removed ${keyEnv} from ~/.nemesis/.env. Run /login to add a key again.`);
      },
    },
    {
      name: 'mcp',
      description: 'Show MCP servers and their tools; /mcp login <name> signs in to a remote server',
      async run(args, state) {
        const [verb, name] = args.split(/\s+/);
        if (verb === 'login') {
          const spec = state.config.mcpServers?.[name];
          if (!spec?.url) throw new Error(`usage: /mcp login <name> (a remote server with "url" in mcpServers)`);
          await login({ name, serverUrl: spec.url, home: state.home, ui: state.ui, clientId: spec.oauth?.clientId ?? null });
          state.ui.info(`signed in to ${name}; reconnecting`);
          await state.reconnectMcp();
        }
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
      description: 'Pick a profile and model [name sets the model of the current profile]',
      async run(args, state) {
        if (args) {
          const models = [...new Set([...(state.config.models ?? []), args])];
          state.config.model = args;
          await saveUserConfig({ profiles: { [state.config.profile]: { model: args, models } } }, state.home);
          state.ui.info(`model: ${state.config.profile} · ${state.config.provider}/${state.config.model}`);
          return;
        }
        if (!state.rl?.choose) {
          state.ui.info(`model: ${state.config.profile} · ${state.config.provider}/${state.config.model}`);
          return;
        }
        const rows = profileModelRows(state.config.profiles, state.config);
        const picked = await state.rl.choose({
          title: 'Switch profile and model',
          options: [...rows.map((r) => r.label), 'Type a model for the current profile'],
        });
        if (picked < 0) return;
        if (picked === rows.length) {
          const typed = (await state.rl.question('Model: ')).trim();
          if (!typed) return;
          return builtinCommands().find((c) => c.name === 'model').run(typed, state);
        }
        await switchProfile(state, rows[picked].name, rows[picked].model);
        state.ui.info(`now using ${rows[picked].name} · ${state.config.provider}/${state.config.model}`);
      },
    },
    {
      name: 'sandbox',
      description: `Show or set the sandbox: ${SANDBOX_MODES.join(' | ')}`,
      async run(args, state) {
        const mode = args.trim().toLowerCase();
        if (mode) {
          if (!SANDBOX_MODES.includes(mode)) throw new Error(`usage: /sandbox ${SANDBOX_MODES.join('|')}`);
          state.config.sandbox = mode;
          await saveUserConfig({ sandbox: mode }, state.home);
        }
        state.ui.info(state.config.sandbox === 'strict'
          ? 'sandbox: strict. Shell commands get no API keys or tokens, and network-looking commands are refused (a guardrail, not isolation).'
          : 'sandbox: off');
      },
    },
    {
      name: 'skills',
      description: 'List skills from ~/.nemesis/skills and .nemesis/skills',
      run(_args, state) {
        if (!state.skills.size) {
          state.ui.info('no skills. Add a folder with SKILL.md under .nemesis/skills/<name>/');
          return;
        }
        state.ui.info([...state.skills.values()].map((s) => `${s.name.padEnd(18)} ${s.description}`).join('\n'));
      },
    },
    {
      name: 'profile',
      aliases: ['profiles'],
      description: 'List profiles; /profile use|add|edit|rm <name>',
      async run(args, state) {
        const words = args.trim().split(/\s+/);
        const [verb = '', name = ''] = words;
        const profiles = state.config.profiles ?? {};
        const current = () => `${state.config.profile} · ${state.config.provider}/${state.config.model}`;
        if (!verb) {
          state.ui.info(`${profileSummary(profiles, state.config.profile)}\nactive: ${current()}`);
          return;
        }
        if (verb === 'rename') {
          const to = (words[2] ?? '').toLowerCase();
          if (!name || !to) throw new Error('usage: /profile rename <old> <new>');
          const result = await renameProfile({ home: state.home, env: process.env, from: name, to });
          state.ui.info(`renamed ${result.from} to ${result.to}${result.keyMoved ? ' (key moved)' : ''}`);
          await state.reload();
          return;
        }
        if (verb === 'use') {
          if (!name) throw new Error('usage: /profile use <name>');
          await switchProfile(state, name);
          state.ui.info(`now using ${current()}`);
          return;
        }
        if (!state.rl?.choose) throw new Error(`/profile ${verb} needs an interactive terminal`);
        const ask = async (title) => (await state.rl.choose({ title, options: ['Yes', 'No'] })) === 0;
        if (verb === 'add') {
          const saved = await manageProfile({ rl: state.rl, ui: state.ui, home: state.home, takenNames: Object.keys(profiles) });
          state.ui.info(`saved profile ${saved.name}`);
          // Reload first: the new profile is not in the config this session loaded at startup.
          await state.reload();
          if (await ask(`Switch to ${saved.name} now?`)) await switchProfile(state, saved.name);
          return;
        }
        if (verb === 'edit') {
          if (!profiles[name]) throw new Error(`no profile "${name}"; see /profile`);
          const saved = await manageProfile({ rl: state.rl, ui: state.ui, home: state.home, name, existing: profiles[name] });
          state.ui.info(`saved profile ${saved.name}`);
          await state.reload();
          return;
        }
        if (verb === 'rm') {
          if (!name) throw new Error('usage: /profile rm <name>');
          if (name === state.config.profile) throw new Error(`"${name}" is active; switch to another profile first`);
          if (!(await ask(`Remove profile ${name}? Its key stays in ~/.nemesis/.env.`))) return;
          await removeUserProfile(state.home, name);
          state.ui.info(`removed profile ${name}`);
          return;
        }
        throw new Error('usage: /profile [use|add|edit|rm <name>]');
      },
    },
    {
      name: 'jobs',
      description: 'List background shells; /jobs show <id> or /jobs kill <id>',
      run(args, state) {
        const [verb = '', id = ''] = args.trim().split(/\s+/);
        if (verb === 'kill') {
          if (!id) throw new Error('usage: /jobs kill <id>');
          state.ui.info(state.jobs.kill(id) ? `stopped ${id}` : `${id} was not running`);
          return;
        }
        if (verb === 'show') {
          if (!id) throw new Error('usage: /jobs show <id>');
          const job = state.jobs.get(id);
          state.ui.info(`${id} ${job.status}${job.code !== null ? ` (exit ${job.code})` : ''}\n${job.output.slice(-4000).trimEnd() || '(no output)'}`);
          return;
        }
        state.ui.info(jobSummary(state.jobs));
      },
    },
    {
      name: 'rewind',
      aliases: ['undo'],
      description: 'Restore files, the conversation, or both to before an earlier prompt',
      async run(_args, state) {
        if (!state.rl?.choose) throw new Error('/rewind needs an interactive terminal');
        const turns = (await state.checkpoints().list());
        if (!turns.length) throw new Error('nothing to rewind yet: no prompt has changed files in this session');
        const shown = turns.slice(0, 15);
        const picked = await state.rl.choose({
          title: 'Rewind to before which prompt?',
          options: shown.map((t) => `${t.prompt.replace(/\s+/g, ' ').slice(0, 60)}  (${t.count} file${t.count === 1 ? '' : 's'})`),
        });
        if (picked < 0) return;
        const turn = shown[picked];
        const mode = await state.rl.choose({
          title: 'Restore what?',
          options: ['Code and conversation', 'Code only', 'Conversation only', 'Cancel'],
        });
        if (mode < 0 || mode === 3) return;
        const cp = state.checkpoints();
        const notes = [];
        if (mode !== 2) notes.push(`${await cp.restoreFiles(turn.i)} file(s) restored`);
        if (mode !== 1) {
          if (state.session.messages.length < turn.messageIndex) {
            notes.push('conversation not cut: it was compacted since that prompt');
          } else {
            await state.session.replace(state.session.messages.slice(0, turn.messageIndex), { archive: true });
            await cp.dropFrom(turn.i);
            state.rl.setDraft?.(turn.prompt);
            notes.push('conversation cut; the prompt is back in the box to edit');
          }
        }
        state.ui.info(notes.join('; '));
      },
    },
    {
      name: 'rename',
      description: 'Name this session, shown in the /resume picker: /rename <title>',
      async run(args, state) {
        if (!args.trim()) throw new Error('usage: /rename <title>');
        await renameSession(state.sessionsDir, state.session.id, args.trim().slice(0, 80));
        state.ui.info(`session named "${args.trim().slice(0, 80)}"`);
      },
    },
    {
      name: 'paste',
      aliases: ['paste-image'],
      description: 'Attach the clipboard image to the next prompt',
      async run(_args, state) {
        const file = await clipboardImage(path.join(state.cwd, '.nemesis', 'clipboard'));
        if (!file) throw new Error('no image on the clipboard (or no clipboard tool: Windows PowerShell, pngpaste on macOS, xclip on Linux)');
        const rel = path.relative(state.cwd, file).split(path.sep).join('/');
        state.attachments.push(rel);
        state.ui.info(`attached ${rel} to the next prompt`);
      },
    },
    {
      name: 'now',
      aliases: ['send'],
      description: 'During a turn: stop it and send the queued follow-ups now',
      run(_args, state) {
        state.ui.info('nothing queued. While a turn runs, type a follow-up, then /now or Enter on an empty box.');
      },
    },
    {
      name: 'max-steps',
      aliases: ['maxsteps'],
      description: 'Show or cap tool rounds per turn [n | off]; no limit by default',
      async run(args, state) {
        if (args) {
          const off = /^(off|none|0|unlimited)$/i.test(args);
          const n = Number(args);
          if (!off && (!Number.isInteger(n) || n < 1)) throw new Error('usage: /max-steps <positive integer> | off');
          state.config.maxSteps = off ? null : n;
          delete state.overrides.maxSteps;
          await saveUserConfig({ maxSteps: off ? null : n }, state.home);
        }
        state.ui.info(state.config.maxSteps
          ? `max steps: ${state.config.maxSteps} tool rounds per turn`
          : 'max steps: no limit (Esc or Ctrl+C stops a turn)');
      },
    },
    {
      name: 'context-window',
      description: 'Show or set the context window in tokens, e.g. 200k or 1m [size]',
      async run(args, state) {
        if (args) {
          const n = parseTokenCount(args);
          if (!Number.isFinite(n) || n < 1000) throw new Error('usage: /context-window <tokens>, e.g. 32000, 200k, 1m');
          await setProfileSetting(state, 'contextWindow', n);
        }
        const at = Math.round(state.config.contextWindow * (state.config.compactThreshold ?? 0.8));
        state.ui.info(`context window: ${state.config.contextWindow.toLocaleString()} tokens for ${state.config.provider} (auto-compact at ~${at.toLocaleString()})`);
      },
    },
    {
      name: 'effort',
      description: `Show or set reasoning effort: ${EFFORT_LEVELS.join(', ')}, default`,
      async run(args, state) {
        const level = args.toLowerCase();
        if (level) {
          if (level !== 'default' && !EFFORT_LEVELS.includes(level)) {
            throw new Error(`usage: /effort ${EFFORT_LEVELS.join('|')}|default`);
          }
          await setProfileSetting(state, 'effort', level === 'default' ? null : level);
        }
        const sent = state.config.provider === 'anthropic' ? 'output_config.effort' : 'reasoning_effort';
        state.ui.info(state.config.effort
          ? `effort: ${state.config.effort} (sent as ${sent}; a model that does not support this level rejects the request)`
          : "effort: model default (not sent)");
      },
    },
    {
      name: 'reasoning',
      aliases: ['thinking'],
      description: `Show or set model thinking: ${REASONING_MODES.join(', ')}, default`,
      async run(args, state) {
        const mode = args.toLowerCase();
        if (mode) {
          if (mode !== 'default' && !REASONING_MODES.includes(mode)) {
            throw new Error(`usage: /reasoning ${REASONING_MODES.join('|')}|default`);
          }
          await setProfileSetting(state, 'reasoning', mode === 'default' ? null : mode);
        }
        const notes = {
          adaptive: 'thinking on, hidden',
          summarized: 'thinking on, summary shown in the feed',
          disabled: 'thinking off; models with thinking always on reject this, use /effort low instead',
        };
        let text = state.config.reasoning
          ? `reasoning: ${state.config.reasoning} (${notes[state.config.reasoning]})`
          : 'reasoning: model default (not sent)';
        if (state.config.provider !== 'anthropic') {
          text += '\nOpenAI-compatible providers have no thinking switch; use /effort. Reasoning text the server streams is shown dim.';
        }
        state.ui.info(text);
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
        // The rule may contain spaces: /permissions allow bash(npm test:*)
        const [, verb = '', tool = ''] = /^(\S*)\s*(.*)$/.exec(args.trim());
        if (verb === 'reset') {
          for (const name of Object.keys(state.permissions.getRules())) state.permissions.setRule(name, 'ask');
        } else if (['allow', 'deny', 'ask'].includes(verb) && tool) {
          parseRuleSpec(tool);
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
        state.permissionMode = state.planMode ? 'plan' : 'default';
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
      description: 'Pick a session to resume, or /resume <id>',
      async run(args, state) {
        if (!args) {
          const sessions = await sessionSummaries(state.sessionsDir, 15);
          if (!sessions.length) {
            state.ui.info('no saved sessions');
            return;
          }
          if (!state.rl?.choose) {
            state.ui.info(sessions.map((s) => `${s.id === state.session.id ? '*' : ' '} ${s.id}  ${s.title}`).join('\n'));
            return;
          }
          const options = sessions.map((s) => `${s.title}  ${s.id.slice(0, 19)}${s.id === state.session.id ? '  (current)' : ''}`);
          const picked = await state.rl.choose({ title: 'Resume which session?', options });
          if (picked < 0) return;
          const chosen = sessions[picked];
          state.setSession(await Session.open(chosen.file));
          state.ui.info(`resumed ${chosen.id} (${state.session.messages.length} messages)`);
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
