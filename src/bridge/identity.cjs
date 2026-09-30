// Authenticate again at the execution boundary; never trust client identity headers.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function equal(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function readSecret(directory, name) {
  if (!directory) return '';
  try { return fs.readFileSync(path.join(directory, name), 'utf8').trim(); }
  catch { return ''; }
}
function authenticate(req, env = process.env) {
  const directory = env.MCP_DC_CONFIG_DIR;
  const staticToken = env.MCP_AUTH_TOKEN || readSecret(directory, '.mcp-token');
  const authorization = req.headers.authorization;
  const bearer = typeof authorization === 'string' && /^Bearer\s+(.+)$/i.exec(authorization);
  const query = new URL(req.url, 'http://localhost').searchParams.get('token');
  const token = bearer ? bearer[1].trim() : query;
  if (!token) return null;
  if (staticToken && equal(token, staticToken)) {
    return 'static:' + crypto.createHash('sha256').update(token).digest('hex');
  }
  // Legacy query credentials are static-token only, matching the auth proxy.
  if (!bearer) return null;
  const key = env.MCP_OAUTH_SIGNING_KEY || readSecret(directory, '.oauth-signing-key');
  const issuer = (env.MCP_PUBLIC_BASE || '').replace(/\/+$/, '');
  if (!key || !issuer) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expected = crypto.createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
    if (!equal(signature, expected)) return null;
    const h = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (h.alg !== 'HS256' || !Number.isFinite(p.exp) || Date.now() / 1000 >= p.exp ||
        p.iss !== issuer || p.aud !== issuer + '/mcp' || typeof p.sub !== 'string' || !p.sub) return null;
    return 'oauth:' + p.sub;
  } catch { return null; }
}
module.exports = { authenticate };
