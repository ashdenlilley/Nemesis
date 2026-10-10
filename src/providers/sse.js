// Server-sent events reader for fetch Response bodies.
export async function* readSSE(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const event = parseEvent(buf.slice(0, sep));
      buf = buf.slice(sep + 2);
      if (event) yield event;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) {
    const event = parseEvent(buf);
    if (event) yield event;
  }
}

export function parseEvent(raw) {
  let event = 'message';
  const data = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}
