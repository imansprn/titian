'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadProxy } = require('./support');

const { proxy, dataDir } = loadProxy({ MCP_AUTH_TOKEN: 'static-token', MCP_OAUTH_PIN: 'pin' });
const { signJWT, verifyJWT, isAuthorized, isSafeRedirect, escapeHtml, timingSafeEqual } = proxy;

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('isSafeRedirect', () => {
  const cases = [
    ['https://chatgpt.com/connector/oauth/callback', true],
    ['http://localhost:3000/cb', true],
    ['http://127.0.0.1/cb', true],
    ['http://[::1]:8080/cb', true],
    ['http://example.com/cb', false],
    ['javascript:alert(1)', false],
    ['data:text/html,hi', false],
    ['not a url', false],
    ['', false],
    [null, false],
  ];
  for (const [uri, expected] of cases) {
    it(`${JSON.stringify(uri)} -> ${expected}`, () => assert.equal(isSafeRedirect(uri), expected));
  }
});

describe('escapeHtml', () => {
  it('escapes all HTML-significant characters', () => {
    assert.equal(escapeHtml(`<script>alert("x" & 'y')</script>`),
      '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;');
  });
  it('stringifies non-string input', () => assert.equal(escapeHtml(42), '42'));
});

describe('timingSafeEqual', () => {
  it('matches equal strings', () => assert.equal(timingSafeEqual('abc', 'abc'), true));
  it('rejects different strings of equal length', () => assert.equal(timingSafeEqual('abc', 'abd'), false));
  it('rejects different lengths', () => assert.equal(timingSafeEqual('abc', 'abcd'), false));
});

describe('signJWT / verifyJWT', () => {
  const now = Math.floor(Date.now() / 1000);

  it('round-trips the payload', () => {
    const payload = { sub: 'client-1', iss: 'https://titian.test', aud: 'https://titian.test/mcp', iat: now, exp: now + 60 };
    assert.deepEqual(verifyJWT(signJWT(payload)), payload);
  });

  it('rejects tokens without exp', () => {
    assert.equal(verifyJWT(signJWT({ sub: 'x' })), null);
  });

  it('rejects expired tokens', () => {
    assert.equal(verifyJWT(signJWT({ sub: 'x', exp: now - 1 })), null);
  });

  it('rejects a tampered payload', () => {
    const [h, , s] = signJWT({ sub: 'client-1' }).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'admin' })).toString('base64url');
    assert.equal(verifyJWT(`${h}.${forged}.${s}`), null);
  });

  it('rejects malformed tokens', () => {
    assert.equal(verifyJWT('a.b'), null);
    assert.equal(verifyJWT('not-a-jwt'), null);
    assert.equal(verifyJWT(''), null);
  });
});

describe('isAuthorized', () => {
  const req = (headers = {}, url = '/mcp') => ({ headers: { host: 'localhost', ...headers }, url });

  it('accepts the static token as a bearer header', () => {
    assert.equal(isAuthorized(req({ authorization: 'Bearer static-token' })), true);
  });
  it('accepts a valid JWT', () => {
    assert.equal(isAuthorized(req({ authorization: `bearer ${signJWT({ sub: 'c', iss: 'https://titian.test', aud: 'https://titian.test/mcp', exp: Date.now() / 1000 + 60 })}` })), true);
  });
  it('accepts the static token as ?token=', () => {
    assert.equal(isAuthorized(req({}, '/mcp?token=static-token')), true);
  });
  it('rejects a wrong bearer token', () => {
    assert.equal(isAuthorized(req({ authorization: 'Bearer nope' })), false);
  });
  it('rejects a wrong ?token=', () => {
    assert.equal(isAuthorized(req({}, '/mcp?token=nope')), false);
  });
  it('rejects requests without credentials', () => {
    assert.equal(isAuthorized(req()), false);
  });
});
