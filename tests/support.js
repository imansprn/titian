'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The proxy logs every request to stderr; keep test output readable unless asked.
if (!process.env.TEST_VERBOSE) console.error = () => {};

// mcp-auth-proxy.js reads its config at require time, so each test file sets the
// env it needs and loads the module once (node --test runs files in separate processes).
function loadProxy(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'titian-test-'));
  for (const k of ['MCP_AUTH_TOKEN', 'MCP_OAUTH_SIGNING_KEY', 'MCP_OAUTH_PIN']) delete process.env[k];
  Object.assign(process.env, { MCP_PUBLIC_BASE: 'https://titian.test', MCP_DATA_DIR: dataDir, ...env });
  const proxy = require(process.env.TITIAN_PROXY_MODULE || '../mcp-auth-proxy.js');
  return { proxy, dataDir };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const REDIRECT = 'https://client.test/callback';

async function register(base, body = { client_name: 'Test client', redirect_uris: [REDIRECT] }) {
  const res = await fetch(`${base}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function authorizeUrl(base, params) {
  const q = new URLSearchParams({
    response_type: 'code', redirect_uri: REDIRECT, code_challenge_method: 'S256', state: 'st4te', ...params,
  });
  return `${base}/authorize?${q}`;
}

// Opens the consent page and returns the pending auth_id embedded in the form.
async function startAuthorization(base, clientId, challenge) {
  const res = await fetch(authorizeUrl(base, { client_id: clientId, code_challenge: challenge }));
  const html = await res.text();
  const m = html.match(/name="auth_id" value="([0-9a-f]+)"/);
  return { status: res.status, html, authId: m && m[1] };
}

function submitConsent(base, authId, pin, decision = 'approve') {
  return fetch(`${base}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ auth_id: authId, pin, decision }).toString(),
    redirect: 'manual',
  });
}

function postToken(base, params, headers = {}) {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

// Runs register -> consent -> code exchange and returns the token response.
async function fullAuthorization(base, pin) {
  const { body: client } = await register(base);
  const { verifier, challenge } = pkcePair();
  const { authId } = await startAuthorization(base, client.client_id, challenge);
  const approved = await submitConsent(base, authId, pin);
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  const res = await postToken(base, {
    grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: client.client_id,
  });
  return { client, tokens: await res.json() };
}

module.exports = {
  REDIRECT, loadProxy, listen, close, pkcePair, register, authorizeUrl,
  startAuthorization, submitConsent, postToken, fullAuthorization,
};
