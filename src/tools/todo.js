// Task list the agent keeps for multi-step work. State lives in the transcript:
// /todos reads the latest todo_write call back out of the session.
export const todoWriteTool = {
  name: 'todo_write',
  description: 'Replace the task list for the current work. Use for multi-step tasks; keep exactly one item in_progress.',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Full list of todo items',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', description: 'pending | in_progress | completed' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  describeCall: (input) => `${input.todos?.length ?? 0} items`,
  async run({ todos }) {
    const open = todos.filter((t) => t.status !== 'completed').length;
    return `todo list updated: ${todos.length} items, ${open} open`;
  },
};

export const todoTools = [todoWriteTool];
