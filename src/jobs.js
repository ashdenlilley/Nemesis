import { spawn } from 'node:child_process';
import { shellInvocation } from './tools/shell.js';

// Background shell jobs: a command keeps running while the model does other work. Output is kept
// (the newest MAX_KEEP characters) and read incrementally with bash_output. Jobs end when Nemesis exits.
const MAX_KEEP = 200_000;
const SETTLE_MS = 1500;

// Kills a command and the processes it started. On Windows, taskkill /T walks the tree; elsewhere the
// command runs in its own process group, so the group is signalled.
export function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

export class JobRegistry {
  constructor() {
    this.jobs = new Map();
    this.seq = 1;
  }

  start(command, { cwd, env } = {}) {
    const id = `shell-${this.seq++}`;
    const { file, args } = shellInvocation(command);
    const child = spawn(file, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const job = { id, command, child, output: '', consumed: 0, status: 'running', code: null, startedAt: Date.now() };
    const add = (chunk) => {
      job.output += chunk;
      if (job.output.length > MAX_KEEP) {
        const cut = job.output.length - MAX_KEEP;
        job.output = job.output.slice(cut);
        job.consumed = Math.max(0, job.consumed - cut);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', (err) => {
      job.status = 'failed';
      add(`\n[spawn error] ${err.message}\n`);
    });
    child.on('close', (code) => {
      if (job.status === 'running') job.status = 'exited';
      job.code = code;
    });
    this.jobs.set(id, job);
    return job;
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no background shell "${id}"; known: ${[...this.jobs.keys()].join(', ') || 'none'}`);
    return job;
  }

  // Output since the previous read of this job.
  read(id) {
    const job = this.get(id);
    const text = job.output.slice(job.consumed);
    job.consumed = job.output.length;
    return { status: job.status, code: job.code, text };
  }

  kill(id) {
    const job = this.get(id);
    if (job.status !== 'running') return false;
    job.status = 'killed';
    // On Windows the shell starts its command a moment after spawn. Killing the tree before that leaves the
    // command running with no parent, so the kill waits until the job has had time to start its children.
    const settle = Math.max(0, job.startedAt + SETTLE_MS - Date.now());
    setTimeout(() => killTree(job.child), settle);
    return true;
  }

  list() {
    return [...this.jobs.values()];
  }

  killAll() {
    for (const job of this.jobs.values()) if (job.status === 'running') this.kill(job.id);
  }
}

const describe = (job) => (job.status === 'running' ? 'running' : `${job.status}${job.code !== null ? ` (exit ${job.code})` : ''}`);

// bash_output: new output from a background shell. wait_ms waits up to 30 s for it to finish first.
// kill_shell: stops one. Both use the same permission classes as bash.
export function createJobTools(jobs) {
  return [
    {
      name: 'bash_output',
      risk: 'read',
      concurrent: true,
      description: 'Read new output from a background shell started with bash run_in_background. Set wait_ms to wait for it to finish (max 30000).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Shell id, e.g. shell-1' },
          wait_ms: { type: 'integer', description: 'Wait up to this long for the shell to exit' },
        },
        required: ['id'],
      },
      describeCall: (input) => input.id,
      async run({ id, wait_ms: waitMs = 0 }) {
        const job = jobs.get(id);
        const until = Date.now() + Math.min(Math.max(0, waitMs), 30_000);
        while (job.status === 'running' && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
        const { status, code, text } = jobs.read(id);
        const label = `${id}: ${status === 'running' ? 'running' : describe({ status, code })}`;
        return `${label}\n${text || '(no new output)'}`.trimEnd();
      },
    },
    {
      name: 'kill_shell',
      risk: 'exec',
      description: 'Stop a background shell started with bash run_in_background, along with the processes it started.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Shell id, e.g. shell-1' } },
        required: ['id'],
      },
      describeCall: (input) => input.id,
      run({ id }) {
        return jobs.kill(id) ? `stopped ${id}` : `${id} was not running`;
      },
    },
  ];
}

// For /jobs: one line per job.
export function jobSummary(jobs) {
  const list = jobs.list();
  if (!list.length) return 'no background shells';
  return list.map((j) => `${j.id.padEnd(9)} ${describe(j).padEnd(20)} ${j.command.slice(0, 70)}`).join('\n');
}
