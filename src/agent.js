import { validateInput } from './schema.js';
import { truncateMiddle } from './tools/text.js';
import { maybeCompact } from './compact.js';

export const MAX_RESULT_CHARS = 50_000;

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
    outcome = { content: truncateMiddle(String(output), MAX_RESULT_CHARS), isError: false };
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

// Assistant blocks kept in history. Empty text is dropped (providers reject it).
function normalizeContent(blocks) {
  const kept = blocks.filter((b) => (b.type === 'text' && b.text.trim()) || b.type === 'tool_use');
  return kept.length ? kept : [{ type: 'text', text: '(no response)' }];
}

// One user turn: call the model, run requested tools, repeat until the model stops.
//   runtime: { provider, config, tools, system, session, permissions, ui, ctx, hooks?, usage?, model?, maxSteps?, takeFollowUps? }
// takeFollowUps() returns the prompts the user queued during the turn. They join the tool results after each tool round.
export async function runAgentTurn({
  provider, config, tools, system, session, permissions, ui, ctx,
  hooks = null, usage = null, model = null, maxSteps, takeFollowUps = null,
}) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const apiTools = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const limit = maxSteps ?? config.maxSteps;

  try {
    for (let step = 0; step < limit; step++) {
      if (config.autoCompact !== false) {
        await maybeCompact({ session, provider, config, system, ui, signal: ctx.signal });
      }

      let streamed = false;
      const response = await provider.createMessage({
        system,
        messages: session.messages,
        tools: apiTools,
        signal: ctx.signal,
        model,
        onText: (delta) => {
          streamed = true;
          ui.streamText(delta);
        },
      });
      usage?.add(response.usage);

      const content = normalizeContent(response.content.filter((b) => b.type === 'text' || b.type === 'tool_use'));
      await session.append({ role: 'assistant', content });
      if (streamed) ui.endStream();
      else {
        for (const block of content) {
          if (block.type === 'text') ui.assistant(block.text);
        }
      }

      const uses = content.filter((b) => b.type === 'tool_use');
      if (response.stopReason !== 'tool_use' || uses.length === 0) {
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
      for (const use of uses) {
        ui.toolCall(use, toolMap.get(use.name));
        const outcome = await executeToolUse(use, { toolMap, permissions, ctx, hooks });
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
    }
    ui.warn(`stopped after ${limit} steps; raise maxSteps or send a follow-up`);
    return { stopReason: 'max_steps' };
  } catch (err) {
    await settleDanglingToolUses(session);
    throw err;
  }
}
