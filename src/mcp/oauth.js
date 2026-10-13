import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nemesisHome } from '../config.js';

// OAuth 2.1 authorization code flow with PKCE, for remote MCP servers. Steps: find the authorization
// server (protected resource metadata, RFC 9728), register a client if needed (RFC 7591), open the
// browser, catch the redirect on 127.0.0.1, exchange the code, and keep the tokens in ~/.nemesis/mcp-auth.json.

const LOGIN_TIMEOUT_MS = 5 * 60_000;

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// The server URL's own path is kept: https://host/mcp -> /.well-known/oauth-protected-resource/mcp.
export async function discover(serverUrl, fetchImpl = fetch) {
  const u = new URL(serverUrl);
  const suffix = u.pathname.replace(/\/$/, '');
  const resource = await getJson(fetchImpl, new URL(`/.well-known/oauth-protected-resource${suffix}`, u.origin))
    ?? await getJson(fetchImpl, new URL('/.well-known/oauth-protected-resource', u.origin));
  const asUrl = new URL(resource?.authorization_servers?.[0] ?? u.origin);
  for (const well of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    const meta = await getJson(fetchImpl, new URL(well, asUrl.origin));
    if (meta?.authorization_endpoint && meta?.token_endpoint) return meta;
  }
  throw new Error(`no OAuth metadata found at ${asUrl.origin}`);
}

export async function registerClient(meta, redirectUri, fetchImpl = fetch) {
  if (!meta.registration_endpoint) throw new Error('server has no dynamic client registration; set oauth.clientId in config');
  const res = await fetchImpl(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Nemesis',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`client registration failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.client_id) throw new Error('client registration returned no client_id');
  return data.client_id;
}

async function postToken(fetchImpl, endpoint, fields) {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`token request failed: ${data.error_description ?? data.error ?? `HTTP ${res.status}`}`);
  return data;
}

// Token store: one entry per server name. Written with 0600 where the OS supports it.
export function authStorePath(home) {
  return path.join(nemesisHome(home), 'mcp-auth.json');
}

export async function readAuthStore(home) {
  try {
    return JSON.parse(await readFile(authStorePath(home), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeAuthStore(home, store) {
  const file = authStorePath(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

function entryFrom(token, prior) {
  return {
    ...prior,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? prior.refresh_token,
    expires_at: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
  };
}

// Token source for McpHttpClient: returns a valid access token, refreshing it near expiry.
export function tokenSource({ name, home, fetchImpl = fetch }) {
  const refresh = async () => {
    const store = await readAuthStore(home);
    const prior = store[name];
    if (!prior?.refresh_token) return false;
    try {
      const token = await postToken(fetchImpl, prior.token_endpoint, {
        grant_type: 'refresh_token',
        refresh_token: prior.refresh_token,
        client_id: prior.client_id,
        resource: prior.resource,
      });
      store[name] = entryFrom(token, prior);
      await writeAuthStore(home, store);
      return true;
    } catch {
      return false;
    }
  };
  return {
    async token() {
      const entry = (await readAuthStore(home))[name];
      if (!entry) return null;
      if (entry.expires_at && Date.now() > entry.expires_at - 60_000 && entry.refresh_token) await refresh();
      return (await readAuthStore(home))[name]?.access_token ?? null;
    },
    refresh,
  };
}

// Termux (platform 'android') ships termux-open-url instead of xdg-open.
export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', url]];
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'android') return ['termux-open-url', [url]];
  return ['xdg-open', [url]];
}

export function openBrowser(url) {
  const [file, args] = browserCommand(url);
  spawn(file, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
}

// Full login. ui.info prints the URL too, in case the browser does not open.
export async function login({ name, serverUrl, home, ui, fetchImpl = fetch, openUrl = openBrowser, clientId: presetClientId = null }) {
  const meta = await discover(serverUrl, fetchImpl);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    const store = await readAuthStore(home);
    const clientId = presetClientId ?? store[name]?.client_id ?? await registerClient(meta, redirectUri, fetchImpl);
    const { verifier, challenge } = pkce();
    const state = randomBytes(16).toString('hex');
    const authUrl = new URL(meta.authorization_endpoint);
    Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: serverUrl,
    }).forEach(([k, v]) => authUrl.searchParams.set(k, v));

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('login timed out after 5 minutes')), LOGIN_TIMEOUT_MS);
      server.on('request', (req, res) => {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const error = u.searchParams.get('error');
        const ok = !error && u.searchParams.get('state') === state && u.searchParams.get('code');
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(ok
          ? '<h2>Nemesis is connected.</h2><p>You can close this tab.</p>'
          : '<h2>Login failed.</h2><p>Return to the terminal for details.</p>');
        clearTimeout(timer);
        if (ok) resolve(u.searchParams.get('code'));
        else reject(new Error(error ? `authorization denied: ${error}` : 'state mismatch in the redirect'));
      });
      ui.info(`opening the browser to sign in to ${name}; if it does not open, visit:\n${authUrl.toString()}`);
      openUrl(authUrl.toString());
    });

    const token = await postToken(fetchImpl, meta.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: serverUrl,
    });
    const fresh = await readAuthStore(home);
    fresh[name] = entryFrom(token, {
      client_id: clientId,
      token_endpoint: meta.token_endpoint,
      resource: serverUrl,
    });
    await writeAuthStore(home, fresh);
    return fresh[name];
  } finally {
    server.close();
  }
}
