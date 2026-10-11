// Web tools. Both are 'exec' risk so they ask before reaching the network by default.
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 300_000;

// HTML -> readable text. Keeps paragraph and list breaks; drops scripts, styles and tags.
export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const signalFor = (ctx) => (ctx?.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));

export const webFetchTool = {
  name: 'web_fetch',
  risk: 'exec',
  concurrent: true,
  description: 'Fetch an http(s) URL and return its text (HTML is converted to plain text). Use for documentation or a URL the user gave.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Full URL, including https://' } },
    required: ['url'],
  },
  describeCall: (input) => input.url,
  target: (input) => input.url,
  async run({ url }, ctx) {
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`not a valid URL: ${url}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https URLs can be fetched');
    const res = await fetch(u, { redirect: 'follow', headers: { 'user-agent': 'Nemesis' }, signal: signalFor(ctx) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${u.host}`);
    const type = res.headers.get('content-type') ?? '';
    const text = (await res.text()).slice(0, MAX_BYTES);
    return /html/i.test(type) ? htmlToText(text) : text;
  },
};

export const webSearchTool = {
  name: 'web_search',
  risk: 'exec',
  concurrent: true,
  description: 'Search the web and return titles, URLs and snippets. Needs BRAVE_API_KEY in the environment.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      count: { type: 'integer', description: 'Results to return, 1-10 (default 5)' },
    },
    required: ['query'],
  },
  describeCall: (input) => input.query,
  target: (input) => input.query,
  async run({ query, count = 5 }, ctx) {
    const key = process.env.BRAVE_API_KEY;
    if (!key) throw new Error('web_search needs BRAVE_API_KEY set (free key at https://brave.com/search/api/)');
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(10, Math.max(1, count))));
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'x-subscription-token': key },
      signal: signalFor(ctx),
    });
    if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
    const data = await res.json();
    const results = data.web?.results ?? [];
    if (!results.length) return 'no results';
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.description ?? '').replace(/<[^>]+>/g, '')}`)
      .join('\n');
  },
};

export const webTools = [webFetchTool, webSearchTool];
