import { validateInput } from './schema.js';
import { truncateMiddle } from './tools/text.js';
import { maybeCompact } from './compact.js';

export const MAX_RESULT_CHARS = 50_000;
export const STREAM_RETRIES = 2; // a reply cut off mid-stream is requested again this many times
const TRUNCATED_TOOL = 'Your output hit the max_tokens limit before this tool call was complete, so it was not run. Call it again with smaller input, for example by writing a large file in several edits.';

export async function executeToolUse(use, { toolMap, permissions, ctx, hooks = null }) {
  const tool = toolMap.get(use.name);
  if (!tool) return { content: `Unknown tool: ${use.name}`, isError: true };

  const problem = validateInput(tool.parameters, use.input ?? {});
  if (problem) return { content: `Invalid input for ${tool.name}: ${problem}`, isError: true };

  if (hooks) {
    const pre = await hooks.fire('PreToolUse', { tool_name: use.name, tool_input: use.input }, { toolName: use.name });
    if (pre.blocked) return { content: `Blocked by hook: ${pre.reason}`, isError: true };
  }

  const decision = await permissions.check(tool, use.input);
  if (!decision.allowed) return { content: `Permission denied: ${decision.reason}`, isError: true };

  let outcome;
  try {
    const output = await tool.run(use.input, ctx);
    // A tool may return { content, display }: content goes to the model, display only to the UI.
    const rich = output !== null && typeof output === 'object' && 'content' in output;
    outcome = { content: truncateMiddle(String(rich ? output.content : output), MAX_RESULT_CHARS), isError: false };
    if (rich && output.display) outcome.display = output.display;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    outcome = { content: `Error: ${err.message}`, isError: true };
  }

  if (hooks) {
    await hooks.fire('PostToolUse', {
      tool_name: use.name,
      tool_input: use.input,
      tool_response: outcome.content,
      is_error: outcome.isError,
    }, { toolName: use.name });
  }
  return outcome;
}

// JSON with sorted keys, so the same input always produces the same string.
export function stableJson(value) {
  return JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    : v));
}

// Stops a turn that keeps making the same call and getting the same result. The warning is added to
// the tool result so the model sees it; the turn stops at stopAt repeats.
export function createLoopGuard({ warnAt = 3, stopAt = 6 } = {}) {
  let last = null;
  let count = 0;
  return {
    note(use, outcome) {
      const key = `${use.name}\u0000${stableJson(use.input ?? {})}\u0000${outcome.isError ? 'E' : 'O'}${outcome.content}`;
      count = key === last ? count + 1 : 1;
      last = key;
      if (count === stopAt) {
        return { stop: true, text: `\n[nemesis] This exact call has returned the same result ${count} times in a row. The turn is being stopped.` };
      }
      if (count === warnAt) {
        return { stop: false, text: `\n[nemesis] This exact call has returned the same result ${count} times in a row. Try a different approach instead of repeating it.` };
      }
      return null;
    },
  };
}

// Every tool_use needs a matching tool_result or the next API call is rejected.
// Called when a turn is interrupted mid-tool.
export async function settleDanglingToolUses(session, reason = 'Interrupted before tool completed') {
  const last = session.messages.at(-1);
  if (!last || last.role !== 'assistant' || typeof last.content === 'string') return;
  const uses = last.content.filter((b) => b.type === 'tool_use');
  if (uses.length === 0) return;
  await session.append({
    role: 'user',
    content: uses.map((use) => ({
      type: 'tool_result',
      tool_use_id: use.id,
      content: reason,
      is_error: true,
    })),
  });
}

// Assistant blocks kept in history. Empty text is dropped (providers reject it). Thinking blocks stay,
// unchanged: Anthropic rejects a tool-use turn whose thinking was removed, and edited history.
const KEPT_BLOCKS = new Set(['tool_use', 'thinking', 'redacted_thinking']);
function normalizeContent(blocks) {
  const kept = blocks.filter((b) => (b.type === 'text' && b.text.trim()) || KEPT_BLOCKS.has(b.type));
  return kept.some((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
    ? kept
    : [...kept, { type: 'text', text: '(no response)' }];
}

// One model call. A retryable failure after the stream opened (dropped connection, stall, early close)
// requests the reply again; HTTP-level retries already happen inside the provider.
async function requestReply({ provider, request, ui, progress, signal }) {
  for (let attempt = 0; ; attempt++) {
    let streamed = false;
    progress?.phase('model');
    try {
      const response = await provider.createMessage({
        ...request,
        signal,
        onActivity: () => progress?.activity(),
        onRetry: ({ attempt: n, retries, delayMs, error }) => {
          progress?.retry?.(`${error.message}; retry ${n}/${retries} in ${Math.round(delayMs / 1000)}s`);
        },
        onText: (delta) => {
          streamed = true;
          progress?.activity();
          ui.streamText(delta);
        },
        onThinking: (delta) => {
          streamed = true;
          progress?.activity();
          ui.streamThinking?.(delta);
        },
      });
      return { response, streamed };
    } catch (err) {
      if (streamed) ui.endStream();
      if (!err.retryable || attempt >= STREAM_RETRIES || signal?.aborted) throw err;
      ui.warn(`${err.message}; requesting the reply again (${attempt + 1}/${STREAM_RETRIES})`);
    }
  }
}

// One user turn: call the model, run requested tools, repeat until the model stops.
//   runtime: { provider, config, tools, system, session, permissions, ui, ctx, hooks?, usage?, model?, maxSteps?, takeFollowUps?, progress? }
// takeFollowUps() returns the prompts the user queued during the turn. They join the tool results after each tool round.
// progress: { phase('model' | 'tool'), activity(), retry(message) } drives the status line; all optional.
export async function runAgentTurn({
  provider, config, tools, system, session, permissions, ui, ctx,
  hooks = null, usage = null, model = null, maxSteps, takeFollowUps = null, progress = null,
}) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const apiTools = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  // No limit unless one is set: a turn runs until the model stops or the user interrupts.
  const limit = maxSteps ?? config.maxSteps ?? Infinity;

  try {
    for (let step = 0; step < limit; step++) {
      if (config.autoCompact !== false) {
        await maybeCompact({ session, provider, config, system, ui, signal: ctx.signal });
      }

      const { response, streamed } = await requestReply({
        provider,
        request: { system, messages: session.messages, tools: apiTools, model },
        ui,
        progress,
        signal: ctx.signal,
      });
      usage?.add(response.usage);

      const content = normalizeContent(response.content);
      await session.append({ role: 'assistant', content });
      if (streamed) ui.endStream();
      else {
        for (const block of content) {
          if (block.type === 'text') ui.assistant(block.text);
        }
      }

      const uses = content.filter((b) => b.type === 'tool_use');
      // Cut off at max_tokens mid tool call: the input is incomplete. Every tool_use still needs a
      // tool_result, or each later request in this session is rejected.
      if (response.stopReason === 'max_tokens' && uses.length) {
        ui.warn(`reply hit maxTokens (${config.maxTokens}) during a tool call; asking the model to retry smaller`);
        await session.append({
          role: 'user',
          content: uses.map((use) => ({ type: 'tool_result', tool_use_id: use.id, content: TRUNCATED_TOOL, is_error: true })),
        });
        continue;
      }
      // Tool calls run even when the stop reason says otherwise: some OpenAI-compatible servers send
      // finish_reason "stop" with tool_calls, and leaving them unanswered breaks the session.
      if (uses.length === 0) {
        if (response.stopReason === 'max_tokens') ui.warn(`reply cut off at maxTokens (${config.maxTokens}); raise maxTokens in config or ask it to continue`);
        if (hooks) {
          const stop = await hooks.fire('Stop', { stop_reason: response.stopReason });
          if (stop.blocked) {
            // Stop hook feedback keeps the agent working instead of ending the turn.
            await session.append({ role: 'user', content: `Stop hook feedback: ${stop.reason}` });
            continue;
          }
        }
        return { stopReason: response.stopReason, usage: response.usage };
      }

      const results = [];
      progress?.phase('tool');
      const runOne = (use) => executeToolUse(use, { toolMap, permissions, ctx, hooks });
      // Calls that all declare concurrent (sub-agents, fetches) run together; otherwise one at a time.
      const concurrent = uses.length > 1 && uses.every((u) => toolMap.get(u.name)?.concurrent);
      let outcomes = [];
      if (concurrent) {
        uses.forEach((use) => ui.toolCall(use, toolMap.get(use.name)));
        outcomes = await Promise.all(uses.map(runOne));
      }
      const guard = createLoopGuard();
      let stop = false;
      for (let i = 0; i < uses.length; i++) {
        const use = uses[i];
        if (!concurrent) {
          ui.toolCall(use, toolMap.get(use.name));
          outcomes[i] = await runOne(use);
        }
        const outcome = outcomes[i];
        const note = guard.note(use, outcome);
        if (note) outcome.content = `${outcome.content}${note.text}`;
        if (note?.stop) stop = true;
        ui.toolResult(use, outcome);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: outcome.content,
          is_error: outcome.isError,
        });
      }
      const followUps = takeFollowUps?.() ?? [];
      for (const text of followUps) ui.userMessage(text);
      if (followUps.length) results.push({ type: 'text', text: followUps.join('\n\n') });
      await session.append({ role: 'user', content: results });
      if (stop) {
        ui.warn('stopped: the same tool call kept returning the same result');
        return { stopReason: 'loop' };
      }
    }
    ui.warn(`stopped after ${limit} tool rounds (maxSteps); raise it with /max-steps <n>, or send a follow-up to continue`);
    return { stopReason: 'max_steps' };
  } catch (err) {
    await settleDanglingToolUses(session);
    throw err;
  }
}
