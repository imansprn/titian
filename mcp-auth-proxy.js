#!/usr/bin/env node
'use strict';
/**
 * MCP Auth Reverse Proxy + OAuth 2.1 Authorization Server (MCP authorization spec).
 *
 * ChatGPT's MCP connector uses the CORE authorization flow:
 *   Dynamic Client Registration (DCR) + Authorization Code + PKCE (S256) + refresh tokens.
 * It does NOT support OAuth Client Credentials.
 *
 * Endpoints (all public via Tailscale Funnel):
 *   /.well-known/oauth-protected-resource      RFC 9728 protected resource metadata
 *   /.well-known/oauth-authorization-server    RFC 8414 authorization server metadata
 *   /.well-known/openid-configuration          OIDC discovery (alias)
 *   POST /register                             DCR (RFC 7591)
 *   GET/POST /authorize                        consent page -> authorization code
 *   POST /token                                authorization_code / refresh_token
 *   /mcp                                       auth gate -> proxy to Supergateway
 *
 * Security model (single user, public via Funnel):
 *   - Authorization code flow requires the user to approve in a browser and enter the
 *     consent PIN (the static token). No open token issuance without consent.
 *   - Access tokens: short-lived HS256 JWTs. Refresh tokens: opaque, 30 days, rotated.
 *   - The legacy static bearer token (and ?token=) still work as a fallback.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BASE_DIR = process.env.MCP_DATA_DIR || __dirname;
const LISTEN_HOST = process.env.MCP_PROXY_HOST || '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.MCP_PROXY_PORT || '8000', 10);
const UPSTREAM_HOST = process.env.MCP_UPSTREAM_HOST || '127.0.0.1';
const UPSTREAM_PORT = parseInt(process.env.MCP_UPSTREAM_PORT || '8001', 10);
const PUBLIC_BASE = (process.env.MCP_PUBLIC_BASE || '').replace(/\/+$/, '');
if (!PUBLIC_BASE) {
  console.error('[mcp-auth-proxy] MCP_PUBLIC_BASE is required (e.g. https://my-machine.my-tailnet.ts.net)');
  process.exit(1);
}
const SERVER_LABEL = process.env.MCP_SERVER_LABEL || os.hostname();
const MCP_ENDPOINT = PUBLIC_BASE + '/mcp';
const RESOURCE_METADATA = new URL(PUBLIC_BASE).pathname === '/'
  ? PUBLIC_BASE + '/.well-known/oauth-protected-resource'
  : new URL(PUBLIC_BASE).origin + '/.well-known/oauth-protected-resource' + new URL(MCP_ENDPOINT).pathname;
fs.mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 });

const ACCESS_TTL = 86400;     // access token lifetime: 24h
const REFRESH_TTL = 2592000;  // refresh token lifetime: 30 days
const CODE_TTL = 300000;      // auth code lifetime: 5 min
const AUTHREQ_TTL = 600000;   // pending consent request: 10 min

function loadFile(name) {
  try { return fs.readFileSync(path.join(BASE_DIR, name), 'utf8').trim(); } catch (_) { return null; }
}

// ---- secrets ----
const STATIC_TOKEN = process.env.MCP_AUTH_TOKEN || loadFile('.mcp-token');
let JWT_SECRET = process.env.MCP_OAUTH_SIGNING_KEY || loadFile('.oauth-signing-key');
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(BASE_DIR, '.oauth-signing-key'), JWT_SECRET + '\n', { mode: 0o600 });
}
let CONSENT_PIN = process.env.MCP_OAUTH_PIN || loadFile('.oauth-consent-pin') || STATIC_TOKEN;
if (!CONSENT_PIN) {
  CONSENT_PIN = randHex(6);
  fs.writeFileSync(path.join(BASE_DIR, '.oauth-consent-pin'), CONSENT_PIN + '\n', { mode: 0o600 });
  console.error(`[mcp-auth-proxy] generated consent PIN in ${path.join(BASE_DIR, '.oauth-consent-pin')}`);
}

// ---- in-memory OAuth state ----
const clients = Object.create(null);   // client_id -> { secret, name, redirect_uris: [] }
const authReqs = Object.create(null);  // auth_id -> { client_id, redirect_uri, code_challenge, code_challenge_method, state, exp }
const codes = Object.create(null);     // code -> { client_id, redirect_uri, code_challenge, exp }
const refresh = Object.create(null);   // refresh_token -> { client_id, exp }

// Clients and refresh tokens are persisted so a proxy restart doesn't invalidate ChatGPT's login.
const STATE_FILE = path.join(BASE_DIR, '.oauth-state.json');
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  Object.assign(clients, saved.clients || {});
  Object.assign(refresh, saved.refresh || {});
} catch (_) {}
function saveState() {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, v] of Object.entries(refresh)) if (v.exp < now) delete refresh[k];
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ clients, refresh }), { mode: 0o600 }); } catch (e) { console.error('saveState failed:', e.message); }
}

// Pre-registered client (authorization-code flow only).
const PREREG_ID = loadFile('.oauth-client-id');
const PREREG_SECRET = loadFile('.oauth-client-secret');
if (PREREG_ID && PREREG_SECRET) {
  clients[PREREG_ID] = { secret: PREREG_SECRET, name: 'ChatGPT (pre-registered)', redirect_uris: [] };
}

function randHex(n) { return crypto.randomBytes(n).toString('hex'); }
function timingSafeEqual(x, y) {
  const a = Buffer.from(String(x)), b = Buffer.from(String(y));
  if (a.length !== b.length) { crypto.timingSafeEqual(a, a); return false; }
  return crypto.timingSafeEqual(a, b);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function signJWT(payload) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}
function verifyJWT(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (!payload || !Number.isFinite(payload.exp) || Date.now() / 1000 >= payload.exp || payload.iss !== PUBLIC_BASE || payload.aud !== MCP_ENDPOINT) return null;
    return payload;
  } catch (_) { return null; }
}
function isAuthorized(req) {
  const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
  if (m) {
    const t = m[1].trim();
    if (STATIC_TOKEN && timingSafeEqual(t, STATIC_TOKEN)) return true;
    if (verifyJWT(t)) return true;
  }
  try {
    const q = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('token');
    if (q && STATIC_TOKEN && timingSafeEqual(q, STATIC_TOKEN)) return true;
  } catch (_) {}
  return false;
}
function isSafeRedirect(uri) {
  if (typeof uri !== 'string' || !uri) return false;
  try {
    const u = new URL(uri);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return true;
    return false;
  } catch (_) { return false; }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id, X-Requested-With',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
  'Access-Control-Max-Age': '86400',
};
function sendJSON(res, status, obj, extra) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS, ...(extra || {}) });
  res.end(JSON.stringify(obj));
}
function sendHTML(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
function readBody(req, cb) {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
  req.on('end', () => cb(data));
}
function parseForm(body) {
  try { return Object.fromEntries(new URLSearchParams(body)); } catch (_) { return {}; }
}
function log(req, status, auth) {
  const safeUrl = req.url.replace(/([?&]token=)[^&]*/gi, '$1REDACTED');
  console.error(`[${new Date().toISOString()}] ${req.socket.remoteAddress} ${req.method} ${safeUrl} -> ${status} auth=${auth}`);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch (_) { sendJSON(res, 400, { error: 'invalid_request' }); return; }
  const pathname = url.pathname;

  // ---- Protected Resource Metadata (RFC 9728) ----
  if (pathname === '/.well-known/oauth-protected-resource') {
    sendJSON(res, 200, { resource: MCP_ENDPOINT, authorization_servers: [PUBLIC_BASE], scopes_supported: [], bearer_methods_supported: ['header'] });
    return;
  }

  // ---- Authorization Server Metadata (RFC 8414) + OIDC ----
  if (pathname === '/.well-known/oauth-authorization-server' || pathname === '/.well-known/openid-configuration') {
    sendJSON(res, 200, {
      issuer: PUBLIC_BASE,
      authorization_endpoint: PUBLIC_BASE + '/authorize',
      token_endpoint: PUBLIC_BASE + '/token',
      registration_endpoint: PUBLIC_BASE + '/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [],
    });
    return;
  }

  // ---- Dynamic Client Registration (RFC 7591) ----
  if (pathname === '/register' && req.method === 'POST') {
    readBody(req, (body) => {
      let meta;
      try { meta = JSON.parse(body); } catch (_) { sendJSON(res, 400, { error: 'invalid_client_metadata' }); return; }
      if (!meta || typeof meta !== 'object' || Array.isArray(meta) ||
          (meta.client_name !== undefined && typeof meta.client_name !== 'string') ||
          !Array.isArray(meta.redirect_uris)) {
        sendJSON(res, 400, { error: 'invalid_client_metadata' }); return;
      }
      const redirectUris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.filter(isSafeRedirect) : [];
      if (!redirectUris.length) { sendJSON(res, 400, { error: 'invalid_redirect_uri' }); return; }
      const clientId = 'mcp-' + randHex(9);
      const clientSecret = randHex(24);
      clients[clientId] = { secret: clientSecret, name: meta.client_name || 'MCP client', redirect_uris: redirectUris };
      saveState();
      log(req, 201, false);
      sendJSON(res, 201, {
        client_id: clientId,
        client_secret: clientSecret,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    });
    return;
  }

  // ---- Authorize (GET = consent page, POST = approve/deny) ----
  if (pathname === '/authorize') {
    if (req.method === 'GET') {
      const client_id = url.searchParams.get('client_id');
      const redirect_uri = url.searchParams.get('redirect_uri');
      const code_challenge = url.searchParams.get('code_challenge');
      const code_challenge_method = url.searchParams.get('code_challenge_method');
      const state = url.searchParams.get('state');
      const response_type = url.searchParams.get('response_type');
      if (response_type !== 'code') { sendJSON(res, 400, { error: 'unsupported_response_type' }); return; }
      if (!clients[client_id]) { log(req, 400, 'unknown-client'); sendJSON(res, 400, { error: 'invalid_client', error_description: 'unknown client' }); return; }
      if (!clients[client_id].redirect_uris.includes(redirect_uri)) { sendJSON(res, 400, { error: 'invalid_request', error_description: 'unregistered redirect_uri' }); return; }
      if (!isSafeRedirect(redirect_uri)) { sendJSON(res, 400, { error: 'invalid_request', error_description: 'unsafe redirect_uri' }); return; }
      if (code_challenge_method !== 'S256' || !code_challenge) { sendJSON(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 required' }); return; }
      const authId = randHex(16);
      authReqs[authId] = { client_id, redirect_uri, code_challenge, state, exp: Date.now() + AUTHREQ_TTL };
      const clientName = clients[client_id].name || 'this application';
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authorize</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1c1c1e;padding:32px;border-radius:14px;max-width:420px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,.5)}
h2{margin:0 0 8px;font-size:20px}p{margin:0 0 20px;color:#a0a0a0;font-size:14px;line-height:1.5}
label{font-size:13px;color:#ccc;display:block;margin-bottom:6px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #333;background:#000;color:#eee;font-size:14px;margin-bottom:16px}
.btns{display:flex;gap:10px}button{flex:1;padding:10px;border-radius:8px;border:none;font-size:14px;cursor:pointer;font-weight:600}
.approve{background:#0a84ff;color:#fff}.deny{background:#333;color:#eee}
.warn{background:#2b1a00;color:#ffb84d;padding:10px;border-radius:8px;font-size:12px;margin-bottom:16px}</style></head>
<body><div class="card"><h2>Authorize ${escapeHtml(clientName)}</h2>
<div class="warn">⚠️ This grants access to Desktop Commander on <b>${escapeHtml(SERVER_LABEL)}</b> — full filesystem &amp; terminal (as your user).</div>
<p>Enter the consent PIN (see the <code>.oauth-consent-pin</code> file on the server) to approve.</p>
<form method="POST" action="${escapeHtml(PUBLIC_BASE)}/authorize"><input type="hidden" name="auth_id" value="${authId}">
<label for="pin">Consent PIN</label><input type="password" name="pin" id="pin" autofocus>
<div class="btns"><button type="submit" name="decision" value="approve" class="approve">Approve</button>
<button type="submit" name="decision" value="deny" class="deny">Deny</button></div></form></div></body></html>`;
      sendHTML(res, 200, html);
      return;
    }

    if (req.method === 'POST') {
      readBody(req, (body) => {
        const f = parseForm(body);
        const authReq = authReqs[f.auth_id];
        if (!authReq || Date.now() > authReq.exp) { sendHTML(res, 400, '<h1>Expired</h1><p>This authorization request has expired. Please retry from your client.</p>'); return; }
        delete authReqs[f.auth_id];
        const rd = new URL(authReq.redirect_uri);
        rd.searchParams.set('state', authReq.state || '');
        if (f.decision !== 'approve') {
          rd.searchParams.set('error', 'access_denied');
          res.writeHead(302, { Location: rd.href });
          res.end();
          return;
        }
        if (!timingSafeEqual(f.pin || '', CONSENT_PIN)) {
          sendHTML(res, 401, '<h1>Wrong PIN</h1><p>The consent PIN you entered is incorrect.</p><p><a href="javascript:history.back()">Go back</a></p>');
          return;
        }
        const code = randHex(24);
        codes[code] = { client_id: authReq.client_id, redirect_uri: authReq.redirect_uri, code_challenge: authReq.code_challenge, exp: Date.now() + CODE_TTL };
        rd.searchParams.set('code', code);
        res.writeHead(302, { Location: rd.href });
        res.end();
      });
      return;
    }
    sendJSON(res, 405, { error: 'method_not_allowed' });
    return;
  }

  // ---- Token endpoint ----
  if (pathname === '/token' && req.method === 'POST') {
    readBody(req, (body) => {
      let p = {};
      try { p = JSON.parse(body); } catch (_) { p = parseForm(body); }
      if (!p || typeof p !== 'object' || Array.isArray(p) || Object.values(p).some(v => typeof v !== 'string')) {
        sendJSON(res, 400, { error: 'invalid_request' }); return;
      }
      let cid = p.client_id || '';
      let csec = p.client_secret || '';
      const basic = (req.headers['authorization'] || '').match(/^Basic\s+(.+)$/i);
      if (basic) { const d = Buffer.from(basic[1], 'base64').toString().split(':'); cid = cid || d[0] || ''; csec = csec || d[1] || ''; }

      const grant = p.grant_type || '';
      const now = Math.floor(Date.now() / 1000);

      // authorization_code + PKCE
      if (grant === 'authorization_code') {
        const code = codes[p.code];
        if (!code || Date.now() > code.exp) { sendJSON(res, 400, { error: 'invalid_grant', error_description: 'code expired or invalid' }); return; }
        delete codes[p.code];
        if (p.redirect_uri !== code.redirect_uri) { sendJSON(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' }); return; }
        if (cid !== code.client_id) { sendJSON(res, 400, { error: 'invalid_grant', error_description: 'client mismatch' }); return; }
        // PKCE
        const verifier = p.code_verifier || '';
        if (!verifier) { sendJSON(res, 400, { error: 'invalid_grant', error_description: 'missing code_verifier' }); return; }
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        if (!timingSafeEqual(challenge, code.code_challenge)) { sendJSON(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' }); return; }

        const access_token = signJWT({ iss: PUBLIC_BASE, aud: MCP_ENDPOINT, sub: code.client_id, iat: now, exp: now + ACCESS_TTL });
        const refresh_token = randHex(32);
        refresh[refresh_token] = { client_id: code.client_id, exp: now + REFRESH_TTL };
        saveState();
        log(req, 200, 'code');
        sendJSON(res, 200, { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token, scope: '' }, { 'Cache-Control': 'no-store' });
        return;
      }

      // refresh_token
      if (grant === 'refresh_token') {
        const rt = p.refresh_token || '';
        const rec = refresh[rt];
        if (!rec || rec.exp < now || cid !== rec.client_id) { log(req, 400, 'refresh-invalid'); sendJSON(res, 400, { error: 'invalid_grant', error_description: 'refresh token invalid or expired' }); return; }
        delete refresh[rt];
        const access_token = signJWT({ iss: PUBLIC_BASE, aud: MCP_ENDPOINT, sub: rec.client_id, iat: now, exp: now + ACCESS_TTL });
        const new_rt = randHex(32);
        refresh[new_rt] = { client_id: rec.client_id, exp: now + REFRESH_TTL };
        saveState();
        log(req, 200, 'refresh');
        sendJSON(res, 200, { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: new_rt, scope: '' }, { 'Cache-Control': 'no-store' });
        return;
      }

      sendJSON(res, 400, { error: 'unsupported_grant_type', error_description: 'supported: authorization_code, refresh_token' });
    });
    return;
  }

  // ---- health ----
  if (pathname === '/healthz' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain', ...CORS });
    res.end('ok');
    return;
  }

  // ---- CORS preflight ----
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // ---- auth gate (MCP) ----
  if (!isAuthorized(req)) {
    res.writeHead(401, {
      'Content-Type': 'application/json', ...CORS,
      'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE_METADATA}"`,
    });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
    log(req, 401, false);
    return;
  }

  // ---- proxy to Supergateway ----
  const proxyReq = http.request({ agent: false,
    host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, method: req.method,
    headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, ...CORS });
    log(req, proxyRes.statusCode, true);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    sendJSON(res, 502, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad gateway: ' + err.message }, id: null });
    log(req, 502, true);
  });
  req.on('error', () => {
    proxyReq.destroy();
  });
  res.on('close', () => {
    if (!res.finished) {
      proxyReq.destroy();
    }
  });
  req.pipe(proxyReq);
});

server.on('clientError', (_e, socket) => { console.error('clientError', _e.code, _e.message); if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
if (require.main === module) {
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.error(`[mcp-auth-proxy] ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT} | oauth issuer=${PUBLIC_BASE}`);
  });
}

module.exports = { server, signJWT, verifyJWT, isAuthorized, isSafeRedirect, escapeHtml, timingSafeEqual };
