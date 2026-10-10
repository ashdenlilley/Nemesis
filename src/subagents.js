import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runAgentTurn } from './agent.js';
import { parseFrontmatter } from './frontmatter.js';
import { buildSystemPrompt, BASE_PROMPT } from './prompt.js';
import { Session } from './session.js';

// Sub-agent = isolated context window with its own tool subset and step budget.
// Definitions: built-ins below, plus markdown files in ~/.nemesis/agents and .nemesis/agents:
//   ---
//   name: reviewer
//   description: Reviews diffs for bugs
//   tools: read_file, glob, grep
//   model: claude-haiku-5-5        (optional)
//   maxSteps: 15                   (optional)
//   ---
//   System prompt body...
export const BUILTIN_AGENTS = [
  {
    name: 'general',
    description: 'General-purpose agent for multi-step research or changes',
    tools: '*',
    maxSteps: 30,
    prompt: `${BASE_PROMPT}\n\nYou are a sub-agent handling one delegated task. Work independently. Do not ask questions; state assumptions. End with a concise final report of findings or changes.`,
  },
  {
    name: 'explore',
    description: 'Read-only codebase search and summarization',
    tools: ['read_file', 'glob', 'grep'],
    maxSteps: 20,
    prompt: 'You are a read-only exploration sub-agent. Locate and read code to answer the delegated question. You cannot modify files. Reply with file:line references and a short summary.',
  },
];

function parseToolList(value) {
  if (!value || value.trim() === '*') return '*';
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export async function loadAgentDefs(dirs) {
  const defs = new Map(BUILTIN_AGENTS.map((a) => [a.name, a]));
  for (const dir of dirs) {
    let names;
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
    } catch {
      continue; // directory absent
    }
    for (const file of names) {
      const { data, body } = parseFrontmatter(await readFile(path.join(dir, file), 'utf8'));
      const name = data.name ?? path.basename(file, '.md');
      defs.set(name, {
        name,
        description: data.description ?? '',
        tools: parseToolList(data.tools),
        model: data.model || null,
        maxSteps: Number(data.maxSteps) || 25,
        prompt: body || BASE_PROMPT,
      });
    }
  }
  return defs;
}

function lastAssistantText(session) {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      return m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    }
  }
  return '';
}

// allTools must exclude the task tool itself, which caps delegation at one level.
// getRuntime() returns the live { provider, config } so /login and /model take effect.
export function createSubagentRunner({ agents, allTools, getRuntime, permissions, ui, hooks, cwd }) {
  return {
    agents,
    async run({ agentName, prompt }, ctx) {
      const def = agents.get(agentName);
      if (!def) {
        throw new Error(`unknown agent "${agentName}". available: ${[...agents.keys()].join(', ')}`);
      }
      const { provider, config } = getRuntime();
      const tools = def.tools === '*' ? allTools : allTools.filter((t) => def.tools.includes(t.name));
      const session = Session.memory();
      await session.append({ role: 'user', content: prompt });
      const system = await buildSystemPrompt({ cwd, base: def.prompt, outputStyle: config.outputStyle });

      await runAgentTurn({
        provider,
        config,
        tools,
        system,
        session,
        permissions,
        ui: ui.child(def.name),
        ctx,
        hooks,
        model: def.model,
        maxSteps: def.maxSteps,
      });
      return lastAssistantText(session) || '(sub-agent finished without a text report)';
    },
  };
}

export function createTaskTool(runner) {
  const list = [...runner.agents.values()].map((a) => `${a.name} (${a.description})`).join('; ');
  return {
    name: 'task',
    risk: 'read',
    description: `Delegate a self-contained task to a sub-agent with its own context window. Only its final report returns to you, so use it for broad searches or independent sub-tasks. The sub-agent sees nothing except the prompt you give it. Agents: ${list}`,
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short label, 3-6 words' },
        prompt: { type: 'string', description: 'Complete instructions, including every fact the sub-agent needs' },
        subagent_type: { type: 'string', description: 'Agent name; default general' },
      },
      required: ['prompt'],
    },
    describeCall: (input) => `${input.subagent_type ?? 'general'}: ${input.description ?? input.prompt}`.slice(0, 120),
    run: (input, ctx) => runner.run({ agentName: input.subagent_type ?? 'general', prompt: input.prompt }, ctx),
  };
}
