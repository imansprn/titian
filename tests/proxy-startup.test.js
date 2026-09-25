'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadProxy, listen, close, register, pkcePair, startAuthorization, submitConsent } = require('./support');

const PROXY = path.join(__dirname, '..', 'mcp-auth-proxy.js');

describe('startup configuration', () => {
  it('exits with an error when MCP_PUBLIC_BASE is missing', () => {
    const env = { ...process.env };
    delete env.MCP_PUBLIC_BASE;
    const r = spawnSync(process.execPath, [PROXY], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /MCP_PUBLIC_BASE is required/);
  });
});

// No PIN and no static token configured: the proxy must generate its own secrets.
describe('secret bootstrapping', () => {
  let base, proxy, dataDir;

  before(async () => {
    ({ proxy, dataDir } = loadProxy({ MCP_PUBLIC_BASE: 'https://titian.test///' }));
    base = await listen(proxy.server);
  });
  after(async () => {
    await close(proxy.server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('strips trailing slashes from MCP_PUBLIC_BASE', async () => {
    const body = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(body.issuer, 'https://titian.test');
  });

  for (const [file, pattern] of [['.oauth-consent-pin', /^[0-9a-f]{12}$/], ['.oauth-signing-key', /^[0-9a-f]{64}$/]]) {
    it(`generates ${file} with mode 0600`, () => {
      const p = path.join(dataDir, file);
      assert.match(fs.readFileSync(p, 'utf8').trim(), pattern);
      assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    });
  }

  async function consent(pin) {
    const { body: client } = await register(base);
    const { authId } = await startAuthorization(base, client.client_id, pkcePair().challenge);
    return submitConsent(base, authId, pin);
  }

  it('does not accept "null" as the PIN', async () => {
    assert.equal((await consent('null')).status, 401);
  });

  it('accepts the generated PIN', async () => {
    const pin = fs.readFileSync(path.join(dataDir, '.oauth-consent-pin'), 'utf8').trim();
    assert.equal((await consent(pin)).status, 302);
  });
});
