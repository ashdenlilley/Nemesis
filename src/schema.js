// Minimal JSON-schema input validation for tool calls.
// Covers what tool definitions use: object properties, required keys, primitive types.

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
};

export function validateInput(schema, input) {
  if (!TYPE_CHECKS.object(input)) return 'input must be an object';
  for (const key of schema.required ?? []) {
    if (!(key in input)) return `missing required field "${key}"`;
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!(key in input) || input[key] === undefined) continue;
    const check = TYPE_CHECKS[prop.type];
    if (check && !check(input[key])) return `field "${key}" must be ${prop.type}`;
  }
  return null;
}
