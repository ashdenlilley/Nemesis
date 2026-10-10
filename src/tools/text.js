// Shorten text for one-line display. Tool results and tool-call summaries share this.
export function getFirstLine(text, max = 120) {
  const line = String(text ?? '').split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function truncateMiddle(text, max) {
  if (text.length <= max) return text;
  const keep = Math.floor(max / 2);
  const dropped = text.length - keep * 2;
  return `${text.slice(0, keep)}\n... [${dropped} chars truncated] ...\n${text.slice(-keep)}`;
}
