// Context compaction: summarize older turns so long sessions fit the context window.
// The cut always lands on a plain user-text message, so tool_use / tool_result pairs never split.

export const SUMMARY_SYSTEM = `You compress a coding-agent conversation so the agent can continue it.
Write a dense plain-text summary: user goals, decisions made, files read or changed (with paths),
commands run and their outcomes, errors and fixes, and open tasks. Under 1500 words. No preamble.`;

const MAX_TRANSCRIPT_CHARS = 300_000;

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}...[+${text.length - max} chars]` : text;
}

export function estimateTokens(system, messages) {
  return Math.ceil((system.length + JSON.stringify(messages).length) / 4);
}

// Index of the latest plain-text user message at or before the last keepRecent messages, or -1.
export function findCutIndex(messages, keepRecent = 4) {
  for (let i = messages.length - keepRecent; i > 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') return i;
  }
  return -1;
}

export function serializeForSummary(messages, perItem = 2000) {
  const lines = messages.map((m) => {
    const who = m.role.toUpperCase();
    if (typeof m.content === 'string') return `${who}: ${clip(m.content, perItem)}`;
    return m.content
      .map((b) => {
        if (b.type === 'text') return `${who}: ${clip(b.text, perItem)}`;
        if (b.type === 'tool_use') return `TOOL CALL ${b.name} ${clip(JSON.stringify(b.input), 500)}`;
        if (b.type === 'tool_result') {
          return `TOOL RESULT${b.is_error ? ' (error)' : ''}: ${clip(String(b.content), perItem)}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  });
  const text = lines.join('\n');
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text;
}

export async function compactSession({ session, provider, signal, instructions = '', keepRecent = 4 }) {
  const cut = findCutIndex(session.messages, keepRecent);
  if (cut <= 0) return { compacted: false, reason: 'not enough history to compact' };

  const old = session.messages.slice(0, cut);
  const kept = session.messages.slice(cut);
  const focus = instructions ? `\n\nFocus on: ${instructions}` : '';
  const res = await provider.createMessage({
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: `${serializeForSummary(old)}${focus}` }],
    tools: [],
    signal,
    maxTokens: 4096,
  });
  const summary = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!summary) throw new Error('compaction returned no summary; session unchanged');

  const next = [
    { role: 'user', content: `[Summary of earlier conversation]\n${summary}` },
    { role: 'assistant', content: [{ type: 'text', text: 'Understood. Continuing from that summary.' }] },
    ...kept,
  ];
  await session.replace(next, { archive: true });
  return { compacted: true, removed: old.length, kept: kept.length };
}

// Compact only when the estimated prompt crosses threshold * contextWindow.
export async function maybeCompact({ session, provider, config, system, ui, signal }) {
  const window = config.contextWindow ?? 128_000;
  const used = estimateTokens(system, session.messages);
  if (used < window * (config.compactThreshold ?? 0.8)) return false;
  ui.info(`context ~${used} tokens; compacting older turns`);
  const result = await compactSession({ session, provider, signal });
  if (result.compacted) ui.info(`compacted ${result.removed} messages into a summary`);
  return result.compacted;
}
