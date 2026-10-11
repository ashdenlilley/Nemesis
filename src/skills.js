import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';

// A skill is a folder with a SKILL.md: frontmatter name and description, then instructions.
// Only the names and descriptions go into the system prompt. The skill tool loads the body on demand.
export async function loadSkills(dirs) {
  const skills = new Map();
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'SKILL.md');
      let raw;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(raw);
      const name = String(data.name ?? entry.name).toLowerCase();
      skills.set(name, {
        name,
        description: data.description ?? '(no description)',
        body,
        dir: path.join(dir, entry.name),
      });
    }
  }
  return skills;
}

export function skillsPromptSection(skills) {
  if (!skills.size) return '';
  const lines = [...skills.values()].map((s) => `- ${s.name}: ${s.description}`);
  return `Skills (call the skill tool with a name to load its full instructions when the task matches):\n${lines.join('\n')}`;
}

export function createSkillTool(skills) {
  return {
    name: 'skill',
    risk: 'read',
    concurrent: true,
    description: 'Load a skill by name: returns its full instructions. Skills are listed in the system prompt.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name from the system prompt' } },
      required: ['name'],
    },
    describeCall: (input) => input.name,
    run({ name }) {
      const skill = skills.get(String(name).toLowerCase());
      if (!skill) throw new Error(`unknown skill "${name}"; available: ${[...skills.keys()].join(', ') || 'none'}`);
      return `${skill.body}\n\n(skill directory: ${skill.dir})`;
    },
  };
}
