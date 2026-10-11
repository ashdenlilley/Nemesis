// Multi-line prompt editor for the REPL and setup questions. Enter submits. Ctrl+J, Alt+Enter, and
// Shift+Enter (where the terminal sends it) insert a newline. Pasted text goes in as one block.
// The box grows with its content up to MAX_INPUT_ROWS, then scrolls with the cursor.

export const MAX_INPUT_ROWS = 8;
export const MAX_SUGGESTIONS = 6;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
// One escape sequence at the start of a string: CSI, SS3, or ESC followed by one character.
const ESCAPE_SEQ = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O[A-Za-z]|[\s\S])?/;
const ANSI = /\x1b\[[0-9;]*m/g;
const CONTROL_SEQ = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[78])/g;

const normalize = (s) => s.replace(/\r\n?/g, '\n');
const lineStart = (text, i) => (i <= 0 ? 0 : text.lastIndexOf('\n', i - 1) + 1);
const lineEnd = (text, i) => {
  const j = text.indexOf('\n', i);
  return j === -1 ? text.length : j;
};

// Text -> terminal rows of `width` characters. The cursor maps to a (row, col) inside them.
export function layout(text, cur, width) {
  const rows = [];
  let cursorRow = 0;
  let cursorCol = 0;
  let found = false;
  let offset = 0;
  for (const line of text.split('\n')) {
    const first = rows.length;
    const count = Math.floor(line.length / width) + 1; // a trailing empty row when the line fills exactly
    for (let k = 0; k < count; k++) rows.push(line.slice(k * width, (k + 1) * width));
    if (!found && cur >= offset && cur <= offset + line.length) {
      found = true;
      const col = cur - offset;
      cursorRow = first + Math.floor(col / width);
      cursorCol = col % width;
    }
    offset += line.length + 1;
  }
  return { rows, cursorRow, cursorCol };
}

// Which rows stay on screen. `top` is the scroll position from the last draw; the cursor row is always kept.
export function viewport(total, cursorRow, top = 0, max = MAX_INPUT_ROWS) {
  let start = Math.max(0, Math.min(top, total - max));
  if (cursorRow < start) start = cursorRow;
  if (cursorRow >= start + max) start = cursorRow - max + 1;
  return { start, end: Math.min(total, start + max) };
}

function insert(st, s) {
  st.text = st.text.slice(0, st.cur) + s + st.text.slice(st.cur);
  st.cur += s.length;
}

function remove(st, from, to) {
  st.text = st.text.slice(0, from) + st.text.slice(to);
  st.cur = from;
}

function moveVertical(text, cur, dir) {
  const start = lineStart(text, cur);
  const col = cur - start;
  if (dir < 0) {
    if (start === 0) return 0;
    const prev = lineStart(text, start - 1);
    return prev + Math.min(col, start - 1 - prev);
  }
  const end = lineEnd(text, cur);
  if (end === text.length) return text.length;
  const next = end + 1;
  return next + Math.min(col, lineEnd(text, next) - next);
}

// Single key or escape sequence. Returns 'submit' | 'interrupt' | 'eof' | null.
function applyKey(st, k) {
  switch (k) {
    case '\r':
      return 'submit';
    // Newline keys: Ctrl+J, Alt+Enter, and Shift/Ctrl+Enter in the encodings terminals send.
    case '\n': case '\x1b\r': case '\x1b[13;2u': case '\x1b[13;5u': case '\x1b[27;2;13~': case '\x1b[27;5;13~':
      insert(st, '\n');
      return null;
    case '\x7f': case '\b':
      if (st.cur > 0) remove(st, st.cur - 1, st.cur);
      return null;
    case '\x1b[3~': case '\x04':
      if (k === '\x04' && !st.text) return 'eof';
      if (st.cur < st.text.length) remove(st, st.cur, st.cur + 1);
      return null;
    case '\x1b[D': case '\x1bOD':
      st.cur = Math.max(0, st.cur - 1);
      return null;
    case '\x1b[C': case '\x1bOC':
      st.cur = Math.min(st.text.length, st.cur + 1);
      return null;
    case '\x1b[A': case '\x1bOA':
      st.cur = moveVertical(st.text, st.cur, -1);
      return null;
    case '\x1b[B': case '\x1bOB':
      st.cur = moveVertical(st.text, st.cur, 1);
      return null;
    case '\x1b[H': case '\x1bOH': case '\x1b[1~': case '\x01':
      st.cur = lineStart(st.text, st.cur);
      return null;
    case '\x1b[F': case '\x1bOF': case '\x1b[4~': case '\x05':
      st.cur = lineEnd(st.text, st.cur);
      return null;
    case '\x15': // Ctrl+U: delete to start of line
      remove(st, lineStart(st.text, st.cur), st.cur);
      return null;
    case '\x17': { // Ctrl+W: delete the word before the cursor
      let i = st.cur;
      while (i > 0 && st.text[i - 1] === ' ') i--;
      while (i > 0 && st.text[i - 1] !== ' ' && st.text[i - 1] !== '\n') i--;
      remove(st, i, st.cur);
      return null;
    }
    case '\x03': // Ctrl+C clears a non-empty prompt, otherwise leaves it
      if (st.text) {
        st.text = '';
        st.cur = 0;
        return null;
      }
      return 'interrupt';
    default:
      if (k >= ' ' && k !== '\x7f') insert(st, k);
      return null;
  }
}

// Feed raw terminal input into the editor state `st` (mutated). Returns an action or null.
export function applyInput(st, chunk) {
  let rest = chunk;
  while (rest.length) {
    if (st.pasting) {
      const end = rest.indexOf(PASTE_END);
      insert(st, normalize(end === -1 ? rest : rest.slice(0, end)));
      if (end === -1) return null;
      st.pasting = false;
      rest = rest.slice(end + PASTE_END.length);
      continue;
    }
    if (rest.startsWith(PASTE_START)) {
      st.pasting = true;
      rest = rest.slice(PASTE_START.length);
      continue;
    }
    if (rest[0] === '\x1b') {
      const seq = ESCAPE_SEQ.exec(rest)[0];
      const action = applyKey(st, seq);
      if (action) return action;
      rest = rest.slice(seq.length);
      continue;
    }
    // Plain run up to the next escape. One character is a key; several are a paste (newlines stay newlines).
    const run = rest.split('\x1b')[0];
    if (run.length === 1) {
      const action = applyKey(st, run);
      if (action) return action;
    } else {
      insert(st, normalize(run));
    }
    rest = rest.slice(run.length);
  }
  return null;
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const newEditor = () => ({ text: '', cur: 0, top: 0, pasting: false });

// Visible columns after writing `s` on a line that already had `start` columns. Tabs stop every 8.
function advance(start, s) {
  let col = start;
  for (const ch of s.replace(CONTROL_SEQ, '')) {
    if (ch === '\t') col += 8 - (col % 8);
    else if (ch >= ' ') col++;
  }
  return col;
}
const eofError = () => Object.assign(new Error('input closed'), { code: 'EOF' });
// A question cancelled by a key: code 'INTERRUPT' for Ctrl+C, 'CANCEL' for Esc.
const cancelError = (code) => Object.assign(new Error('cancelled'), { code });

// Suggestion rows under a prompt box. `items` are { name, description }; `index` is highlighted.
// Shows a window of MAX_SUGGESTIONS rows that keeps the highlighted one visible.
export function suggestionRows(items, index, width) {
  const start = Math.max(0, Math.min(index - MAX_SUGGESTIONS + 1, items.length - MAX_SUGGESTIONS));
  const shown = items.slice(Math.max(0, start), Math.max(0, start) + MAX_SUGGESTIONS);
  const nameW = Math.min(24, Math.max(...shown.map((it) => it.name.length)) + 2);
  return shown.map((it, k) => {
    const i = Math.max(0, start) + k;
    const text = `${i === index ? '❯' : ' '} ${it.name.padEnd(nameW)}${it.description ?? ''}`.slice(0, Math.max(10, width - 1));
    return i === index ? `\x1b[1m${text}\x1b[0m` : dim(text);
  });
}

// Terminal input and the live area at the bottom of the screen. The live area is one of:
//   menu:   choose() options, arrow keys + Enter, or a number key. Esc or Ctrl+C cancels (-1).
//   line:   question(), a prompt box that resolves with the entered text.
//   watch:  watch(), a prompt box that stays up during a turn. Each Enter goes to onSubmit.
// A status line (setStatus) sits above whichever is up. A box given complete(text) lists matches
// under it: Up/Down pick, Tab fills in, Enter runs the highlighted one, Esc hides the list.
// Output goes through wrap(): it clears the live area, writes the text, then redraws the area below it.
// Raw mode stays on from the first prompt until close(). Turning it off on Windows starts a line-mode
// console read that swallows keys until Enter, so typing between prompts would need an extra Enter.
// Keys pressed while no box is up are kept and replayed into the next one.
export function createLineReader({ input = process.stdin, output = process.stdout } = {}) {
  let line = null; // { label, secret, leave, st, resolve, reject }
  let watching = null; // { label, st, onSubmit, onInterrupt }
  let menu = null; // { title, options, index, resolve }
  let shown = null; // { row, partial }: live area on screen; row is the cursor's row inside it
  let atLineStart = true; // the last text written ended with a newline
  let tailCols = 0; // columns of text after the last newline written
  let attached = false; // raw input listener installed
  let closed = false;
  let pending = ''; // keys pressed while no box was up
  let draft = null; // editor state of a watch box that closed with unsent text
  let status = null; // line drawn above the live area while a turn runs
  let footer = null; // text drawn below the live area (a status line)
  let header = null; // text drawn above the prompt box (the top rule of the bar)
  const menuQueue = []; // choose() requests waiting for the open menu to close
  let history = []; // submitted prompts, oldest first
  const keyHandlers = new Map(); // key sequence -> fn, active while a box is up
  const sigint = [];
  const cols = () => output.columns || 80;

  const surface = () => menu ?? line ?? watching;

  // Matches for the box's current text, or [] when it has no completer or the list was dismissed.
  function suggestions(s) {
    if (!s?.complete || s.secret || s.st.dismissed === s.st.text) return [];
    const items = s.complete(s.st.text) ?? [];
    if (s.st.suggestFor !== s.st.text) {
      s.st.suggestFor = s.st.text;
      s.st.suggestIndex = 0;
    }
    if (s.st.suggestIndex >= items.length) s.st.suggestIndex = 0;
    return items;
  }

  // Keys that act on an open suggestion list. Returns true when the key was used.
  function suggestionKey(s, chunk) {
    const items = suggestions(s);
    if (!items.length) return false;
    const st = s.st;
    const n = items.length;
    if (chunk === '\x1b[A' || chunk === '\x1bOA') st.suggestIndex = (st.suggestIndex + n - 1) % n;
    else if (chunk === '\x1b[B' || chunk === '\x1bOB') st.suggestIndex = (st.suggestIndex + 1) % n;
    else if (chunk === '\t' || chunk === '\r') {
      // An item with apply(text) edits part of the text (a file path) and keeps typing; a plain item
      // (a slash command) fills in on Tab and runs on Enter.
      const it = items[st.suggestIndex];
      if (it.apply) {
        st.text = it.apply(st.text);
        st.cur = st.text.length;
        st.suggestFor = null;
        paint();
        return true;
      }
      st.text = chunk === '\t' ? `${it.name} ` : it.name;
      st.cur = st.text.length;
      if (chunk === '\r') return false; // falls through to a normal submit
    } else if (chunk === '\x1b') st.dismissed = st.text;
    else return false;
    paint();
    return true;
  }

  // Rows for a surface, the cursor's row and column inside them, and rows below the cursor.
  function render(s) {
    if (s.options) {
      const lines = [s.title, ...s.options.map((opt, i) => (i === s.index ? `\x1b[1m❯ ${i + 1}. ${opt}\x1b[0m` : `  ${i + 1}. ${opt}`))];
      return { lines, row: 0, col: 0, below: lines.length - 1 };
    }
    const { secret, st } = s;
    // Reverse search shows the matching history entry under its own label. labelFor(text) can change the
    // label as the text changes (a "!" or "#" prefix).
    const label = st.search
      ? dim(`(reverse-search)\`${st.search.query}': `)
      : (s.labelFor?.(st.text) ?? s.label);
    const prefixW = label.replace(ANSI, '').length;
    const width = Math.max(10, cols() - prefixW);
    const shown = st.search ? (history[st.search.at] ?? '') : st.text;
    // Secret text shows as dots so a paste is visibly received.
    const shownText = secret ? '•'.repeat(shown.length) : shown;
    const { rows, cursorRow, cursorCol } = layout(shownText, st.search ? shownText.length : st.cur, width);
    const { start, end } = viewport(rows.length, cursorRow, st.top);
    st.top = start;

    const indent = ' '.repeat(prefixW);
    const lines = [];
    if (start > 0) lines.push(dim(`… ${start} more above`));
    for (let i = start; i < end; i++) lines.push((i === 0 ? label : indent) + rows[i]);
    if (end < rows.length) lines.push(dim(`… ${rows.length - end} more below`));

    const row = (start > 0 ? 1 : 0) + cursorRow - start;
    const items = suggestions(s);
    if (items.length) lines.push(...suggestionRows(items, st.suggestIndex, cols()));
    return { lines, row, col: prefixW + cursorCol, below: lines.length - 1 - row };
  }

  // The surface's rows with the status line above them.
  function area() {
    const s = surface();
    // Footer lines are styled by the caller (the prompt bar's bottom rule and status row).
    const foot = footer ? footer.split('\n') : [];
    const head = [...(status ? [status] : []), ...(header ? header.split('\n') : [])];
    // Without a box the cursor rests on the last header line (or the first footer line when there is no header).
    if (!s) return head.length || foot.length ? { lines: [...head, ...foot], row: Math.max(0, head.length - 1), col: 0, below: foot.length } : null;
    const v = render(s);
    return { ...v, lines: [...head, ...v.lines, ...foot], row: v.row + head.length, below: v.below + foot.length };
  }

  // Clear the live area, write `text` in its place, then draw the current surface below it.
  function paint(text = '') {
    let buf = '';
    if (shown) {
      buf += `\r${shown.row ? `\x1b[${shown.row}A` : ''}\x1b[J`;
      // Back to the end of a partial line. Moving by rows stays right when drawing the area scrolled
      // the screen, which a saved cursor position does not. A line that exactly filled its last row
      // continues at the start of the area's row, where the terminal would wrap it anyway.
      if (shown.partial) {
        const col = tailCols % cols();
        if (col) buf += `\x1b[A\x1b[${col}C`;
      }
      shown = null;
    }
    buf += text;
    if (text) {
      atLineStart = text.endsWith('\n');
      const brk = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
      tailCols = brk === -1 ? advance(tailCols, text) : advance(0, text.slice(brk + 1));
    }

    const v = area();
    if (v) {
      // Mid-line text: step to a fresh line for the area.
      const partial = !atLineStart;
      if (partial) buf += '\r\n';
      buf += v.lines.join('\r\n');
      if (v.below) buf += `\x1b[${v.below}A`;
      buf += `\r${v.col ? `\x1b[${v.col}C` : ''}`;
      shown = { row: v.row, partial };
    }
    output.write(buf);
  }

  // Raw input turns on with the first prompt and stays on until close().
  function updateMode() {
    const want = !closed && Boolean(line || watching || menu);
    if (want && !attached) {
      input.setEncoding('utf8');
      input.setRawMode(true);
      input.resume();
      // Kitty keyboard protocol, disambiguate only: Ctrl+Enter and Shift+Enter send distinct codes.
      // Ctrl+letter keys keep their legacy bytes. Terminals without support ignore it.
      output.write('\x1b[?2004h\x1b[>1u');
      input.on('data', onData);
      attached = true;
    } else if (closed && attached) {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\x1b[?2004l\x1b[<u');
      attached = false;
    }
  }

  // Editor state for a new text box: the unsent watch draft (never for secrets), else a blank one.
  function openEditor(secret) {
    if (secret || !draft) return newEditor();
    const st = draft;
    draft = null;
    return st;
  }

  // Keys pressed while no box was up go into the box that just opened.
  function replayPending() {
    if (!pending || menu || !(line || watching)) return;
    const keys = pending;
    pending = '';
    onData(keys);
  }

  function finishLine(text, error) {
    const l = line;
    line = null;
    l.complete = null;
    // Keep the box on screen after a submit only when asked (setup questions do this).
    const final = l.leave && !error ? `${render(l).lines.join('\r\n')}\r\n` : '';
    paint(final);
    updateMode();
    if (error) l.reject(error);
    else l.resolve(text);
  }

  // Menus run one at a time. A request that comes while one is open waits its turn.
  function openMenu(req) {
    menu = { title: req.title, options: req.options, index: 0, resolve: req.resolve };
    paint();
    updateMode();
  }

  function settleMenu(index) {
    const m = menu;
    menu = null;
    m.resolve(index);
    const next = menuQueue.shift();
    if (next) openMenu(next);
    else {
      paint();
      updateMode();
      replayPending();
    }
  }

  function menuKey(chunk) {
    const m = menu;
    const n = m.options.length;
    if (chunk === '\x1b[A' || chunk === '\x1bOA') m.index = (m.index + n - 1) % n;
    else if (chunk === '\x1b[B' || chunk === '\x1bOB') m.index = (m.index + 1) % n;
    else if (chunk === '\r' || chunk === '\n') return settleMenu(m.index);
    else if (/^[1-9]$/.test(chunk) && Number(chunk) <= n) return settleMenu(Number(chunk) - 1);
    else if (chunk === '\x1b' || chunk === '\x03') return settleMenu(-1);
    else return;
    paint();
  }

  // Up/Down recall submitted prompts when the cursor is on the first/last line of the box.
  function historyKey(s, chunk) {
    const h = s.hist;
    if (!h || !history.length) return false;
    const st = s.st;
    const setText = (text) => Object.assign(st, { text, cur: text.length, top: 0 });
    if (chunk === '\x1b[A' || chunk === '\x1bOA') {
      if (st.text.slice(0, st.cur).includes('\n')) return false;
      if (h.index === history.length) h.draft = st.text;
      if (h.index > 0) {
        h.index--;
        setText(history[h.index]);
      }
      paint();
      return true;
    }
    if (chunk === '\x1b[B' || chunk === '\x1bOB') {
      if (st.text.slice(st.cur).includes('\n') || h.index >= history.length) return false;
      h.index++;
      setText(h.index === history.length ? h.draft : history[h.index]);
      paint();
      return true;
    }
    return false;
  }

  // Ctrl+R: type to filter history, Ctrl+R again for an older match, Enter takes it, Esc keeps the draft.
  const findMatch = (query, from) => {
    for (let i = from; i >= 0; i--) if (history[i].includes(query)) return i;
    return -1;
  };
  function searchKey(s, chunk) {
    const st = s.st;
    const search = st.search;
    if (chunk === '\x12') {
      const next = search.at > 0 ? findMatch(search.query, search.at - 1) : -1;
      if (next !== -1) search.at = next;
    } else if (chunk === '\r') {
      if (search.at >= 0) st.text = history[search.at];
      st.cur = st.text.length;
      st.search = null;
    } else if (chunk === '\x1b' || chunk === '\x03') {
      st.search = null;
    } else if (chunk === '\x7f') {
      search.query = search.query.slice(0, -1);
      search.at = findMatch(search.query, history.length - 1);
    } else if (!/[\x00-\x1f\x7f]/.test(chunk)) {
      // Printable text, one key or a fast burst of keys.
      search.query += chunk;
      search.at = findMatch(search.query, history.length - 1);
    } else {
      return false;
    }
    paint();
    return true;
  }

  function onData(chunk) {
    if (menu) return menuKey(chunk);
    if ((line || watching) && keyHandlers.has(chunk)) return keyHandlers.get(chunk)();
    if ((line || watching) && chunk === '\x12' && !(line ?? watching).st.search) {
      const s = line ?? watching;
      s.st.search = { query: '', at: history.length - 1 };
      s.st.search.at = findMatch('', history.length - 1);
      return paint();
    }
    if (line?.st.search) return searchKey(line, chunk) || paint();
    if (watching?.st.search) return searchKey(watching, chunk) || paint();
    if (!line && !watching) {
      // No box up: Ctrl+C acts as SIGINT (raw mode stops the terminal sending it); other keys wait.
      if (chunk === '\x03' && !pending) {
        if (sigint.length) return sigint.forEach((fn) => fn());
        closed = true;
        updateMode();
        return process.kill(process.pid, 'SIGINT');
      }
      pending += chunk;
      return;
    }
    if (suggestionKey(line ?? watching, chunk)) return;
    if (historyKey(line ?? watching, chunk)) return;
    if (line) {
      // Esc clears typed text; on an empty box it cancels the question.
      if (chunk === '\x1b') {
        if (!line.st.text) return finishLine(null, cancelError('CANCEL'));
        Object.assign(line.st, { text: '', cur: 0, top: 0 });
        return paint();
      }
      const action = applyInput(line.st, chunk);
      if (action === 'submit') return finishLine(line.st.text);
      if (action === 'interrupt') return finishLine(null, cancelError('INTERRUPT'));
      if (action === 'eof') return finishLine(null, eofError());
      return paint();
    }
    const w = watching;
    // Esc interrupts the turn, like Ctrl+C on an empty box.
    if (chunk === '\x1b') return w.onInterrupt();
    const action = applyInput(w.st, chunk);
    if (action === 'submit') {
      const text = w.st.text;
      Object.assign(w.st, { text: '', cur: 0, top: 0 });
      paint();
      return w.onSubmit(text);
    }
    if (action === 'interrupt') return w.onInterrupt();
    paint();
  }

  // Writable stream stand-in for the UI: keeps the live area below everything written.
  const wrap = (stream) => ({
    write(text) {
      paint(text);
      return true;
    },
    get columns() {
      return stream.columns;
    },
    get isTTY() {
      return stream.isTTY;
    },
  });

  return {
    output,
    wrap,

    // Resolves with the entered text. secret: characters show as dots. leave: keep the box on screen.
    // complete(text) -> [{ name, description }] lists matches under the box.
    // Rejects with code 'INTERRUPT' (Ctrl+C on an empty box), 'CANCEL' (Esc on an empty box), or 'EOF' (Ctrl+D).
    question(label, { secret = false, leave = true, complete = null, labelFor = null } = {}) {
      if (!input.isTTY) return Promise.reject(new Error('line input needs a terminal'));
      if (closed) return Promise.reject(eofError());
      if (line || menu) return Promise.reject(new Error('input is already waiting for a line'));
      return new Promise((resolve, reject) => {
        line = { label, secret, leave, complete, labelFor, resolve, reject, st: openEditor(secret), hist: { index: history.length, draft: '' } };
        paint();
        updateMode();
        replayPending();
      });
    },

    // Shows numbered options. Resolves with the chosen index, or -1 when cancelled.
    choose({ title, options }) {
      if (!input.isTTY) return Promise.reject(new Error('choices need a terminal'));
      if (closed) return Promise.reject(eofError());
      return new Promise((resolve) => {
        const req = { title, options, resolve };
        if (menu) menuQueue.push(req);
        else openMenu(req);
      });
    },

    // The rule drawn above the prompt box, and the line under the status row. null removes it.
    setHeader(text) {
      header = text || null;
      if (input.isTTY && !closed) paint();
    },

    // Keeps a prompt box up while a turn runs. Enter calls onSubmit(text); Ctrl+C on an empty box calls onInterrupt().
    watch({ label, onSubmit, onInterrupt, complete = null, labelFor = null }) {
      if (!input.isTTY) return;
      watching = { label, st: openEditor(false), onSubmit, onInterrupt, complete, labelFor, hist: { index: history.length, draft: '' } };
      paint();
      updateMode();
      replayPending();
    },

    // Prompts for Up/Down and Ctrl+R. addHistory skips empty entries and an immediate repeat.
    setHistory(list) {
      history = [...list];
    },
    addHistory(text) {
      if (text && text !== history.at(-1)) history.push(text);
    },

    // A key (escape sequence or control character) that runs fn while a box is up, e.g. Ctrl+O.
    onKey(key, fn) {
      keyHandlers.set(key, fn);
    },

    // The text the next prompt box opens with (used by /rewind to put a prompt back for editing).
    setDraft(text) {
      draft = { text, cur: text.length, top: 0, pasting: false };
    },

    // Puts text into the box that is up, at the cursor (clipboard images, pasted paths).
    insert(text) {
      const s = line ?? watching;
      if (!s) return false;
      const { st } = s;
      st.text = st.text.slice(0, st.cur) + text + st.text.slice(st.cur);
      st.cur += text.length;
      paint();
      return true;
    },

    // Text under the live area, e.g. a status line. null removes it.
    setFooter(text) {
      footer = text || null;
      if (input.isTTY && !closed) paint();
    },

    // Line above the live area (a spinner, say). null removes it.
    setStatus(text) {
      if (text === status) return;
      status = text;
      if (input.isTTY && !closed) paint();
    },

    // Text typed but not sent stays as a draft for the next prompt box.
    unwatch() {
      if (!watching) return;
      if (watching.st.text) draft = Object.assign(watching.st, { top: 0, pasting: false });
      watching = null;
      paint();
    },

    // SIGINT before raw mode is on reaches the process. After that, Ctrl+C with no box up calls fn.
    on(event, fn) {
      if (event === 'SIGINT') {
        process.on('SIGINT', fn);
        sigint.push(fn);
      }
      return this;
    },

    close() {
      closed = true;
      watching = null;
      if (line) finishLine(null, eofError());
      else {
        paint();
        updateMode();
      }
    },
  };
}
