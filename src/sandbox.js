// Sandbox 'strict' (set with /sandbox strict or "sandbox": "strict"):
//   - bash runs without API keys and tokens in its environment, so a command cannot read them.
//   - commands that look like network access are refused before they run.
// This is a guardrail, not an isolation boundary: a determined command can still reach the network
// (a script, or a command name not on the list). Real isolation needs OS-level containment.

export const SANDBOX_MODES = ['off', 'strict'];

const SECRET_NAME = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH)/i;

export function scrubEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_NAME.test(k) && v !== undefined) out[k] = v;
  return out;
}

const NETWORK = new RegExp(
  '\\b(' + [
    'curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'ssh', 'scp', 'sftp',
    'nc', 'ncat', 'telnet', 'ftp', 'npx', 'uvx', 'pipx',
    'git\\s+(push|fetch|pull|clone|remote)',
    'npm\\s+(publish|install|i|add|update|exec|x|create)',
    'pnpm\\s+(add|install|dlx)', 'yarn\\s+(add|install|dlx)',
    'pip3?\\s+install', 'cargo\\s+(install|fetch|add)', 'go\\s+(get|install)',
    'gh\\s+(api|pr|issue|release|repo|auth|gist|run)',
  ].join('|') + ')\\b',
  'i',
);

// The matched command word when the command looks like network access, else null.
export function networkCommand(command) {
  const m = NETWORK.exec(String(command ?? ''));
  return m ? m[0] : null;
}
