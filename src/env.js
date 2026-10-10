import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { nemesisHome } from './config.js';

// ~/.nemesis/.env holds API keys. Loaded into process.env at startup; real env vars win.
export function envFilePath(home = homedir()) {
  return path.join(nemesisHome(home), '.env');
}

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

export function serializeEnv(values) {
  return Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join('');
}

async function readEnvFile(file) {
  try {
    return parseEnv(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function loadEnvFile({ home = homedir(), env = process.env } = {}) {
  const values = await readEnvFile(envFilePath(home));
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) env[key] = value;
  }
  return values;
}

// updates: { KEY: 'value' } sets, { KEY: null } removes. Also applies to env for this process.
export async function setEnvKeys(updates, { home = homedir(), env = process.env } = {}) {
  const file = envFilePath(home);
  await mkdir(path.dirname(file), { recursive: true });
  const current = await readEnvFile(file);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      delete current[key];
      delete env[key];
    } else {
      current[key] = value;
      env[key] = value;
    }
  }
  await writeFile(file, serializeEnv(current), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await chmod(file, 0o600);
  return file;
}
