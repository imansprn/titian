'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const {
  REDIRECT, loadProxy, listen, close, pkcePair, register, authorizeUrl,
  startAuthorization, submitConsent, postToken, fullAuthorization,
} = require('./support');

const PIN = 'correct-pin';
const STATIC = 'static-token';

// Stand-in for the HTTP bridge; records what the proxy forwarded.
let lastUpstream = null;
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    lastUpstream = { method: req.method, url: req.url, headers: req.headers, body };
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  });
});

let base, proxy, dataDir;

before(async () => {
  const upstreamUrl = new URL(await listen(upstream));
  ({ proxy, dataDir } = loadProxy({
    MCP_AUTH_TOKEN: STATIC, MCP_OAUTH_PIN: PIN, MCP_SERVER_LABEL: '<b>box</b>',
    MCP_UPSTREAM_HOST: '127.0.0.1', MCP_UPSTREAM_PORT: upstreamUrl.port,
  }));
  base = await listen(proxy.server);
});

after(async () => {
  await close(proxy.server);
  if (upstream.listening) await close(upstream);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('discovery metadata', () => {
  it('serves protected resource metadata (RFC 9728)', async () => {
    const body = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(body.resource, 'https://titian.test/mcp');
    assert.deepEqual(body.authorization_servers, ['https://titian.test']);
  });

  for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    it(`serves authorization server metadata at ${p}`, async () => {
      const body = await (await fetch(base + p)).json();
      assert.equal(body.issuer, 'https://titian.test');
      assert.equal(body.token_endpoint, 'https://titian.test/token');
      assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
    });
  }

  it('answers health checks and CORS preflight', async () => {
    assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
    const pre = await fetch(`${base}/mcp`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /Mcp-Session-Id/);
  });
});

describe('dynamic client registration', () => {
  it('issues credentials and keeps only safe redirect URIs', async () => {
    const { status, body } = await register(base, {
      client_name: 'X',
      redirect_uris: ['https://ok.test/cb', 'http://evil.test/cb', 'http://localhost:3000/cb', 'javascript:alert(1)'],
    });
    assert.equal(status, 201);
    assert.match(body.client_id, /^mcp-[0-9a-f]{18}$/);
    assert.ok(body.client_secret);
    assert.deepEqual(body.redirect_uris, ['https://ok.test/cb', 'http://localhost:3000/cb']);
  });

  it('persists registered clients to the state file', async () => {
    const { body } = await register(base);
    const state = JSON.parse(fs.readFileSync(`${dataDir}/.oauth-state.json`, 'utf8'));
    assert.ok(state.clients[body.client_id]);
  });
});

describe('authorization endpoint', () => {
  let clientId;
  before(async () => { clientId = (await register(base)).body.client_id; });

  const rejects = [
    ['a non-code response_type', { response_type: 'token' }, 'unsupported_response_type'],
    ['an unknown client', { client_id: 'mcp-unknown' }, 'invalid_client'],
    ['an unsafe redirect_uri', { redirect_uri: 'http://evil.test/cb' }, 'invalid_request'],
    ['a missing code_challenge', { code_challenge: '' }, 'invalid_request'],
    ['the plain PKCE method', { code_challenge_method: 'plain' }, 'invalid_request'],
  ];
  for (const [what, override, error] of rejects) {
    it(`rejects ${what}`, async () => {
      const res = await fetch(authorizeUrl(base, { client_id: clientId, code_challenge: 'abc', ...override }));
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, error);
    });
  }

  it('escapes the client name and server label on the consent page', async () => {
    const { body } = await register(base, { client_name: '<script>alert(1)</script>', redirect_uris: [REDIRECT] });
    const { status, html } = await startAuthorization(base, body.client_id, 'abc');
    assert.equal(status, 200);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;b&gt;box&lt;/b&gt;'));
  });

  it('rejects a wrong PIN', async () => {
    const { authId } = await startAuthorization(base, clientId, 'abc');
    const res = await submitConsent(base, authId, 'wrong-pin');
    assert.equal(res.status, 401);
  });

  it('rejects an unknown auth_id', async () => {
    const res = await submitConsent(base, 'deadbeef', PIN);
    assert.equal(res.status, 400);
  });

  it('redirects with access_denied when the user denies', async () => {
    const { authId } = await startAuthorization(base, clientId, 'abc');
    const res = await submitConsent(base, authId, '', 'deny');
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, REDIRECT);
    assert.equal(loc.searchParams.get('error'), 'access_denied');
    assert.equal(loc.searchParams.get('state'), 'st4te');
  });

  it('redirects with a code and the original state on approval', async () => {
    const { authId } = await startAuthorization(base, clientId, 'abc');
    const res = await submitConsent(base, authId, PIN);
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.match(loc.searchParams.get('code'), /^[0-9a-f]{48}$/);
    assert.equal(loc.searchParams.get('state'), 'st4te');
  });
});

describe('token endpoint', () => {
  async function getCode() {
    const { body: client } = await register(base);
    const pkce = pkcePair();
    const { authId } = await startAuthorization(base, client.client_id, pkce.challenge);
    const res = await submitConsent(base, authId, PIN);
    return { client, ...pkce, code: new URL(res.headers.get('location')).searchParams.get('code') };
  }

  it('exchanges a code for tokens with a valid PKCE verifier', async () => {
    const { client, verifier, code } = await getCode();
    const res = await postToken(base, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.token_type, 'Bearer');
    assert.equal(body.expires_in, 86400);
    assert.ok(body.refresh_token);
    const claims = proxy.verifyJWT(body.access_token);
    assert.equal(claims.sub, client.client_id);
    assert.equal(claims.aud, 'https://titian.test/mcp');
  });

  it('accepts a JSON request body', async () => {
    const { verifier, code } = await getCode();
    const res = await fetch(`${base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: verifier }),
    });
    assert.equal(res.status, 200);
  });

  it('rejects code replay', async () => {
    const { verifier, code } = await getCode();
    const params = { grant_type: 'authorization_code', code, code_verifier: verifier };
    assert.equal((await postToken(base, params)).status, 200);
    const replay = await postToken(base, params);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'invalid_grant');
  });

  const badExchanges = [
    ['a wrong PKCE verifier', () => ({ code_verifier: 'wrong-verifier' }), /PKCE/],
    ['a missing PKCE verifier', () => ({ code_verifier: '' }), /code_verifier/],
    ['a mismatched redirect_uri', () => ({ redirect_uri: 'https://other.test/cb' }), /redirect_uri/],
    ['a mismatched client_id', () => ({ client_id: 'mcp-someone-else' }), /client/],
  ];
  for (const [what, override, desc] of badExchanges) {
    it(`rejects ${what}`, async () => {
      const { verifier, code } = await getCode();
      const res = await postToken(base, { grant_type: 'authorization_code', code, code_verifier: verifier, ...override() });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'invalid_grant');
      assert.match(body.error_description, desc);
    });
  }

  it('rotates refresh tokens and rejects the old one', async () => {
    const { tokens } = await fullAuthorization(base, PIN);
    const first = await postToken(base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(first.status, 200);
    const rotated = await first.json();
    assert.notEqual(rotated.refresh_token, tokens.refresh_token);
    assert.ok(proxy.verifyJWT(rotated.access_token));

    const reused = await postToken(base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(reused.status, 400);
    assert.equal((await reused.json()).error, 'invalid_grant');
  });

  it('issues tokens for client_credentials with a valid secret (basic and post)', async () => {
    const { body: client } = await register(base);
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const viaBasic = await postToken(base, { grant_type: 'client_credentials' }, { authorization: `Basic ${basic}` });
    assert.equal(viaBasic.status, 200);
    const viaPost = await postToken(base, {
      grant_type: 'client_credentials', client_id: client.client_id, client_secret: client.client_secret,
    });
    assert.equal(viaPost.status, 200);
  });

  it('rejects client_credentials with a wrong secret', async () => {
    const { body: client } = await register(base);
    const res = await postToken(base, { grant_type: 'client_credentials', client_id: client.client_id, client_secret: 'nope' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'invalid_client');
  });

  it('rejects unsupported grant types', async () => {
    const res = await postToken(base, { grant_type: 'password' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'unsupported_grant_type');
  });
});

describe('/mcp gate and proxying', () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
  const post = (url, headers = {}) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(init),
  });

  it('returns 401 with a resource_metadata challenge when unauthenticated', async () => {
    lastUpstream = null;
    const res = await post(`${base}/mcp`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'),
      'Bearer resource_metadata="https://titian.test/.well-known/oauth-protected-resource"');
    assert.equal((await res.json()).error.code, -32001);
    assert.equal(lastUpstream, null);
  });

  it('rejects a forged JWT', async () => {
    const forged = proxy.signJWT({ sub: 'x' }).replace(/\.[^.]+$/, '.AAAA');
    assert.equal((await post(`${base}/mcp`, { authorization: `Bearer ${forged}` })).status, 401);
  });

  it('proxies requests with an OAuth access token', async () => {
    const { tokens } = await fullAuthorization(base, PIN);
    const res = await post(`${base}/mcp`, { authorization: `Bearer ${tokens.access_token}` });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('mcp-session-id'), 'sess-1');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(lastUpstream.url, '/mcp');
    assert.equal(lastUpstream.headers.host, `127.0.0.1:${upstream.address().port}`);
    assert.deepEqual(JSON.parse(lastUpstream.body), init);
  });

  it('proxies requests with the static token and redacts it from logs', async (t) => {
    const lines = [];
    t.mock.method(console, 'error', (line) => lines.push(line));
    const res = await post(`${base}/mcp?token=${STATIC}`);
    assert.equal(res.status, 200);
    const logged = lines.join('\n');
    assert.match(logged, /token=REDACTED/);
    assert.ok(!logged.includes(STATIC));
  });

  // Keep last: shuts the fake upstream down.
  it('returns 502 when the upstream is unreachable', async () => {
    await close(upstream);
    const res = await post(`${base}/mcp`, { authorization: `Bearer ${STATIC}` });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, -32000);
  });
});
