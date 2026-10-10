const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
}

async function failureFrom(res) {
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON error body: fall through to raw text
  }
  const detail = data?.error?.message ?? data?.error ?? (text.slice(0, 500) || res.statusText);
  return new ProviderError(
    `HTTP ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
    res.status,
  );
}

// POST with retry on transient status codes. Resolves to the successful Response (body unread).
async function send(url, body, headers, { signal, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ProviderError(`network error: ${err.cause?.code ?? err.message}`);
    }
    if (res.ok) return res;
    if (RETRYABLE.has(res.status) && attempt < retries) {
      await res.body?.cancel();
      await sleep(500 * 2 ** attempt, signal);
      continue;
    }
    throw await failureFrom(res);
  }
}

export async function postJson(url, body, headers, opts = {}) {
  const res = await send(url, body, headers, opts);
  return res.json();
}

// Same request with stream: true. Caller consumes the SSE body.
export function openStream(url, body, headers, opts = {}) {
  return send(url, { ...body, stream: true }, { accept: 'text/event-stream', ...headers }, opts);
}
