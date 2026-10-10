import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig, nemesisHome, OUTPUT_STYLES, PROVIDERS } from './config.js';
import { loadEnvFile } from './env.js';
import { createProvider } from './providers/index.js';
import { createBuiltinTools } from './tools/index.js';
import { createPermissions, effectivePolicy } from './permissions.js';
import { Session } from './session.js';
import { buildSystemPrompt } from './prompt.js';
import { runAgentTurn } from './agent.js';
import { createUI } from './ui.js';
import { createHooks } from './hooks.js';
import { startMcpServers } from './mcp/manager.js';
import { createSubagentRunner, createTaskTool, loadAgentDefs } from './subagents.js';
import { createCommandRegistry, loadCustomCommands } from './commands/index.js';
import { runOnboarding } from './onboarding.js';
import { createUsage } from './usage.js';
import { setupPath } from './path.js';
import { VERSION } from './version.js';

const HELP = `nemesis ${VERSION} - terminal coding agent

Usage:
  nemesis                     interactive session (first run asks for a key)
  nemesis "prompt"            run one prompt and exit
  nemesis -p "prompt"         same as above

Options:
  -p, --prompt <text>       one-shot prompt (a leading / runs a slash command)
  -c, --continue            resume the most recent session
  -r, --resume <id>         resume a session by id
  -m, --model <name>        model override
      --provider <name>     anthropic | openai
      --base-url <url>      API base URL override
      --max-steps <n>       tool-call rounds per turn
      --no-stream           wait for full responses instead of streaming
      --output-style <s>    ${OUTPUT_STYLES.join(' | ')}
      --add-dir <path>      allow file tools in another directory (repeatable)
  -y, --yes                 auto-approve tools that would prompt
      --read-only           disable write and exec tools
      --plan                start in plan mode
      --setup               re-run key setup and add nemesis to PATH, then exit
  -h, --help                show help
  -v, --version             show version

Setup:  the first interactive run asks for provider, model, and key.
        Keys live in ~/.nemesis/.env; provider and model in ~/.nemesis/config.json.
Config: ~/.nemesis/config.json, then .nemesis/config.json and .nemesis/config.local.json in the project.
Env:    ANTHROPIC_API_KEY, OPENAI_API_KEY, NEMESIS_API_KEY, NEMESIS_PROVIDER,
        NEMESIS_MODEL, NEMESIS_BASE_URL`;

export function parseArgs(argv) {
  const args = { promptParts: [], overrides: {}, addDirs: [] };
  const take = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': args.help = true; break;
      case '-v': case '--version': args.version = true; break;
      case '-y': case '--yes': args.yes = true; break;
      case '-c': case '--continue': args.continue = true; break;
      case '--read-only': args.readOnly = true; break;
      case '--plan': args.plan = true; break;
      case '--setup': args.setup = true; break;
      case '--no-stream': args.overrides.stream = false; break;
      case '-p': case '--prompt': args.prompt = take(i++, a); break;
      case '-r': case '--resume': args.resume = take(i++, a); break;
      case '-m': case '--model': args.overrides.model = take(i++, a); break;
      case '--provider': args.overrides.provider = take(i++, a); break;
      case '--base-url': args.overrides.baseUrl = take(i++, a); break;
      case '--output-style': args.overrides.outputStyle = take(i++, a); break;
      case '--add-dir': args.addDirs.push(take(i++, a)); break;
      case '--max-steps': {
        const n = Number(take(i++, a));
        if (!Number.isInteger(n) || n < 1) throw new Error('--max-steps must be a positive integer');
        args.overrides.maxSteps = n;
        break;
      }
      default:
        if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
        args.promptParts.push(a);
    }
  }
  if (!args.prompt && args.promptParts.length) args.prompt = args.promptParts.join(' ');
  if (args.overrides.outputStyle && !OUTPUT_STYLES.includes(args.overrides.outputStyle)) {
    throw new Error(`--output-style must be one of: ${OUTPUT_STYLES.join(', ')}`);
  }
  return args;
}

async function openSession(args, sessionsDir) {
  if (args.resume) {
    const id = args.resume.replace(/\.jsonl$/, '');
    return Session.open(path.join(sessionsDir, `${id}.jsonl`));
  }
  if (args.continue) {
    const latest = await Session.latest(sessionsDir);
    if (latest) return latest;
  }
  return Session.create(sessionsDir);
}

// Shared runtime for the REPL, one-shot mode, slash commands, and sub-agents.
async function createState({ args, cwd, home, rl, ui }) {
  const state = {
    args,
    cwd,
    home,
    rl,
    ui,
    version: VERSION,
    overrides: { ...args.overrides },
    roots: [cwd, ...args.addDirs.map((d) => path.resolve(cwd, d))],
    sessionsDir: path.join(cwd, '.nemesis', 'sessions'),
    usage: createUsage(),
    planMode: Boolean(args.plan),
    exit: false,
    hookContext: [],
    controller: null,
    permissions: null,
    hooks: null,
    provider: null,
    session: null,
  };

  // Rebuild config and provider from layered sources. Called at startup and after /login.
  state.reload = async () => {
    state.config = await loadConfig({ cwd, home, overrides: state.overrides });
    state.provider = createProvider(state.config);
    if (state.permissions) {
      state.permissions.setPolicy(effectivePolicy({ config: state.config, planMode: state.planMode, readOnly: args.readOnly }));
    }
  };
  await state.reload();

  state.onboard = async (preferredProvider = null) => {
    if (!rl) throw new Error('setup needs an interactive terminal');
    await runOnboarding({ rl, ui, home, preferredProvider });
    // Saved choices now drive the config; explicit flags from this run no longer override them.
    state.overrides = state.overrides.maxSteps ? { maxSteps: state.overrides.maxSteps } : {};
    await state.reload();
  };

  state.permissions = createPermissions({
    policy: effectivePolicy({ config: state.config, planMode: state.planMode, readOnly: args.readOnly }),
    autoApprove: args.yes,
    prompt: rl ? (q) => rl.question(q) : null,
  });
  state.hooks = createHooks(state.config, { cwd, getSessionId: () => state.session?.id ?? null });

  state.mcp = await startMcpServers(state.config.mcpServers, { cwd, ui });
  state.agents = await loadAgentDefs([path.join(nemesisHome(home), 'agents'), path.join(cwd, '.nemesis', 'agents')]);
  const baseTools = [...createBuiltinTools(), ...state.mcp.tools];
  state.subagents = createSubagentRunner({
    agents: state.agents,
    allTools: baseTools,
    getRuntime: () => ({ provider: state.provider, config: state.config }),
    permissions: state.permissions,
    ui,
    hooks: state.hooks,
    cwd,
  });
  state.tools = [...baseTools, createTaskTool(state.subagents)];

  state.custom = await loadCustomCommands([path.join(nemesisHome(home), 'commands'), path.join(cwd, '.nemesis', 'commands')]);
  state.registry = createCommandRegistry(state);
  state.setSession = (session) => { state.session = session; };
  state.setSession(await openSession(args, state.sessionsDir));

  state.shutdown = async () => {
    await state.hooks.fire('SessionEnd', { reason: 'exit' }).catch(() => {});
    await state.mcp.close().catch(() => {});
    rl?.close();
  };
  return state;
}

// One user turn: UserPromptSubmit hook, append, run the agent. Returns false on failure.
async function runUserTurn(state, text) {
  const submit = await state.hooks.fire('UserPromptSubmit', { prompt: text });
  if (submit.blocked) {
    state.ui.error(`prompt blocked by hook: ${submit.reason}`);
    return false;
  }
  const content = submit.context.length ? `${text}\n\n${submit.context.join('\n')}` : text;
  await state.session.append({ role: 'user', content });

  const controller = new AbortController();
  state.controller = controller;
  try {
    const system = await buildSystemPrompt({
      cwd: state.cwd,
      outputStyle: state.config.outputStyle,
      extra: state.hookContext,
    });
    await runAgentTurn({
      provider: state.provider,
      config: state.config,
      tools: state.tools,
      system,
      session: state.session,
      permissions: state.permissions,
      ui: state.ui,
      ctx: { cwd: state.cwd, roots: state.roots, signal: controller.signal, config: state.config, subagents: state.subagents },
      hooks: state.hooks,
      usage: state.usage,
    });
    return true;
  } catch (err) {
    if (err.name === 'AbortError') state.ui.warn('interrupted');
    else state.ui.error(err.message);
    return false;
  } finally {
    state.controller = null;
    state.ui.status(statusLine(state));
  }
}

function statusLine(state) {
  const t = state.usage.totals();
  return `${state.config.provider}/${state.config.model} · ${t.requests} requests · ${t.input + t.output} tokens`;
}

async function runOneShot(state, prompt) {
  let text = prompt;
  if (text.startsWith('/')) {
    const r = await state.registry.dispatch(text);
    if (!r.handled) {
      state.ui.error(r.error);
      return false;
    }
    if (!r.prompt) return true;
    text = r.prompt;
  }
  const ok = await runUserTurn(state, text);
  state.ui.info(`session ${state.session.id}`);
  return ok;
}

async function runRepl(state) {
  const { rl, ui } = state;
  rl.on('SIGINT', () => {
    if (state.controller) state.controller.abort();
    else rl.close();
  });

  ui.banner({
    version: VERSION,
    provider: state.config.provider,
    model: state.config.model,
    cwd: state.cwd,
    session: state.session.id,
  });
  ui.info(ui.dim('  /help for commands · Ctrl+C interrupts a running turn · /exit quits'));

  while (!state.exit) {
    let line;
    try {
      ui.rule();
      line = (await rl.question(ui.prompt())).trim();
    } catch {
      break; // input closed
    }
    if (!line) continue;

    if (line.startsWith('/')) {
      try {
        const r = await state.registry.dispatch(line);
        if (!r.handled) ui.error(r.error);
        else if (r.prompt) await runUserTurn(state, r.prompt);
      } catch (err) {
        ui.error(err.message);
      }
      continue;
    }
    await runUserTurn(state, line);
  }
  ui.info(`session ${state.session.id} saved to ${state.session.file}`);
}

// Non-fatal: a PATH problem should never block the session itself.
async function runPathSetup(rl, ui, home) {
  try {
    await setupPath({ rl, ui, home });
  } catch (err) {
    ui.warn(`PATH setup skipped: ${err.message}`);
  }
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) return void console.log(HELP);
  if (args.version) return void console.log(VERSION);

  const cwd = process.cwd();
  const home = homedir();
  await loadEnvFile({ home });

  const interactive = Boolean(stdin.isTTY && stdout.isTTY);
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  const ui = createUI();
  const state = await createState({ args, cwd, home, rl, ui });

  try {
    if (args.setup) {
      if (!rl) throw new Error('--setup needs an interactive terminal');
      await state.onboard(args.overrides.provider ?? null);
      await runPathSetup(rl, ui, home);
      return;
    }
    if (!state.config.apiKey) {
      if (!rl) {
        const { keyEnv } = PROVIDERS[state.config.provider];
        throw new Error(`no API key for ${state.config.provider}. Run nemesis in a terminal to set one up, or set ${keyEnv}`);
      }
      await state.onboard(args.overrides.provider ?? null);
      await runPathSetup(rl, ui, home);
    }

    const start = await state.hooks.fire('SessionStart', { source: args.resume || args.continue ? 'resume' : 'startup' });
    state.hookContext.push(...start.context);

    if (args.prompt) {
      process.exitCode = (await runOneShot(state, args.prompt)) ? 0 : 1;
      return;
    }
    await runRepl(state);
  } finally {
    await state.shutdown();
  }
}
