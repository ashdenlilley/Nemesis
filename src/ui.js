import { getFirstLine } from './tools/text.js';

const CODES = { dim: '2', red: '31', yellow: '33', bold: '1' };

export function createUI({ out = process.stdout, err = process.stderr, color } = {}) {
  const useColor = color ?? (Boolean(err.isTTY) && !process.env.NO_COLOR);
  const paint = (style, text) => (useColor ? `\x1b[${CODES[style]}m${text}\x1b[0m` : text);
  let streaming = false;

  const summarize = (tool, input) => {
    if (tool?.describeCall) return getFirstLine(tool.describeCall(input), 100);
    return getFirstLine(JSON.stringify(input ?? {}), 100);
  };

  return {
    streamText(delta) {
      streaming = true;
      out.write(delta);
    },
    endStream() {
      if (streaming) out.write('\n');
      streaming = false;
    },
    assistant(text) {
      out.write(`${text.trimEnd()}\n`);
    },
    toolCall(use, tool) {
      err.write(paint('dim', `• ${use.name} ${summarize(tool, use.input)}\n`));
    },
    toolResult(use, outcome) {
      const preview = getFirstLine(outcome.content, 120);
      err.write(paint(outcome.isError ? 'red' : 'dim', `  ↳ ${preview}\n`));
    },
    info(text) {
      err.write(`${text}\n`);
    },
    warn(text) {
      err.write(paint('yellow', `warning: ${text}\n`));
    },
    error(text) {
      err.write(paint('red', `error: ${text}\n`));
    },
    bold(text) {
      return paint('bold', text);
    },
    dim(text) {
      return paint('dim', text);
    },
    // Quiet view for sub-agents: tool activity only, prefixed with the agent name.
    child(label) {
      const tag = `   [${label}]`;
      return {
        streamText() {},
        endStream() {},
        assistant() {},
        info() {},
        bold: (t) => t,
        toolCall(use, tool) {
          err.write(paint('dim', `${tag} • ${use.name} ${summarize(tool, use.input)}\n`));
        },
        toolResult(use, outcome) {
          if (outcome.isError) err.write(paint('red', `${tag}   ↳ ${getFirstLine(outcome.content, 100)}\n`));
        },
        warn: (t) => err.write(paint('yellow', `${tag} warning: ${t}\n`)),
        error: (t) => err.write(paint('red', `${tag} error: ${t}\n`)),
      };
    },
  };
}
