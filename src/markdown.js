// Streaming Markdown for the terminal. Text arrives in chunks. A style that depends on characters
// not yet seen (a line's opening characters, a lone `*`) waits for the next chunk before it is written.
//   styles: { code, bold, heading, reset } escape strings, all '' when color is off.
// Handled: `inline code`, **bold**, # headings, - / * / + bullets, and ``` fenced blocks (fence lines hidden).

const ESC_TOKEN = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;

export function createMarkdownStream(styles) {
  const { code: codeOpen = '', bold: boldOpen = '', heading: headOpen = '', reset = '' } = styles;
  let lineStart = true;
  let held = ''; // opening characters of a line, until its kind is known
  let fence = null; // a ``` line being read; it is dropped from the output
  let inFence = false;
  let codeLine = false; // inside a fenced block, mid-line
  let code = false;
  let bold = false;
  let head = false;
  let star = false; // one `*` seen, waiting to know whether a second follows

  const any = () => code || bold || head;
  const sgr = () => (reset ? reset + (head ? headOpen : '') + (bold ? boldOpen : '') + (code ? codeOpen : '') : '');

  function inline(ch) {
    let out = '';
    if (star) {
      star = false;
      if (ch === '*') {
        bold = !bold;
        return sgr();
      }
      out += '*';
    }
    if (ch === '*' && !code) {
      star = true;
      return out;
    }
    if (ch === '`') {
      code = !code;
      return out + sgr();
    }
    if (ch === '\n') {
      const close = any() && reset ? reset : '';
      code = false;
      bold = false;
      head = false;
      lineStart = true;
      return `${out}${close}\n`;
    }
    return out + ch;
  }

  const inlineAll = (s) => [...s].map(inline).join('');

  // Decide what kind of line `held` opens. Returns output, or null to keep waiting.
  function decide(final) {
    const ended = final || held.endsWith('\n');
    const lead = /^[ \t]*/.exec(held)[0];
    const t = held.slice(lead.length);
    if (inFence) {
      if (t.startsWith('```')) return startFence();
      if (!ended && '```'.startsWith(t)) return null;
      lineStart = false;
      codeLine = true;
      return fenceBody(held);
    }
    if (t.startsWith('```')) return startFence();
    if (!ended) {
      if (t === '' || '```'.startsWith(t) || /^#{1,6}$/.test(t) || /^[-*+]$/.test(t)) return null;
    }
    lineStart = false;
    held = '';
    const heading = /^#{1,6} /.exec(t);
    if (heading) {
      head = true;
      return lead + sgr() + inlineAll(t.slice(heading[0].length));
    }
    const bullet = /^[-*+] /.exec(t);
    if (bullet) return `${lead}• ${inlineAll(t.slice(2))}`;
    return inlineAll(lead + t);
  }

  function startFence() {
    fence = held;
    held = '';
    lineStart = false;
    if (fence.endsWith('\n')) return endFence();
    return '';
  }

  function endFence() {
    inFence = !inFence;
    fence = null;
    lineStart = true;
    return '';
  }

  // Characters of a fenced code line, written in the code style.
  function fenceBody(s) {
    held = '';
    let out = '';
    for (const ch of s) {
      if (ch === '\n') {
        out += `${codeOpen ? reset : ''}\n`;
        codeLine = false;
        lineStart = true;
      } else {
        if (out === '' || out.endsWith('\n')) out += codeOpen;
        out += ch;
      }
    }
    return out;
  }

  function feed(ch) {
    if (fence !== null) {
      fence += ch;
      return ch === '\n' ? endFence() : '';
    }
    if (lineStart) {
      held += ch;
      return decide(false) ?? '';
    }
    if (codeLine) {
      if (ch !== '\n') return ch;
      codeLine = false;
      lineStart = true;
      return `${codeOpen ? reset : ''}\n`;
    }
    return inline(ch);
  }

  return {
    push(text) {
      let out = '';
      for (const ch of text) out += feed(ch);
      return out;
    },
    // End of the text: write whatever is still waiting and close open styles.
    flush() {
      let out = '';
      if (fence !== null) fence = null;
      else if (held) out += decide(true) ?? '';
      if (star) {
        star = false;
        out += '*';
      }
      if ((any() || codeLine) && reset) out += reset;
      code = bold = head = codeLine = false;
      lineStart = true;
      held = '';
      return out;
    },
  };
}

// Word wrap for streamed text with a hanging indent. Escape codes take no columns.
// A word is written once the space or newline after it arrives (or at end()).
export function createFlow({ width, indent = '' }) {
  let col = 0;
  let atStart = true; // nothing written on this line yet
  let word = '';
  let wordCols = 0;

  const max = () => Math.max(indent.length + 10, width() - 1);

  function placeWord() {
    if (!word) return '';
    let s = '';
    if (wordCols === 0) {
      s = word;
      word = '';
      return s;
    }
    if (atStart) {
      s += indent;
      col = indent.length;
      atStart = false;
    }
    if (col > indent.length && col + wordCols > max()) {
      s += `\n${indent}`;
      col = indent.length;
    }
    // Longer than a whole line: break it.
    let rest = word;
    while (rest) {
      const esc = ESC_TOKEN.exec(rest);
      if (esc) {
        s += esc[0];
        rest = rest.slice(esc[0].length);
        continue;
      }
      if (col >= max()) {
        s += `\n${indent}`;
        col = indent.length;
      }
      const ch = String.fromCodePoint(rest.codePointAt(0));
      s += ch;
      col++;
      rest = rest.slice(ch.length);
    }
    word = '';
    wordCols = 0;
    return s;
  }

  return {
    // The current line already holds `cols` columns (a bullet, say).
    start(cols) {
      col = cols;
      atStart = false;
    },
    write(text) {
      let out = '';
      let rest = text;
      while (rest) {
        const esc = ESC_TOKEN.exec(rest);
        if (esc) {
          word += esc[0];
          rest = rest.slice(esc[0].length);
          continue;
        }
        const ch = String.fromCodePoint(rest.codePointAt(0));
        rest = rest.slice(ch.length);
        if (ch === '\n') {
          out += `${placeWord()}\n`;
          col = 0;
          atStart = true;
        } else if (ch === ' ') {
          out += placeWord();
          if (atStart) {
            out += indent;
            col = indent.length;
            atStart = false;
          }
          if (col + 1 >= max()) {
            out += `\n${indent}`;
            col = indent.length;
          } else {
            out += ' ';
            col++;
          }
        } else {
          word += ch;
          wordCols++;
        }
      }
      return out;
    },
    end() {
      return placeWord();
    },
  };
}
