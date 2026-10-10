import { spawn } from 'node:child_process';
import { shellInvocation } from './tools/shell.js';

// Hook config (same shape as Claude Code), in .nemesis/config.json under "hooks":
//   { "PreToolUse": [ { "matcher": "edit_file|write_file", "hooks": [ { "type": "command", "command": "..." } ] } ] }
// Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd.
// Command receives the event as JSON on stdin. Exit 2 blocks (stderr is the reason).
// Exit 0 with JSON {"decision":"block","reason":"..."} also blocks.
// Exit 0 with plain stdout on SessionStart / UserPromptSubmit is added as context.
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
const DEFAULT_TIMEOUT_MS = 60_000;

export function matchesHook(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`, 'i').test(toolName);
  } catch {
    return matcher.toLowerCase() === toolName.toLowerCase();
  }
}

export function runHookCommand(command, { input, cwd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const { file, args } = shellInvocation(command);
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NEMESIS_PROJECT_DIR: cwd },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // hook may exit without reading stdin
    child.stdin.end(JSON.stringify(input));
  });
}

function parseDecision(stdout) {
  try {
    const obj = JSON.parse(stdout);
    if (obj && typeof obj === 'object') {
      if (obj.decision === 'block') return { block: true, reason: obj.reason };
      if (obj.hookSpecificOutput?.permissionDecision === 'deny') {
        return { block: true, reason: obj.hookSpecificOutput.permissionDecisionReason };
      }
    }
  } catch {
    // not JSON: plain-text output
  }
  return { block: false };
}

// runner is injectable for tests.
export function createHooks(config, { cwd, getSessionId = () => null, runner = runHookCommand } = {}) {
  const table = config?.hooks ?? {};
  const count = Object.values(table).reduce((n, groups) => n + groups.reduce((m, g) => m + (g.hooks?.length ?? 0), 0), 0);

  return {
    count: () => count,
    list: () => table,

    async fire(event, payload = {}, { toolName } = {}) {
      const context = [];
      for (const group of table[event] ?? []) {
        if (TOOL_EVENTS.has(event) && toolName !== undefined && !matchesHook(group.matcher, toolName)) continue;
        for (const hook of group.hooks ?? []) {
          if (hook.type && hook.type !== 'command') continue;
          const result = await runner(hook.command, {
            input: { session_id: getSessionId(), cwd, hook_event_name: event, ...payload },
            cwd,
            timeoutMs: hook.timeout ? hook.timeout * 1000 : DEFAULT_TIMEOUT_MS,
          });
          const decision = parseDecision(result.stdout);
          if (result.code === 2 || decision.block) {
            return {
              blocked: true,
              reason: decision.reason ?? (result.stderr.trim() || `blocked by hook: ${hook.command}`),
              context,
            };
          }
          if (result.code !== 0) {
            context.push(`hook "${hook.command}" failed (exit ${result.code}): ${result.stderr.trim()}`);
          } else if (CONTEXT_EVENTS.has(event) && result.stdout.trim()) {
            context.push(result.stdout.trim());
          }
        }
      }
      return { blocked: false, context };
    },
  };
}
