import { DEFAULT_IDLE_MS, networkError, ProviderError } from './http.js';

// Server-sent events reader for fetch Response bodies.
//   idleMs: give up when no bytes arrive for this long (the server or connection has stalled).
//   onActivity(): called whenever bytes arrive.
//   signal: the request's abort signal, so a user interrupt is not reported as a dropped connection.
export async function* readSSE(response, { idleMs = DEFAULT_IDLE_MS, onActivity, signal } = {}) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await readWithin(reader, idleMs, signal);
      if (done) {
        finished = true;
        break;
      }
      onActivity?.();
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const event = parseEvent(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
        if (event) yield event;
      }
    }
  } finally {
    // Stopped early (an error, or the caller broke out): close the body so the socket is freed.
    if (!finished) reader.cancel().catch(() => {});
  }
  buf += decoder.decode();
  if (buf.trim()) {
    const event = parseEvent(buf);
    if (event) yield event;
  }
}

async function readWithin(reader, idleMs, signal) {
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError(
      `model stream stalled: no data for ${Math.round(idleMs / 1000)}s`, undefined, { retryable: true },
    )), idleMs);
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } catch (err) {
    reader.cancel().catch(() => {});
    if (signal?.aborted || err.name === 'AbortError') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (err instanceof ProviderError) throw err;
    throw networkError(err, 'connection lost mid-response');
  } finally {
    clearTimeout(timer);
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
