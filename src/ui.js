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

  // Layout state. Blocks are user prompts, assistant text, tool activity, and meta lines.
  // A blank line separates consecutive blocks of different kinds; none goes inside a block.
  let last = null; // kind of the block last written, or null after a rule
  let held = ''; // newlines from assistant text, written only if more text follows in the same block
  let midLine = false; // stdout text is missing its final newline

  const startBlock = (kind, stream) => {
    if (midLine) {
      out.write('\n');
      midLine = false;
    }
    if (last !== null && last !== kind) stream.write('\n');
    if (last !== kind) held = '';
    last = kind;
  };

  // Assistant text. Trailing newlines are held back so a block never ends with a blank line.
  const writeText = (chunk) => {
    const trailing = /\n*$/.exec(chunk)[0];
    let core = chunk.slice(0, chunk.length - trailing.length);
    if (core) {
      // A new block starts on a fresh line; a continuing one picks up mid-line where the last chunk ended.
      if (last !== 'text') {
        core = core.replace(/^\n+/, '');
        startBlock('text', out);
      }
      out.write(held + core);
      held = '';
      midLine = true;
    } else if (last === 'text') {
      held += trailing;
    }
  };

  const summarize = (tool, input) => {
    if (tool?.describeCall) return getFirstLine(tool.describeCall(input), 100);
    return getFirstLine(JSON.stringify(input ?? {}), 100);
  };

  const width = () => Math.min(out.columns || err.columns || 80, 100);

  return {
    streamText(delta) {
      writeText(delta);
    },
    endStream() {
      if (midLine) {
        out.write('\n');
        midLine = false;
      }
      held = '';
    },
    assistant(text) {
      writeText(text.trim());
      if (midLine) {
        out.write('\n');
        midLine = false;
      }
      // A following text block in the same response starts after one blank line.
      held = '\n';
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

    // Dim rule above the prompt. Starts a new block, so the next block follows it without a gap.
    rule() {
      last = null;
      held = '';
      err.write(`${paint('dim', '─'.repeat(width()))}\n`);
    },

    // readline prompt string (readline ignores ANSI when measuring width).
    prompt() {
      return `${paintWith(accent, '❯')} `;
    },

    // A submitted prompt, echoed into the feed. Follow-ups sent mid-turn are echoed when they reach the model.
    userMessage(text) {
      startBlock('user', err);
      const [first, ...rest] = text.split('\n');
      const lines = [`${paintWith(accent, '❯')} ${first}`, ...rest.map((l) => `  ${l}`)];
      err.write(`${lines.join('\n')}\n`);
    },

    // A follow-up waiting for the next tool call.
    queued(text) {
      startBlock('meta', err);
      err.write(`${paint('dim', `  queued: ${getFirstLine(text, 100)}`)}\n`);
    },

    // One line under the answer: model, requests, tokens.
    status(text) {
      startBlock('meta', err);
      err.write(`${paint('dim', `  ${text}`)}\n`);
    },

    toolCall(use, tool) {
      startBlock('tool', err);
      err.write(`${accentText('>_')} ${use.name}${paint('dim', `(${summarize(tool, use.input)})`)}\n`);
    },
    toolResult(use, outcome) {
      startBlock('tool', err);
      const text = String(outcome.content ?? '').trim();
      const more = text.split('\n').length - 1;
      const preview = getFirstLine(text, 120);
      const tail = more > 0 ? ` … +${more} lines` : '';
      err.write(paint(outcome.isError ? 'red' : 'dim', `  ⎿  ${preview}${tail}\n`));
    },
    info(text) {
      startBlock('meta', err);
      err.write(`${text}\n`);
    },
    warn(text) {
      startBlock('meta', err);
      err.write(paint('yellow', `warning: ${text}\n`));
    },
    error(text) {
      startBlock('meta', err);
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
          startBlock('tool', err);
          err.write(`${tag} ${accentText('>_')} ${use.name}${paint('dim', `(${summarize(tool, use.input)})`)}\n`);
        },
        toolResult(use, outcome) {
          if (outcome.isError) {
            startBlock('tool', err);
            err.write(`${tag}   ${paint('red', `⎿  ${getFirstLine(outcome.content, 100)}`)}\n`);
          }
        },
        warn: (t) => err.write(`${tag} ${paint('yellow', `warning: ${t}`)}\n`),
        error: (t) => err.write(`${tag} ${paint('red', `error: ${t}`)}\n`),
      };
    },
  };
}

export { stripAnsi };
