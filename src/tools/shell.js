import { spawn } from 'node:child_process';
import { getFirstLine } from './text.js';
import { networkCommand, scrubEnv } from '../sandbox.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 100_000;

// PowerShell on Windows, POSIX sh elsewhere.
export function shellInvocation(command, platform = process.platform) {
  if (platform === 'win32') {
    // -Command does not propagate native exit codes by itself; re-exit with $LASTEXITCODE.
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `${command}; exit $LASTEXITCODE`] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

export function runCommand(command, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal, platform, env } = {}) {
  const { file, args } = shellInvocation(command, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;

    const collect = (buf) => {
      if (size >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      chunks.push(buf);
      size += buf.length;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      if (signal?.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      let output = Buffer.concat(chunks).toString('utf8');
      if (truncated) output += `\n... (output truncated at ${MAX_OUTPUT_BYTES} bytes)`;
      resolve({ code, timedOut, output });
    });
  });
}

export const bashTool = {
  name: 'bash',
  description: 'Run a shell command in the workspace (PowerShell on Windows, sh elsewhere). Returns exit code and combined output.',
  risk: 'exec',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to run' },
      timeout_ms: { type: 'integer', description: `Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` },
      run_in_background: { type: 'boolean', description: 'Start it and return at once; read output with bash_output, stop with kill_shell. For servers, watchers, long builds.' },
    },
    required: ['command'],
  },
  describeCall: (input) => getFirstLine(input.command, 120),
  target: (input) => input.command,
  async run({ command, timeout_ms: timeoutMs = DEFAULT_TIMEOUT_MS, run_in_background: background = false }, ctx) {
    const timeout = Math.min(Math.max(1, timeoutMs), MAX_TIMEOUT_MS);
    const strict = ctx.config?.sandbox === 'strict';
    if (strict) {
      const network = networkCommand(command);
      if (network) throw new Error(`blocked by sandbox (strict): "${network}" may use the network. Run /sandbox off to allow it.`);
    }
    if (background) {
      if (!ctx.jobs) throw new Error('background shells are not available in this context');
      const job = ctx.jobs.start(command, { cwd: ctx.cwd, env: strict ? scrubEnv() : undefined });
      return `started background shell ${job.id}: ${command}. Read its output with bash_output (id ${job.id}); stop it with kill_shell.`;
    }
    const { code, timedOut, output } = await runCommand(command, {
      cwd: ctx.cwd,
      timeoutMs: timeout,
      signal: ctx.signal,
      env: strict ? scrubEnv() : undefined,
    });
    const status = timedOut ? `timed out after ${timeout} ms` : `exit code ${code}`;
    return `${status}\n${output}`.trimEnd();
  },
};

export const shellTools = [bashTool];
