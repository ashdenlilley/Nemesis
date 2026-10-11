const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_RETRY_WAIT_MS = 30_000;
export const DEFAULT_IDLE_MS = 120_000;

// retryable: the same request may succeed if sent again (overload, dropped connection, stall).
export class ProviderError extends Error {
  constructor(message, status, { retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
  }
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function failureFrom(res) {
  const text = await res.text().catch(() => '');
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
    { retryable: RETRYABLE.has(res.status) },
  );
}

// Wait before retry `attempt`: the server's retry-after when given, else 1s, 2s, 4s, 8s.
function retryDelay(res, attempt) {
  const header = Number(res?.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, MAX_RETRY_WAIT_MS);
  return Math.min(1000 * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

// Network failures from fetch (reset sockets, DNS blips, closed keep-alive connections) are retryable.
export function networkError(err, when = 'network error') {
  const code = err.cause?.code ?? err.code;
  const detail = code ?? err.cause?.message ?? err.message;
  return new ProviderError(`${when}: ${detail}`, undefined, { retryable: true });
}

// POST with retry on transient failures. Resolves to the successful Response (body unread).
// idleMs bounds the wait for response headers. onRetry({ attempt, delayMs, error }) reports each retry.
async function send(url, body, headers, { signal, retries = 4, idleMs = DEFAULT_IDLE_MS, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    let error;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), idleMs);
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw abortError();
      error = timeout.signal.aborted
        ? new ProviderError(`no response from ${new URL(url).host} after ${Math.round(idleMs / 1000)}s`, undefined, { retryable: true })
        : networkError(err);
    } finally {
      clearTimeout(timer);
    }
    if (res?.ok) return res;
    if (res) error = await failureFrom(res);
    if (!error.retryable || attempt >= retries) throw error;
    const delayMs = retryDelay(res, attempt);
    onRetry?.({ attempt: attempt + 1, retries, delayMs, error });
    await sleep(delayMs, signal);
  }
}

export async function postJson(url, body, headers, opts = {}) {
  const res = await send(url, body, headers, opts);
  try {
    return await res.json();
  } catch (err) {
    if (opts.signal?.aborted) throw abortError();
    throw networkError(err, 'connection lost reading response');
  }
}

// Same request with stream: true. Caller consumes the SSE body.
export function openStream(url, body, headers, opts = {}) {
  return send(url, { ...body, stream: true }, { accept: 'text/event-stream', ...headers }, opts);
}
