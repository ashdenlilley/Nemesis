import { fileTools } from './files.js';
import { searchTools } from './search.js';
import { shellTools } from './shell.js';
import { todoTools } from './todo.js';

// Tool contract:
//   name, description, parameters (JSON schema), risk: 'read' | 'write' | 'exec'
//   run(input, { cwd, roots, signal }) -> string (throw to report an error to the model)
//   describeCall?(input) -> short summary shown in logs and permission prompts
export function createBuiltinTools() {
  return [...fileTools, ...searchTools, ...shellTools, ...todoTools];
}
