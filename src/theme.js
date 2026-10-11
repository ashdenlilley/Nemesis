// Nemesis brand color. Rendered as truecolor when the terminal supports it,
// otherwise down-sampled to the xterm-256 palette, otherwise plain magenta.
export const ACCENT_HEX = '#7F00FF';

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`bad hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// 'truecolor' | '256' | 'basic' | 'none'
export function colorDepth(env = process.env, isTTY = false) {
  if (!isTTY || env.NO_COLOR !== undefined) return 'none';
  if (/truecolor|24bit/i.test(env.COLORTERM ?? '') || env.WT_SESSION) return 'truecolor';
  if (/256/.test(env.TERM ?? '')) return '256';
  return 'basic';
}

// Nearest xterm-256 cube index for an RGB triple (levels 0, 95, 135, 175, 215, 255).
export function rgbTo256(rgb) {
  const levels = [0, 95, 135, 175, 215, 255];
  const nearest = (v) => levels.reduce((best, lvl, i) => (Math.abs(lvl - v) < Math.abs(levels[best] - v) ? i : best), 0);
  const [r, g, b] = rgb.map(nearest);
  return 16 + 36 * r + 6 * g + b;
}

export function accentOpen(depth = 'truecolor', hex = ACCENT_HEX) {
  if (depth === 'none') return '';
  if (depth === 'basic') return '\x1b[35m';
  const rgb = hexToRgb(hex);
  if (depth === '256') return `\x1b[38;5;${rgbTo256(rgb)}m`;
  return `\x1b[38;2;${rgb.join(';')}m`;
}

export const RESET = '\x1b[0m';

// Background color. `basic` is the fallback escape for 16-color terminals ('' for none).
export function bgOpen(depth, hex, basic = '') {
  if (depth === 'none') return '';
  if (depth === 'basic') return basic;
  const rgb = hexToRgb(hex);
  if (depth === '256') return `\x1b[48;5;${rgbTo256(rgb)}m`;
  return `\x1b[48;2;${rgb.join(';')}m`;
}
