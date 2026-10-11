import { getFirstLine } from './tools/text.js';
import { accentOpen, bgOpen, colorDepth, RESET } from './theme.js';
import { logoLines } from './logo.js';
import { createFlow, createMarkdownStream } from './markdown.js';

const CODES = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', cyan: '\x1b[36m' };
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Short names for built-in tools in the feed, Claude Code style: ● Read(src/cli.js)
const TOOL_LABELS = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Update',
  bash: 'Bash',
  glob: 'Glob',
  grep: 'Search',
  todo_write: 'Todos',
  task: 'Task',
};
// Nemesis mascot: an 8x8 pixel ghost in half blocks (two pixel rows per line), eyes left open.
//   ..####..   .######.   ##.##.##   ##.##.##   ########   ########   ########   #.#..#.#
export const GHOST = [
  ' ▄████▄ ',
  '██ ██ ██',
  '████████',
  '█▀█▀▀█▀█',
];
// Read-only calls collapse into one summary line per run; Ctrl+O shows what each one did.
const CONDENSED = { read_file: 'read', glob: 'search', grep: 'search', web_fetch: 'fetch', web_search: 'search', skill: 'skill' };
const PHRASE = {
  read: (n) => `read ${n} file${n === 1 ? '' : 's'}`,
  search: (n) => `searched ${n} pattern${n === 1 ? '' : 's'}`,
  fetch: (n) => `fetched ${n} page${n === 1 ? '' : 's'}`,
  skill: (n) => `loaded ${n} skill${n === 1 ? '' : 's'}`,
};
const DIFF_LINES = 8; // per side, before "… N more lines"

// depth: 'truecolor' | '256' | 'basic' | 'none'. color: true/false overrides detection (tests).
export function createUI({ out = process.stdout, err = process.stderr, color, depth } = {}) {
  const level = depth ?? (color === false ? 'none' : color === true ? 'truecolor' : colorDepth(process.env, err.isTTY));
  const accent = accentOpen(level);
  const paintWith = (open, text) => (level === 'none' || !open ? text : `${open}${text}${RESET}`);
  const paint = (style, text) => paintWith(CODES[style] ?? '', text);
  const accentText = (text) => paintWith(accent + CODES.bold, text);
  const on = level !== 'none';
  const tones = {
    code: accentOpen(level, '#C9A2FF'),
    userBg: bgOpen(level, '#2E2E33'),
    removed: bgOpen(level, '#4B1D1D', '\x1b[41m'),
    added: bgOpen(level, '#1D3F1D', '\x1b[42m'),
  };
  const mdStyles = on
    ? { code: tones.code, bold: CODES.bold, heading: accent + CODES.bold, reset: RESET }
    : {};

  // Layout state. Blocks are user prompts, assistant text, tool activity, and meta lines.
  // A blank line separates consecutive blocks of different kinds; none goes inside a block.
  let last = null; // kind of the block last written, or null after a rule
  let held = ''; // newlines from assistant text, written only if more text follows in the same block
  let midLine = false; // stdout text is missing its final newline
  let md = null; // Markdown renderer for the text block in progress
  let flow = null; // word wrap for it

  const cols = () => out.columns || err.columns || 80;
  // Full window width, read on every write so a resize takes effect. One column is left free:
  // a row filled to the last column makes some terminals (Windows conhost) wrap an extra blank line.
  const width = () => Math.max(20, cols() - 1);

  const writeOut = (s) => {
    if (!s) return;
    out.write(s);
    midLine = !s.endsWith('\n');
  };

  // Write what the renderer still holds and end the line.
  const finishText = () => {
    if (md) writeOut(flow.write(md.flush()) + flow.end());
    md = null;
    flow = null;
    if (midLine) writeOut('\n');
  };

  let group = null; // open run of condensed calls: { items: [{ use, tool, outcome }] }
  let lastGroup = null; // the run last summarized, for Ctrl+O

  const summarizeGroup = (items) => {
    const counts = {};
    for (const { use } of items) counts[CONDENSED[use.name]] = (counts[CONDENSED[use.name]] ?? 0) + 1;
    const text = Object.entries(counts).map(([k, n]) => PHRASE[k](n)).join(', ');
    return text[0].toUpperCase() + text.slice(1);
  };

  // Writes the open run as one line. Called before any other output.
  const flushGroup = () => {
    if (!group) return;
    const g = group;
    group = null;
    lastGroup = g;
    startBlock('tool', err);
    err.write(`${accentText('●')} ${summarizeGroup(g.items)} ${paint('dim', '(ctrl+o to expand)')}\n`);
  };

  const startBlock = (kind, stream) => {
    flushGroup();
    finishText();
    if (last !== null && last !== kind) stream.write('\n');
    if (last !== kind) held = '';
    last = kind;
  };

  // Assistant text ('text') or reasoning ('thinking', dim, no Markdown). Trailing newlines are held
  // back so a block never ends with a blank line.
  const writeText = (chunk, kind = 'text') => {
    const trailing = /\n*$/.exec(chunk)[0];
    let core = chunk.slice(0, chunk.length - trailing.length);
    const thinking = kind === 'thinking';
    const style = (s) => (thinking ? paint('dim', s) : s);
    const renderer = () => {
      md = createMarkdownStream(thinking ? {} : mdStyles);
      flow = createFlow({ width: cols, indent: '  ' });
    };
    if (core) {
      if (last !== kind) {
        core = core.replace(/^\n+/, '');
        startBlock(kind, out);
        writeOut(thinking ? paint('dim', '∴ ') : '● ');
        renderer();
        flow.start(2);
      } else if (!md) {
        renderer();
      }
      const s = flow.write(md.push(held + core));
      if (s) writeOut(style(s));
      held = trailing;
    } else if (last === kind) {
      held += trailing;
    }
  };

  const summarize = (tool, input) => {
    const room = Math.max(40, width() - 20);
    if (tool?.describeCall) return getFirstLine(tool.describeCall(input), room);
    return getFirstLine(JSON.stringify(input ?? {}), room);
  };
  const callLine = (use, tool) => `${accentText('●')} ${paint('bold', TOOL_LABELS[use.name] ?? use.name)}(${summarize(tool, use.input)})`;

  // A full-width row on a background color.
  const band = (bg, text) => {
    if (!bg) return text;
    const pad = Math.max(0, width() - stripAnsi(text).length);
    return `${bg}${text}${' '.repeat(pad)}${RESET}`;
  };

  // edit_file / write_file results: a header and the changed lines with line numbers.
  const renderDisplay = (d) => {
    const rows = [];
    if (d.type === 'diff') {
      const reps = d.replacements > 1 ? `, ${d.replacements} replacements` : '';
      rows.push(`  ⎿  Updated ${paint('bold', d.path)} ${paint('dim', `(+${d.newLines.length} -${d.oldLines.length}${reps})`)}`);
      const numW = String(d.line + Math.max(d.oldLines.length, d.newLines.length)).length;
      const side = (lines, sign, bg) => {
        lines.slice(0, DIFF_LINES).forEach((l, i) => {
          const text = `      ${String(d.line + i).padStart(numW)} ${sign}${l.replace(/\t/g, '  ')}`;
          rows.push(on ? band(bg, text.slice(0, width())) : text);
        });
        if (lines.length > DIFF_LINES) rows.push(paint('dim', `      … ${lines.length - DIFF_LINES} more lines`));
      };
      side(d.oldLines, '-', tones.removed);
      side(d.newLines, '+', tones.added);
    } else if (d.type === 'write') {
      rows.push(`  ⎿  Wrote ${d.lineCount} line${d.lineCount === 1 ? '' : 's'} to ${paint('bold', d.path)}`);
      const numW = String(Math.min(d.preview.length, d.lineCount)).length;
      d.preview.forEach((l, i) => rows.push(paint('dim', `      ${String(i + 1).padStart(numW)} ${l.replace(/\t/g, '  ')}`.slice(0, width()))));
      if (d.lineCount > d.preview.length) rows.push(paint('dim', `      … ${d.lineCount - d.preview.length} more lines`));
    }
    return rows;
  };

  return {
    streamText(delta) {
      writeText(delta);
    },
    // Reasoning text from the model, shown dim above its answer.
    streamThinking(delta) {
      writeText(delta, 'thinking');
    },
    endStream() {
      finishText();
      held = '';
    },
    assistant(text) {
      writeText(text.trim());
      finishText();
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
      const ghostW = GHOST[0].length;
      const infoText = (item, room) => {
        const text = item.text.length > room ? `${item.text.slice(0, room - 1)}…` : item.text;
        return item.style === 'title' ? accentText(text) : item.style === 'dim' ? paint('dim', text) : text;
      };
      // The ghost sits beside the four info lines, between the logo and the text.
      const ghostRow = (i) => (GHOST[i] ? `${paintWith(accent, GHOST[i])}  ` : ' '.repeat(ghostW + 2));
      const logoCols = width() >= 90 ? 52 : 34;
      const logo = logoLines(logoCols);
      if (!logo) {
        info.forEach((item, i) => err.write(`${ghostRow(i)}${infoText(item, width() - ghostW - 2)}\n`));
        return;
      }
      const top = Math.max(0, Math.floor((logo.length - info.length) / 2));
      const room = width() - logoCols - 3 - ghostW - 2;
      for (let r = 0; r < logo.length; r++) {
        const i = r - top;
        const item = info[i];
        const right = item ? `${ghostRow(i)}${infoText(item, room)}` : '';
        err.write(`${paintWith(accent, logo[r].padEnd(logoCols))}   ${right}`.trimEnd() + '\n');
      }
    },

    // Dim rule above the prompt. Starts a new block, so the next block follows it without a gap.
    rule() {
      finishText();
      last = null;
      held = '';
      err.write(`${paint('dim', '─'.repeat(width()))}\n`);
    },

    // Prompt box label. '!' (shell) and '#' (note) get their own colors.
    prompt(mode = null) {
      if (mode === '!') return `${paintWith('\x1b[33m', '!')} `;
      if (mode === '#') return `${paintWith(CODES.cyan, '#')} `;
      return `${paintWith(accent, '❯')} `;
    },

    // Ctrl+O: print what each call in the last condensed run did.
    expandLast() {
      flushGroup();
      if (!lastGroup) {
        err.write(`${paint('dim', 'nothing to expand')}\n`);
        return;
      }
      for (const { use, tool, outcome } of lastGroup.items) {
        err.write(`${callLine(use, tool)}\n`);
        const text = String(outcome?.content ?? '').trim().split('\n');
        const shown = text.slice(0, 6).map((l) => `      ${l.slice(0, Math.max(40, width() - 8))}`);
        if (text.length > 6) shown.push(`      … +${text.length - 6} lines`);
        err.write(`${paint(outcome?.isError ? 'red' : 'dim', shown.join('\n') || '      (no output)')}\n`);
      }
    },

    // A submitted prompt, echoed into the feed on a shaded band. Follow-ups are echoed when they reach the model.
    userMessage(text) {
      startBlock('user', err);
      const [first, ...rest] = text.split('\n');
      const lines = [`${paintWith(accent, '❯')} ${first}`, ...rest.map((l) => `  ${l}`)];
      err.write(`${lines.map((l) => band(tones.userBg, l)).join('\n')}\n`);
    },

    // A follow-up waiting for the next tool call.
    queued(text) {
      startBlock('meta', err);
      err.write(`${paint('dim', `  queued: ${getFirstLine(text, Math.max(30, width() - 60))} · Enter on an empty box or /now sends it now`)}\n`);
    },

    // One line under the answer, e.g. ✻ Nms'd for 12s · done 6:23 PM · model · tokens.
    status(text) {
      startBlock('meta', err);
      err.write(`${paint('dim', text)}\n`);
    },

    toolCall(use, tool) {
      if (CONDENSED[use.name]) {
        group ??= { items: [] };
        group.items.push({ use, tool, outcome: null });
        return;
      }
      const again = last === 'tool';
      startBlock('tool', err);
      err.write(`${again ? '\n' : ''}${callLine(use, tool)}\n`);
    },
    toolResult(use, outcome) {
      if (CONDENSED[use.name] && group) {
        const item = group.items.find((i) => i.use === use && !i.outcome);
        if (item) item.outcome = outcome;
        return;
      }
      startBlock('tool', err);
      if (!outcome.isError && outcome.display) {
        const rows = renderDisplay(outcome.display);
        if (rows.length) {
          err.write(`${rows.join('\n')}\n`);
          return;
        }
      }
      const text = String(outcome.content ?? '').trim();
      const more = text.split('\n').length - 1;
      const preview = getFirstLine(text, Math.max(40, width() - 20));
      const tail = more > 0 ? ` … +${more} lines` : '';
      err.write(paint(outcome.isError ? 'red' : 'dim', `  ⎿  ${preview}${tail}`) + '\n');
    },
    info(text) {
      startBlock('meta', err);
      err.write(`${text}\n`);
    },
    warn(text) {
      startBlock('meta', err);
      err.write(paint('yellow', `warning: ${text}`) + '\n');
    },
    error(text) {
      startBlock('meta', err);
      err.write(paint('red', `error: ${text}`) + '\n');
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
    yellow(text) {
      return paint('yellow', text);
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
          err.write(`${tag} ${callLine(use, tool)}\n`);
        },
        toolResult(use, outcome) {
          if (outcome.isError) {
            startBlock('tool', err);
            err.write(`${tag}   ${paint('red', `⎿  ${getFirstLine(outcome.content, Math.max(40, width() - 20))}`)}\n`);
          }
        },
        warn: (t) => err.write(`${tag} ${paint('yellow', `warning: ${t}`)}\n`),
        error: (t) => err.write(`${tag} ${paint('red', `error: ${t}`)}\n`),
      };
    },
  };
}

export { stripAnsi };
