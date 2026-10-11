import path from 'node:path';
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

// Shell separators and substitution starts. Every piece of a command is checked on its own, so
// "ls; rm -rf x" cannot hide rm behind an allowed ls.
const SEGMENT_SPLIT = /&&|\|\||[;|&\n\r`()]|\$\(/;

// The pieces of a shell command, trimmed, without empty ones.
export function segmentsOf(command) {
  return String(command ?? '').split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
}

// Glob to regex. "**" crosses folders; "*" stays inside one folder for file paths and matches anything otherwise.
function globToRegex(pattern, pathMode) {
  const star = pathMode ? '[^/]*' : '.*';
  const body = pattern
    .split('**')
    .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join(star))
    .join('.*');
  return new RegExp(`^${body}$`, 's');
}

// Does one target match a pattern?
//   "prefix:*"       a command that starts with prefix as whole words ("npm test:*" matches "npm test -w x", not "npm testing")
//   "domain:host"    a URL whose host is host or a subdomain of it
//   anything else    a glob (see globToRegex)
export function matchesPattern(pattern, target, { pathMode = false } = {}) {
  if (pattern === null) return true;
  const t = String(target ?? '').trim();
  if (pattern.startsWith('domain:')) {
    let host;
    try {
      host = new URL(t).hostname;
    } catch {
      return false;
    }
    const domain = pattern.slice('domain:'.length).toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  if (pattern.endsWith(':*')) {
    // A whole command never matches a prefix when it chains something on (rules see the pieces; this is a second guard).
    const prefix = pattern.slice(0, -2).trim();
    if (SEGMENT_SPLIT.test(t)) return false;
    return t === prefix || t.startsWith(`${prefix} `);
  }
  return globToRegex(pattern, pathMode).test(t);
}

// Read-only shell commands that run without asking. Anything with a redirect, a substitution, or an
// unknown first word is not in this list and goes through the normal rules.
const READ_ONLY_FIRST = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'pwd', 'echo', 'grep', 'rg', 'findstr', 'where', 'which',
  'get-childitem', 'get-content', 'select-string', 'get-location', 'get-item', 'test-path',
]);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame']);
const FIND_UNSAFE = /^-(exec|execdir|delete|ok|okdir|fprint|fls|fprintf)$/;

export function isReadOnlyCommand(command) {
  if (/[<>]|\$\(|`/.test(String(command))) return false;
  const segments = segmentsOf(command);
  if (!segments.length) return false;
  return segments.every((seg) => {
    const words = seg.split(/\s+/);
    const first = words[0].toLowerCase();
    if (first === 'git') return READ_ONLY_GIT.has((words[1] ?? '').toLowerCase());
    if (first === 'find') return !words.some((w) => FIND_UNSAFE.test(w));
    return READ_ONLY_FIRST.has(first);
  });
}

// What a rule is matched against, and how: 'any' target matching is enough (deny, ask), 'all' means every
// piece of a command must match (allow). Commands are split into pieces; paths are tried relative and absolute.
function targetsOf(tool, input, cwd) {
  if (tool.name === 'bash') {
    const segments = segmentsOf(input?.command);
    // Every piece must match an allow rule, and a command with a substitution never matches one.
    return { list: segments, pieces: true, all: segments.length > 0 && !/\$\(|`/.test(String(input?.command)), pathMode: false };
  }
  if (tool.pathTarget) {
    const raw = String(input?.path ?? '.');
    const abs = path.resolve(cwd, raw);
    const rel = path.relative(cwd, abs);
    const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    return { list: [inside ? rel.split(path.sep).join('/') : abs.split(path.sep).join('/'), abs.split(path.sep).join('/')], all: true, pathMode: true };
  }
  const target = tool.target ? tool.target(input ?? {}) : tool.describeCall ? tool.describeCall(input ?? {}) : JSON.stringify(input ?? {});
  return { list: [String(target)], all: true, pathMode: false };
}

// A rule to offer for "don't ask again": bash(npm test:*) for a plain command, else the tool name.
export function suggestRule(tool, input) {
  if (tool.name === 'bash') {
    const cmd = String(input?.command ?? '').trim();
    const words = cmd.split(/\s+/).slice(0, 2).filter((w) => !/[=/\\"']/.test(w));
    if (cmd && segmentsOf(cmd).length === 1 && !/\$\(|`/.test(cmd) && words.length) return `${tool.name}(${words.join(' ')}:*)`;
  }
  return tool.name;
}

// Gate every tool call. Order of checks:
//   1. deny rules: any matching piece of a command, path or URL denies.
//   2. ask rules: force a prompt, even when a broader allow would apply.
//   3. allow rules: every piece of a command must match.
//   4. read-only shell commands run without asking (unless the exec policy is deny).
//   5. the mode policy for the tool's risk class: allow, ask or deny.
//
//   policy:  { read, write, exec } -> 'allow' | 'ask' | 'deny'
//   choose:  async ({ title, options }) -> chosen index (-1 when cancelled), or null when no terminal is attached
//   cwd:     workspace root, used to resolve file paths for path rules
//   onPersist: async (spec) called when the user picks "don't ask again"; the cli saves the rule to the project
export function createPermissions({
  policy, choose = null, autoApprove = false, allow = [], deny = [], ask = [],
  cwd = process.cwd(), onPersist = null,
}) {
  let current = { ...policy };
  const rules = []; // { tool, pattern, spec, mode } in the order they were added

  const add = (spec, mode) => {
    const r = parseRuleSpec(spec);
    const i = rules.findIndex((x) => x.spec === r.spec);
    if (i !== -1) rules.splice(i, 1);
    if (mode) rules.push({ ...r, mode });
  };
  for (const s of allow) add(s, 'allow');
  for (const s of deny) add(s, 'deny');
  for (const s of ask) add(s, 'ask');

  const hit = (rule, tool, input, mode) => {
    if (rule.tool !== tool.name.toLowerCase()) return false;
    if (rule.pattern === null) return true;
    const { list, all, pieces, pathMode } = targetsOf(tool, input, cwd);
    if (mode === 'all') {
      if (!all) return false;
      return pieces ? list.every((t) => matchesPattern(rule.pattern, t, { pathMode })) : list.some((t) => matchesPattern(rule.pattern, t, { pathMode }));
    }
    return list.some((t) => matchesPattern(rule.pattern, t, { pathMode }));
  };
  const any = (mode, tool, input, want) => rules.some((r) => r.mode === want && hit(r, tool, input, mode));

  // Returns 'deny' | 'ask' | 'allow' from rules, or null when no rule decides.
  const ruleVerdict = (tool, input) => {
    if (any('any', tool, input, 'deny')) return 'deny';
    if (any('any', tool, input, 'ask')) return 'ask';
    if (any('all', tool, input, 'allow')) return 'allow';
    return null;
  };

  return {
    getPolicy: () => ({ ...current }),
    setPolicy(next) {
      current = { ...next };
    },
    getRules: () => Object.fromEntries(rules.map((r) => [r.spec, r.mode])),
    // mode 'allow' | 'deny' | 'ask' adds or replaces a rule; null or 'remove' removes it.
    setRule(spec, mode) {
      add(spec, mode === 'remove' ? null : mode);
    },

    async check(tool, input) {
      const verdict = ruleVerdict(tool, input);
      if (verdict === 'deny') return { allowed: false, reason: `${tool.name} is denied by a rule` };
      if (verdict === 'allow') return { allowed: true };

      const mode = current[tool.risk] ?? 'ask';
      if (verdict !== 'ask') {
        if (mode === 'deny') return { allowed: false, reason: `${tool.risk} tools are disabled` };
        if (mode === 'allow') return { allowed: true };
        if (tool.name === 'bash' && mode !== 'deny' && isReadOnlyCommand(input?.command)) return { allowed: true };
      }
      if (verdict !== 'ask' && autoApprove) return { allowed: true };
      if (!choose) {
        return { allowed: false, reason: `${tool.name} needs approval; run interactively or pass --yes` };
      }

      const summary = tool.describeCall ? tool.describeCall(input) : JSON.stringify(input).slice(0, 120);
      const suggestion = suggestRule(tool, input);
      const picked = await choose({
        title: `Allow ${tool.name} (${summary})?`,
        options: ['Yes', `Yes, and don't ask again for ${suggestion} in this project`, 'No'],
      });
      if (picked === 1) {
        add(suggestion, 'allow');
        if (onPersist) await onPersist(suggestion).catch(() => {});
        return { allowed: true };
      }
      if (picked === 0) return { allowed: true };
      return { allowed: false, reason: 'denied by user' };
    },
  };
}
