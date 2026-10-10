import { getFirstLine } from './tools/text.js';
import { accentOpen, colorDepth, RESET } from './theme.js';
import { logoLines } from './logo.js';

const CODES = { dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', bold: '\x1b[1m' };
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// depth: 'truecolor' | '256' | 'basic' | 'none'. color: true/false overrides detection (tests).
export function createUI({ out = process.stdout, err = process.stderr, color, depth } = {}) {
  const level = depth ?? (color === false ? 'none' : color === true ? 'truecolor' : colorDepth(process.env, err.isTTY));
  const accent = accentOpen(level);
  const paintWith = (open, text) => (level === 'none' || !open ? text : `${open}${text}${RESET}`);
  const paint = (style, text) => paintWith(CODES[style] ?? '', text);
  const accentText = (text) => paintWith(accent + CODES.bold, text);
  let streaming = false;

  const summarize = (tool, input) => {
    if (tool?.describeCall) return getFirstLine(tool.describeCall(input), 100);
    return getFirstLine(JSON.stringify(input ?? {}), 100);
  };

  const width = () => Math.min(out.columns || err.columns || 80, 100);

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

    // Logo on the left, session info on the right. Plain title lines if the logo file is missing.
    banner({ version, provider, model, cwd, session }) {
      const info = [
        { text: `Nemesis ${version}`, style: 'title' },
        { text: `${provider}/${model}`, style: 'plain' },
        { text: cwd, style: 'dim' },
        { text: `session ${session}`, style: 'dim' },
      ];
      const cols = width() >= 90 ? 52 : 34;
      const logo = logoLines(cols);
      if (!logo) {
        err.write(`${accentText(`✻ Nemesis ${version}`)}\n`);
        for (const line of info.slice(1)) err.write(`  ${paint(line.style === 'dim' ? 'dim' : 'plain', line.text)}\n`);
        return;
      }
      const top = Math.max(0, Math.floor((logo.length - info.length) / 2));
      const room = width() - cols - 4;
      for (let r = 0; r < logo.length; r++) {
        const item = info[r - top];
        let right = '';
        if (item) {
          const text = item.text.length > room ? `${item.text.slice(0, room - 1)}…` : item.text;
          right = item.style === 'title' ? accentText(text) : item.style === 'dim' ? paint('dim', text) : text;
        }
        err.write(`${paintWith(accent, logo[r].padEnd(cols))}   ${right}\n`);
      }
    },

    // Horizontal rule in the accent color, drawn above the prompt.
    rule() {
      err.write(`${paintWith(accent, '─'.repeat(width()))}\n`);
    },

    // readline prompt string (readline ignores ANSI when measuring width).
    prompt() {
      return `${paintWith(accent, '❯')} `;
    },

    // One line under the answer: model, requests, tokens.
    status(text) {
      err.write(`${paint('dim', `  ${text}`)}\n`);
    },

    toolCall(use, tool) {
      err.write(`${accentText('⏺')} ${use.name}${paint('dim', `(${summarize(tool, use.input)})`)}\n`);
    },
    toolResult(use, outcome) {
      const preview = getFirstLine(outcome.content, 120);
      err.write(paint(outcome.isError ? 'red' : 'dim', `  ⎿  ${preview}\n`));
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
    accent(text) {
      return accentText(text);
    },
    // Quiet view for sub-agents: tool activity only, prefixed with the agent name.
    child(label) {
      const tag = `   ${paint('dim', `[${label}]`)}`;
      return {
        streamText() {},
        endStream() {},
        assistant() {},
        info() {},
        bold: (t) => t,
        toolCall(use, tool) {
          err.write(`${tag} ${accentText('⏺')} ${use.name}${paint('dim', `(${summarize(tool, use.input)})`)}\n`);
        },
        toolResult(use, outcome) {
          if (outcome.isError) err.write(`${tag}   ${paint('red', `⎿  ${getFirstLine(outcome.content, 100)}`)}\n`);
        },
        warn: (t) => err.write(`${tag} ${paint('yellow', `warning: ${t}`)}\n`),
        error: (t) => err.write(`${tag} ${paint('red', `error: ${t}`)}\n`),
      };
    },
  };
}

export { stripAnsi };
