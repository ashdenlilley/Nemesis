import { stdin, stdout, stderr } from 'node:process';
import { homedir } from 'node:os';
import path from 'node:path';
import { addLocalRules, loadConfig, nemesisHome, OUTPUT_STYLES, PROVIDERS } from './config.js';
import { loadEnvFile } from './env.js';
import { createProvider } from './providers/index.js';
import { createBuiltinTools } from './tools/index.js';
import { createPermissions, effectivePolicy } from './permissions.js';
import { Session } from './session.js';
import { buildSystemPrompt } from './prompt.js';
import { runAgentTurn, settleDanglingToolUses } from './agent.js';
import { createUI, stripAnsi } from './ui.js';
import { createLineReader } from './input.js';
import { createHooks } from './hooks.js';
import { startMcpServers } from './mcp/manager.js';
import { createSubagentRunner, createTaskOutputTool, createTaskTool, loadAgentDefs } from './subagents.js';
import { createSkillTool, loadSkills, skillsPromptSection } from './skills.js';
import { createPlanTool } from './plan.js';
import { webTools } from './tools/web.js';
import { buildUserContent, mentionCompletions } from './attach.js';
import { appendHistory, appendNote, loadHistory, runStatusLine, shellNote } from './extras.js';
import { clipboardImage } from './clipboard.js';
import { Checkpoints } from './checkpoints.js';
import { JobRegistry, createJobTools } from './jobs.js';
import { manageProfiles } from './profiles.js';
import { runCommand } from './tools/shell.js';
import { scrubEnv } from './sandbox.js';
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
      --profile <name>      use a saved profile (see /profile)
      --base-url <url>      API base URL override
      --max-steps <n>       cap tool-call rounds per turn (default: no limit)
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
      case '--profile': args.overrides.profile = take(i++, a); break;
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
    permissionMode: args.plan ? 'plan' : 'default',
    exit: false,
    hookContext: [],
    followUps: [], // prompts queued during a turn, sent after the next tool round
    controller: null,
    attachments: [], // files attached with /paste, sent with the next prompt
    jobs: new JobRegistry(), // background shells
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
    choose: rl ? (spec) => rl.choose(spec) : null,
    allow: state.config.allowRules ?? [],
    deny: state.config.denyRules ?? [],
    ask: state.config.askRules ?? [],
    cwd,
    // "don't ask again" is saved to this project's local config, so it holds next time.
    onPersist: (spec) => addLocalRules(cwd, { allowRules: [spec] }),
  });
  state.planTool = createPlanTool((plan) => approvePlan(state, plan));
  state.hooks = createHooks(state.config, { cwd, getSessionId: () => state.session?.id ?? null });

  // Tools every agent gets. Rebuilt when MCP servers change; sub-agents read the current list.
  state.startMcp = async () => {
    state.mcp = await startMcpServers(state.config.mcpServers, { cwd, ui, home });
    state.baseTools = [...createBuiltinTools(), ...webTools, ...createJobTools(state.jobs), ...state.mcp.tools];
    rebuildTools(state);
  };
  state.reconnectMcp = async () => {
    await state.mcp?.close().catch(() => {});
    await state.startMcp();
  };
  state.skills = await loadSkills([path.join(nemesisHome(home), 'skills'), path.join(cwd, '.nemesis', 'skills')]);
  state.skillTools = state.skills.size ? [createSkillTool(state.skills)] : [];
  state.agents = await loadAgentDefs([path.join(nemesisHome(home), 'agents'), path.join(cwd, '.nemesis', 'agents')]);
  await state.startMcp();
  state.subagents = createSubagentRunner({
    agents: state.agents,
    allTools: () => state.baseTools,
    getRuntime: () => ({ provider: state.provider, config: state.config }),
    permissions: state.permissions,
    ui,
    hooks: state.hooks,
    cwd,
  });
  state.taskTools = [createTaskTool(state.subagents), createTaskOutputTool(state.subagents)];
  rebuildTools(state);

  state.custom = await loadCustomCommands([path.join(nemesisHome(home), 'commands'), path.join(cwd, '.nemesis', 'commands')]);
  state.registry = createCommandRegistry(state);
  // Checkpoints are per session: one file per session id, loaded when the session is first used.
  const checkpointCache = new Map();
  state.checkpoints = () => {
    const id = state.session.id;
    if (!checkpointCache.has(id)) checkpointCache.set(id, new Checkpoints(path.join(cwd, '.nemesis', 'checkpoints'), id));
    return checkpointCache.get(id);
  };
  state.setSession = (session) => { state.session = session; };
  state.setSession(await openSession(args, state.sessionsDir));

  state.shutdown = async () => {
    state.jobs.killAll();
    await state.hooks.fire('SessionEnd', { reason: 'exit' }).catch(() => {});
    await state.mcp.close().catch(() => {});
    rl?.close();
  };
  return state;
}

// One column each, all text presentation: ✳ (U+2733) is left out because terminals draw it as a green emoji.
export const SPINNER = ['·', '✢', '✶', '✻', '✽', '✻', '✶', '✢'];
const EXIT_WINDOW_MS = 2000; // a second Ctrl+C on an empty prompt within this exits
const STALE_SECS = 20; // waiting this long on the model with no data shows a warning in the status line

const formatSecs = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
const formatTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// Animated status line above the prompt box while a turn runs: ✻ Nms-ing… (12s).
// Turns yellow with a warning when the model has sent nothing for STALE_SECS.
function startSpinner(rl, ui) {
  const started = Date.now();
  let lastActivity = started;
  let phase = 'model';
  let note = null;
  let frame = 0;
  const draw = () => {
    const now = Date.now();
    const secs = Math.floor((now - started) / 1000);
    const idle = Math.floor((now - lastActivity) / 1000);
    let warning = note;
    if (!warning && phase === 'model' && idle >= STALE_SECS) warning = `no response from the model for ${formatSecs(idle)}`;
    const icon = SPINNER[frame++ % SPINNER.length];
    const head = warning ? ui.yellow(`${icon} Nms-ing…`) : ui.accent(`${icon} Nms-ing…`);
    const tail = ui.dim(`(${formatSecs(secs)})`);
    rl.setStatus(`${head} ${tail}${warning ? ` ${ui.yellow(warning)}` : ''}`);
  };
  draw();
  const timer = setInterval(draw, 150);
  timer.unref?.();
  return {
    phase(p) {
      phase = p;
      lastActivity = Date.now();
      note = null;
    },
    activity() {
      lastActivity = Date.now();
      note = null;
    },
    retry(message) {
      note = message;
      lastActivity = Date.now();
    },
    stop() {
      clearInterval(timer);
      rl.setStatus(null);
      return Date.now() - started;
    },
  };
}

// Slash commands matching what is typed so far, for the prompt box's suggestion list.
// Profile names starting with what has been typed. Picking one replaces the partial name, and the box stays open.
export function profileNameCompletions(text, partial, profiles) {
  const q = partial.toLowerCase();
  return Object.keys(profiles)
    .filter((name) => name.toLowerCase().startsWith(q))
    .sort()
    .map((name) => ({
      name,
      description: profiles[name]?.model ?? profiles[name]?.models?.[0] ?? '',
      apply: (t) => t.slice(0, t.length - partial.length) + name + ' ',
    }));
}

function commandCompleter(state) {
  return (text) => {
    if (/(^|\s)@[^\s]*$/.test(text)) return mentionCompletions(text, { cwd: state.cwd });
    // /profile use|edit|rm|rename <name>: complete the profile name (add takes a new name, so it is not completed).
    const profileArg = /^\/profiles?\s+(use|edit|rm|rename)\s+(\S*)$/i.exec(text);
    if (profileArg) return profileNameCompletions(text, profileArg[2], state.config.profiles ?? {});
    if (!/^\/\S*$/.test(text)) return [];
    const q = text.slice(1).toLowerCase();
    const items = [
      ...state.registry.builtins.map((c) => ({ name: `/${c.name}`, description: c.description, keys: [c.name, ...(c.aliases ?? [])] })),
      ...[...(state.custom?.values() ?? [])].map((c) => ({ name: `/${c.name}`, description: `${c.description} (custom)`, keys: [c.name] })),
    ];
    return items
      .filter((it) => it.keys.some((k) => k.startsWith(q)))
      .sort((a, b) => Number(b.name === text) - Number(a.name === text) || a.name.localeCompare(b.name))
      .map(({ name, description }) => ({ name, description }));
  };
}

// One user turn: UserPromptSubmit hook, append, run the agent. Returns false on failure.
async function runUserTurn(state, text, progress = null) {
  const submit = await state.hooks.fire('UserPromptSubmit', { prompt: text });
  if (submit.blocked) {
    state.ui.error(`prompt blocked by hook: ${submit.reason}`);
    return false;
  }
  // /paste attachments ride along as @mentions; @file mentions inline files or attach images.
  const attached = state.attachments.splice(0).map((p) => `@${p}`);
  const full = [text, ...attached].join(' ');
  let content = await buildUserContent(full, { roots: state.roots });
  if (submit.context.length) {
    const extra = `\n\n${submit.context.join('\n')}`;
    content = typeof content === 'string' ? content + extra : [...content.slice(0, -1), { type: 'text', text: content.at(-1).text + extra }];
  }
  // A session saved mid tool call (crash, kill) has tool_use blocks with no results; the API rejects it.
  await settleDanglingToolUses(state.session);
  await state.checkpoints().begin(state.session.messages.length, text);
  await state.session.append({ role: 'user', content });

  const controller = new AbortController();
  state.controller = controller;
  try {
    const system = await buildSystemPrompt({
      cwd: state.cwd,
      outputStyle: state.config.outputStyle,
      extra: state.hookContext,
      skills: skillsPromptSection(state.skills),
    });
    await runAgentTurn({
      provider: state.provider,
      config: state.config,
      tools: state.tools,
      system,
      session: state.session,
      permissions: state.permissions,
      ui: state.ui,
      ctx: {
        cwd: state.cwd,
        roots: state.roots,
        signal: controller.signal,
        config: state.config,
        subagents: state.subagents,
        jobs: state.jobs,
        checkpoint: (abs) => state.checkpoints().record(abs),
      },
      hooks: state.hooks,
      usage: state.usage,
      takeFollowUps: () => state.followUps.splice(0),
      progress,
    });
    return true;
  } catch (err) {
    if (err.name === 'AbortError') {
      if (state.sendNow) state.ui.info(state.ui.dim('  stopped to send the queued message'));
      else state.ui.warn('interrupted');
    } else {
      state.ui.error(err.message);
      if (err.retryable) state.ui.info(state.ui.dim('  The model connection failed after retries. The session is intact; send your message again to retry.'));
    }
    return false;
  } finally {
    state.controller = null;
    state.sendNow = false;
    const elapsed = progress?.stop() ?? null;
    if (state.config.turnRecap) state.ui.status(statusLine(state, elapsed));
  }
}

// Shift+Tab cycles these. bypass allows every tool (deny rules still apply); the change lasts this session.
export const PERMISSION_CYCLE = ['default', 'acceptEdits', 'plan', 'bypass'];
const MODE_TEXT = {
  default: 'default permissions',
  acceptEdits: 'accept edits on',
  plan: 'plan mode on',
  bypass: 'bypass permissions on',
};
export const nextPermissionMode = (mode) => PERMISSION_CYCLE[(PERMISSION_CYCLE.indexOf(mode) + 1) % PERMISSION_CYCLE.length];

function setPermissionMode(state, mode) {
  state.permissionMode = mode;
  state.planMode = mode === 'plan';
  let policy;
  if (mode === 'bypass') policy = { read: 'allow', write: 'allow', exec: 'allow' };
  else if (mode === 'acceptEdits') policy = { read: 'allow', write: 'allow', exec: 'ask' };
  else policy = effectivePolicy({ config: state.config, planMode: state.planMode, readOnly: state.args.readOnly });
  state.permissions.setPolicy(policy);
  rebuildTools(state);
}

// exit_plan_mode is offered only in plan mode.
function rebuildTools(state) {
  state.tools = [
    ...state.baseTools,
    ...(state.taskTools ?? []),
    ...(state.skillTools ?? []),
    ...(state.permissionMode === 'plan' && state.planTool ? [state.planTool] : []),
  ];
}

// Shows the plan and asks. Approval leaves plan mode for default permissions.
async function approvePlan(state, plan) {
  state.ui.info(plan.trim());
  if (!state.rl?.choose) return false;
  const picked = await state.rl.choose({
    title: 'Approve this plan and leave plan mode?',
    options: ['Yes, go to default permissions', 'No, keep planning'],
  });
  if (picked !== 0) return false;
  setPermissionMode(state, 'default');
  refreshFooter(state);
  return true;
}

// The prompt bar's footer: accent rule under the box, then a status row with the permission mode,
// the profile and model, key hints, and the user's statusLine output when one is set.
function drawFooter(state, custom = null) {
  if (!state.rl) return;
  const { ui } = state;
  const mode = state.args.readOnly
    ? ui.dim('read-only')
    : `${ui.accent('>>')} ${MODE_TEXT[state.permissionMode] ?? MODE_TEXT.default} ${ui.dim('(shift+tab to cycle)')}`;
  const model = ui.dim(`${state.config.profile} · ${state.config.model}`);
  const hints = ui.dim('/help · esc stops a turn');
  // The row must fit on one line: a wrapped footer breaks the redraw. Drop the least important parts first.
  const sep = ui.dim('  ·  ');
  const parts = [mode, model, ...(custom ? [ui.dim(custom)] : []), hints];
  const max = (state.rl.output?.columns || 80) - 1;
  while (parts.length > 2 && stripAnsi(parts.join(sep)).length > max) parts.splice(parts.length - 2, 1);
  state.rl.setFooter(`${ui.ruleLine()}\n${parts.join(sep)}`);
}

// The footer: the user's statusLine command output, when one is set, shown in the bar.
async function refreshFooter(state) {
  if (!state.rl) return;
  if (!state.config.statusLine) {
    drawFooter(state);
    return;
  }
  const t = state.usage.totals();
  const payload = {
    provider: state.config.provider,
    model: state.config.model,
    cwd: state.cwd,
    session: state.session.id,
    requests: t.requests,
    tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead },
    contextWindow: state.config.contextWindow,
    sandbox: state.config.sandbox,
  };
  drawFooter(state, await runStatusLine(state.config.statusLine, payload, { cwd: state.cwd }));
}

function statusLine(state, elapsedMs = null) {
  const t = state.usage.totals();
  const usage = `${state.config.provider}/${state.config.model} · ${t.requests} requests · ${formatTokens(t.input + t.output)} tokens`;
  if (elapsedMs === null) return usage;
  const done = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `✻ Nms'd for ${formatSecs(Math.round(elapsedMs / 1000))} · done ${done} · ${usage}`;
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

// Turn with the prompt box kept under the feed: Enter queues a follow-up for the next tool round, Ctrl+C interrupts.
async function runWatchedTurn(state, text) {
  state.rl.watch({
    label: state.ui.prompt(),
    complete: commandCompleter(state),
    onSubmit: (typed) => {
      const queued = typed.trim();
      // Send now: Enter on an empty box, or /now, stops the turn; the queue becomes the next prompt.
      if (!queued || /^\/(now|send)$/i.test(queued)) {
        if (!state.followUps.length) return;
        state.sendNow = true;
        state.controller?.abort();
        return;
      }
      state.followUps.push(queued);
      state.ui.queued(queued);
    },
    onInterrupt: () => state.controller?.abort(),
  });
  try {
    return await runUserTurn(state, text, startSpinner(state.rl, state.ui));
  } finally {
    state.rl.unwatch();
    refreshFooter(state);
  }
}

// "!cmd" runs a shell command now, without the model. Its output is kept as context for the next prompt.
async function runShellMode(state, command) {
  const strict = state.config.sandbox === 'strict';
  const result = await runCommand(command, { cwd: state.cwd, env: strict ? scrubEnv() : undefined, timeoutMs: 120_000 });
  const shown = result.output.trimEnd().split('\n');
  state.ui.info(shown.slice(0, 40).join('\n') + (shown.length > 40 ? `\n… +${shown.length - 40} lines` : ''));
  state.ui.info(state.ui.dim(result.timedOut ? 'timed out' : `exit ${result.code}`));
  await settleDanglingToolUses(state.session);
  await state.session.append({ role: 'user', content: shellNote(command, result) });
}

const isCancel = (err) => err?.name === 'AbortError' || ['CANCEL', 'INTERRUPT', 'EOF'].includes(err?.code);

// A slash command with a prompt box up: Esc or Ctrl+C (on an empty box, or in any question the
// command asks) cancels it. Text typed meanwhile is kept as the next prompt. Returns the prompt
// the command wants sent to the model, or null.
async function runSlashCommand(state, text) {
  const controller = new AbortController();
  state.controller = controller;
  const cancelled = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
  });
  state.rl.watch({
    label: state.ui.prompt(),
    complete: commandCompleter(state),
    onSubmit: (typed) => {
      if (typed.trim()) state.followUps.push(typed.trim());
    },
    onInterrupt: () => controller.abort(),
  });
  const run = state.registry.dispatch(text);
  run.catch(() => {}); // still settles after a cancel; nothing waits for it then
  try {
    const r = await Promise.race([run, cancelled]);
    if (!r.handled) state.ui.error(r.error);
    return r.handled ? r.prompt : null;
  } catch (err) {
    if (isCancel(err)) state.ui.warn(`cancelled ${text.split(/\s/)[0]}`);
    else state.ui.error(err.message);
    return null;
  } finally {
    state.controller = null;
    state.rl.unwatch();
  }
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
  ui.info(ui.dim('  /help for commands · Esc or Ctrl+C stops a turn or command · Ctrl+C twice exits'));

  rl.setHistory(await loadHistory(state.home));
  // The bar's top rule is part of the live area, so it stays above the box during turns too.
  rl.setHeader(`\n${ui.ruleLine()}`); // a blank line keeps the messages above the rule apart from it
  // Up/Down and Ctrl+R use the saved prompts. Ctrl+O expands the last condensed tool run. Ctrl+V attaches a clipboard image.
  const remember = async (text) => {
    rl.addHistory(text);
    await appendHistory(state.home, text).catch(() => {});
  };
  rl.onKey('\x0f', () => ui.expandLast());
  rl.onKey('\x1b[Z', () => {
    if (state.args.readOnly) return;
    setPermissionMode(state, nextPermissionMode(state.permissionMode));
    refreshFooter(state);
  });
  rl.onKey('\x16', async () => {
    const file = await clipboardImage(path.join(state.cwd, '.nemesis', 'clipboard')).catch(() => null);
    if (file) rl.insert(`@${path.relative(state.cwd, file).split(path.sep).join('/')} `);
  });
  await refreshFooter(state);

  let leftover = null; // follow-ups not consumed by the last turn; they become the next prompt
  let lastCtrlC = 0;
  while (!state.exit) {
    let text;
    if (leftover !== null) {
      text = leftover;
      leftover = null;
    } else {
      let raw;
      try {
        // The box clears on Enter; the feed shows the prompt.
        raw = await rl.question(ui.prompt(), {
          leave: false,
          complete: commandCompleter(state),
          labelFor: (t) => ui.prompt(t[0] === '!' || t[0] === '#' ? t[0] : null),
        });
      } catch (err) {
        if (err.code === 'CANCEL') {
          continue;
        }
        if (err.code === 'INTERRUPT' && Date.now() - lastCtrlC > EXIT_WINDOW_MS) {
          lastCtrlC = Date.now();
          ui.info(ui.dim('  press Ctrl+C again to exit'));
          continue;
        }
        break; // second Ctrl+C, Ctrl+D, or input closed
      }
      text = raw.trim();
      if (!text) continue;
    }
    ui.userMessage(text);

    if (text.length > 1 && (text[0] === '!' || text[0] === '#')) {
      const body = text.slice(1).trim();
      try {
        if (text[0] === '!') await runShellMode(state, body);
        else {
          await appendNote(state.cwd, body);
          ui.info(ui.dim(`noted in NEMESIS.md: ${body}`));
        }
      } catch (err) {
        ui.error(err.message);
      }
      await remember(text);
      continue;
    }
    if (text.startsWith('/')) {
      await remember(text);
      const prompt = await runSlashCommand(state, text);
      if (prompt) await runWatchedTurn(state, prompt);
      if (state.followUps.length) leftover = state.followUps.splice(0).join('\n\n');
      continue;
    }
    await remember(text);
    await runWatchedTurn(state, text);
    if (state.followUps.length) leftover = state.followUps.splice(0).join('\n\n');
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
  const rl = interactive ? createLineReader({ input: stdin, output: stdout }) : null;
  const ui = rl ? createUI({ out: rl.wrap(stdout), err: rl.wrap(stderr) }) : createUI();
  const state = await createState({ args, cwd, home, rl, ui });

  try {
    if (args.setup) {
      if (!rl) throw new Error('--setup needs an interactive terminal');
      if (Object.keys(state.config.profiles ?? {}).length) {
        // Profiles exist: add or edit them.
        await manageProfiles({ rl, ui, home, profiles: { ...state.config.profiles } });
        await state.reload();
      } else {
        await state.onboard(args.overrides.provider ?? null);
      }
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
