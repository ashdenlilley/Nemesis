import { READ_ONLY_POLICY } from './config.js';

// Policy in effect given mode flags. Plan mode and --read-only both force read-only.
export function effectivePolicy({ config, planMode = false, readOnly = false }) {
  if (planMode || readOnly) return { ...READ_ONLY_POLICY };
  return { ...config.permissions };
}

// Gate every tool call by its risk class.
//   policy: { read, write, exec } -> 'allow' | 'ask' | 'deny'
//   rules:  per-tool overrides set via /permissions, take precedence over policy
//   choose: async ({ title, options }) -> chosen index (-1 when cancelled), or null when no terminal is attached
export function createPermissions({ policy, choose = null, autoApprove = false }) {
  let current = { ...policy };
  const rules = new Map();

  return {
    getPolicy: () => ({ ...current }),
    setPolicy(next) {
      current = { ...next };
    },
    getRules: () => Object.fromEntries(rules),
    setRule(toolName, mode) {
      if (mode === 'ask' || !mode) rules.delete(toolName);
      else rules.set(toolName, mode);
    },

    async check(tool, input) {
      const rule = rules.get(tool.name);
      if (rule === 'allow') return { allowed: true };
      if (rule === 'deny') return { allowed: false, reason: `${tool.name} is denied by rule` };

      const mode = current[tool.risk] ?? 'ask';
      if (mode === 'allow') return { allowed: true };
      if (mode === 'deny') return { allowed: false, reason: `${tool.risk} tools are disabled` };
      if (autoApprove) return { allowed: true };
      if (!choose) {
        return { allowed: false, reason: `${tool.name} needs approval; run interactively or pass --yes` };
      }

      const summary = tool.describeCall ? tool.describeCall(input) : JSON.stringify(input).slice(0, 120);
      const picked = await choose({
        title: `Allow ${tool.name} (${summary})?`,
        options: ['Yes', `Yes, and don't ask again for ${tool.name} this session`, 'No'],
      });
      if (picked === 1) {
        rules.set(tool.name, 'allow');
        return { allowed: true };
      }
      if (picked === 0) return { allowed: true };
      return { allowed: false, reason: 'denied by user' };
    },
  };
}
