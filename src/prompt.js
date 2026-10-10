import { readFile } from 'node:fs/promises';
import path from 'node:path';

// First match wins. Lets a repo steer the agent without touching harness code.
const INSTRUCTION_FILES = ['NEMESIS.md', 'AGENTS.md', 'CLAUDE.md'];

export const BASE_PROMPT = `You are Nemesis, a coding agent running in a terminal.

Work in small verified steps:
- Read a file before editing it. Prefer edit_file over rewriting whole files.
- Use glob and grep to locate code before assuming where it lives.
- For self-contained research or multi-file exploration, delegate with the task tool to keep this context small.
- After a change, run the project's tests or build when one exists, and report the result.
- Stay inside the workspace. Ask the user before destructive commands.
- Answer briefly. Report what changed and what was verified, not a narration of steps.`;

const STYLE_PROMPTS = {
  default: '',
  concise: 'Keep responses to a few sentences unless the user asks for detail.',
  explanatory: 'Explain your reasoning and the relevant trade-offs briefly as you work.',
};

export async function buildSystemPrompt({
  cwd,
  platform = process.platform,
  now = new Date(),
  base = BASE_PROMPT,
  outputStyle = 'default',
  extra = [],
}) {
  const parts = [
    base,
    `Environment:\n- Working directory: ${cwd}\n- Platform: ${platform}\n- Date: ${now.toISOString().slice(0, 10)}`,
  ];
  if (STYLE_PROMPTS[outputStyle]) parts.push(STYLE_PROMPTS[outputStyle]);
  if (extra.length) parts.push(`Context from hooks:\n${extra.join('\n')}`);

  for (const name of INSTRUCTION_FILES) {
    try {
      const text = await readFile(path.join(cwd, name), 'utf8');
      parts.push(`Project instructions (${name}):\n${text.trim()}`);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return parts.join('\n\n');
}
