// exit_plan_mode: in plan mode the model cannot change anything. When its plan is ready it calls this tool,
// the user reads the plan and approves or rejects it. Approval leaves plan mode so the plan can be carried out.
// approve(plan) -> boolean, supplied by the cli (it shows the plan and asks).
export function createPlanTool(approve) {
  return {
    name: 'exit_plan_mode',
    risk: 'read',
    description: 'Plan mode only. Present your plan for the user to approve. Approval leaves plan mode so you can make the changes. Call this once the plan is complete; do not start editing before approval.',
    parameters: {
      type: 'object',
      properties: { plan: { type: 'string', description: 'The plan, in Markdown: the steps, the files involved, and how it will be verified' } },
      required: ['plan'],
    },
    describeCall: () => 'plan for approval',
    async run({ plan }) {
      const ok = await approve(String(plan));
      return ok
        ? 'Plan approved. Plan mode is off; carry out the plan.'
        : 'Plan not approved. Stay read-only and revise the plan with the user.';
    },
  };
}
