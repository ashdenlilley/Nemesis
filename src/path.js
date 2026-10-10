import { spawn } from 'node:child_process';
import { access, appendFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { runCommand } from './tools/shell.js';

// Put the directory holding the global `nemesis` launcher on the user's PATH, so the
// command works in any new terminal. The launcher is created by `npm install -g` or `npm link`.

export const GITHUB_SPEC = 'github:ashdenlilley/Nemesis';
const RC_MARKER = '# added by nemesis setup';

export function normalizePathEntry(p, platform = process.platform) {
  const trimmed = p.replace(/[\\/]+$/, '');
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

export function isOnPath(dir, pathEnv, platform = process.platform) {
  const sep = platform === 'win32' ? ';' : ':';
  const entries = (pathEnv ?? '').split(sep).filter(Boolean).map((e) => normalizePathEntry(e, platform));
  return entries.includes(normalizePathEntry(dir, platform));
}

// npm puts shims in the prefix root on Windows and in <prefix>/bin elsewhere.
export function shimDir(prefix, platform = process.platform) {
  return platform === 'win32' ? prefix : path.posix.join(prefix, 'bin');
}

export function launcherName(platform = process.platform) {
  return platform === 'win32' ? 'nemesis.cmd' : 'nemesis';
}

export async function npmGlobalPrefix() {
  const res = await runCommand('npm prefix -g', { timeoutMs: 30_000 });
  if (res.code !== 0) throw new Error(`npm prefix -g failed: ${res.output.trim()}`);
  return res.output.trim();
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// Windows: append to the persistent User PATH. The value goes through an env var, not the script text.
function addToWindowsUserPath(dir, env) {
  const script = [
    '$p = [Environment]::GetEnvironmentVariable("Path", "User")',
    '$new = if ($p) { "$p;$env:NEMESIS_SHIM" } else { $env:NEMESIS_SHIM }',
    '[Environment]::SetEnvironmentVariable("Path", $new, "User")',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...env, NEMESIS_SHIM: dir },
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`PowerShell exited ${code}`))));
  });
}

// POSIX: append an export line to the login shell's rc file, once.
export async function addToPosixPath(dir, { home = homedir(), shell = process.env.SHELL ?? '' } = {}) {
  const rc = path.join(home, shell.endsWith('zsh') ? '.zshrc' : '.bashrc');
  const existing = await readFile(rc, 'utf8').catch(() => '');
  if (existing.includes(dir)) return rc;
  await appendFile(rc, `\n${RC_MARKER}\nexport PATH="${dir}:$PATH"\n`, 'utf8');
  return rc;
}

// Returns a status object; never throws for "declined" or "already set up" cases.
//   status: 'on-path' | 'no-launcher' | 'declined' | 'added'
export async function setupPath({ rl, ui, env = process.env, platform = process.platform, home = homedir(), prefix = null }) {
  const globalPrefix = prefix ?? await npmGlobalPrefix();
  const dir = shimDir(globalPrefix, platform);

  if (isOnPath(dir, env.PATH, platform)) return { status: 'on-path', dir };

  if (!(await exists(path.join(dir, launcherName(platform))))) {
    ui.info(`no global "nemesis" launcher in ${dir}.\nInstall it with:  npm install -g ${GITHUB_SPEC}`);
    return { status: 'no-launcher', dir };
  }

  const answer = (await rl.question(`Add ${dir} to PATH so "nemesis" works in any terminal? [Y/n]: `)).trim().toLowerCase();
  if (answer === 'n' || answer === 'no') return { status: 'declined', dir };

  let where;
  if (platform === 'win32') {
    await addToWindowsUserPath(dir, env);
    where = 'User PATH (Windows)';
  } else {
    where = await addToPosixPath(dir, { home, shell: env.SHELL });
  }
  env.PATH = `${dir}${platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`;
  ui.info(`added ${dir} to ${where}. Open a new terminal, then run: nemesis`);
  return { status: 'added', dir, where };
}
