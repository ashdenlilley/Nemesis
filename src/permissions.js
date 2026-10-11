import { READ_ONLY_POLICY } from './config.js';

// Policy in effect given mode flags. Plan mode and --read-only both force read-only.
export function effectivePolicy({ config, planMode = false, readOnly = false }) {
  if (planMode || readOnly) return { ...READ_ONLY_POLICY };
  return { ...config.permissions };
}

// Rule spec: "bash" (every call of that tool) or "bash(npm test:*)" (calls whose target matches).
// Tool names match case-insensitively, so Claude Code style "Bash(...)" works too.
export function parseRuleSpec(spec) {
  const m = /^\s*([A-Za-z0-9_-]+)\s*(?:\((.*)\))?\s*$/.exec(String(spec ?? ''));
  if (!m || (m[2] !== undefined && !m[2].trim())) {
    throw new Error(`bad rule "${spec}": use tool or tool(pattern), e.g. bash(npm test:*)`);
  }
  const tool = m[1].toLowerCase();
  const pattern = m[2] === undefined ? null : m[2].trim();
  return { tool, pattern, spec: pattern === null ? tool : `${tool}(${pattern})` };
}

// Shell control characters: a prefix rule must not match a command that chains something else on.
const CHAIN = /[;&|`\n\r]|\$\(/;

// "prefix:*" matches the prefix as a whole word run ("npm test:*" matches "npm test -w x", not "npm testing").
// Any other pattern is a glob where * matches anything.
export function matchesPattern(pattern, target) {
  if (pattern === null) return true;
  const t = String(target ?? '');
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2).trim();
    if (CHAIN.test(t)) return false;
    return t === prefix || t.startsWith(`${prefix} `);
  }
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
  return re.test(t);
}

// The text a rule pattern is matched against: the full command, file path, or URL.
export function targetOf(tool, input) {
  if (tool.target) return tool.target(input ?? {});
  if (tool.describeCall) return tool.describeCall(input ?? {});
  return JSON.stringify(input ?? {});
}

// A rule to offer for "don't ask again": bash(npm test:*) for a plain command, else the tool name.
export function suggestRule(tool, input) {
  if (tool.name === 'bash') {
    const cmd = String(input?.command ?? '').trim();
    const words = cmd.split(/\s+/).slice(0, 2).filter((w) => !/[=/\\"']/.test(w));
    if (cmd && !CHAIN.test(cmd) && words.length) return `${tool.name}(${words.join(' ')}:*)`;
  }
  return tool.name;
}

// Gate every tool call by its risk class.
//   policy: { read, write, exec } -> 'allow' | 'ask' | 'deny'
//   rules:  overrides from /permissions, allowRules/denyRules in config, and "don't ask again" choices.
//           A deny rule that matches wins over any allow; a pattern rule is more specific than a tool-name rule.
//   choose: async ({ title, options }) -> chosen index (-1 when cancelled), or null when no terminal is attached
export function createPermissions({ policy, choose = null, autoApprove = false, allow = [], deny = [] }) {
  let current = { ...policy };
  const byName = new Map(); // tool name -> mode
  const patterns = []; // { tool, pattern, spec, mode }

  const add = (spec, mode) => {
    const r = parseRuleSpec(spec);
    if (r.pattern === null) {
      if (mode === 'ask') byName.delete(r.tool);
      else byName.set(r.tool, mode);
    } else {
      const i = patterns.findIndex((p) => p.spec === r.spec);
      if (i !== -1) patterns.splice(i, 1);
      if (mode !== 'ask') patterns.push({ ...r, mode });
    }
  };
  for (const s of allow) add(s, 'allow');
  for (const s of deny) add(s, 'deny');

  // Modes of every rule that applies to this call, or null when none does.
  const ruleFor = (tool, input) => {
    const name = tool.name.toLowerCase();
    const target = targetOf(tool, input);
    const modes = [];
    for (const p of patterns) if (p.tool === name && matchesPattern(p.pattern, target)) modes.push(p.mode);
    if (byName.has(name)) modes.push(byName.get(name));
    if (modes.includes('deny')) return 'deny';
    if (modes.includes('allow')) return 'allow';
    return null;
  };

  return {
    getPolicy: () => ({ ...current }),
    setPolicy(next) {
      current = { ...next };
    },
    getRules: () => Object.fromEntries([...byName, ...patterns.map((p) => [p.spec, p.mode])]),
    setRule: add,

    async check(tool, input) {
      const rule = ruleFor(tool, input);
      if (rule === 'allow') return { allowed: true };
      if (rule === 'deny') return { allowed: false, reason: `${tool.name} is denied by a rule` };

      const mode = current[tool.risk] ?? 'ask';
      if (mode === 'allow') return { allowed: true };
      if (mode === 'deny') return { allowed: false, reason: `${tool.risk} tools are disabled` };
      if (autoApprove) return { allowed: true };
      if (!choose) {
        return { allowed: false, reason: `${tool.name} needs approval; run interactively or pass --yes` };
      }

      const summary = tool.describeCall ? tool.describeCall(input) : JSON.stringify(input).slice(0, 120);
      const suggestion = suggestRule(tool, input);
      const picked = await choose({
        title: `Allow ${tool.name} (${summary})?`,
        options: ['Yes', `Yes, and don't ask again for ${suggestion} this session`, 'No'],
      });
      if (picked === 1) {
        add(suggestion, 'allow');
        return { allowed: true };
      }
      if (picked === 0) return { allowed: true };
      return { allowed: false, reason: 'denied by user' };
    },
  };
}
