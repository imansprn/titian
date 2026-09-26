'use strict';
const { it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadProxy, listen, close, register, authorizeUrl, fullAuthorization, postToken, REDIRECT, pkcePair, startAuthorization, submitConsent } = require('./support');
let proxy, dataDir, base;
const PIN = 'security-test-pin';
before(async () => { ({proxy, dataDir} = loadProxy({MCP_OAUTH_PIN: PIN})); base = await listen(proxy.server); });
after(async () => { await close(proxy.server); fs.rmSync(dataDir, {recursive:true,force:true}); });
for (const endpoint of ['/register', '/token']) {
  for (const body of ['null', '[]', '1', 'true', '"text"', '{"code_verifier":{}}']) {
    it(`${endpoint} rejects ${body} and remains healthy`, async () => {
      const res = await fetch(base+endpoint, {method:'POST',headers:{'Content-Type':'application/json'},body});
      assert.equal(res.status,400);
      assert.equal((await fetch(base+'/healthz')).status,200);
    });
  }
}
it('rejects unregistered callbacks and prototype client IDs', async () => {
  const {body:client} = await register(base);
  for (const params of [{client_id:client.client_id,redirect_uri:'https://other.test/cb'}, {client_id:'constructor'}, {client_id:'__proto__'}]) {
    const res = await fetch(authorizeUrl(base,{code_challenge:pkcePair().challenge,...params}));
    assert.equal(res.status,400);
  }
});
it('requires client and redirect bindings during code exchange', async () => {
  for (const omitted of ['client_id','redirect_uri']) {
    const {body:client}=await register(base); const {verifier,challenge}=pkcePair();
    const {authId}=await startAuthorization(base,client.client_id,challenge);
    const response=await submitConsent(base,authId,PIN);
    const code=new URL(response.headers.get('location')).searchParams.get('code');
    const params={grant_type:'authorization_code',client_id:client.client_id,redirect_uri:REDIRECT,code,code_verifier:verifier};
    delete params[omitted]; assert.equal((await postToken(base,params)).status,400);
  }
});
it('rejects foreign or missing refresh client without consuming the token', async () => {
  const {client,tokens}=await fullAuthorization(base,PIN);
  for (const client_id of ['', 'other-client']) assert.equal((await postToken(base,{grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id})).status,400);
  assert.equal((await postToken(base,{grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:client.client_id})).status,200);
});
it('requires numeric expiry and exact issuer/audience', () => {
  const claims={iss:'https://titian.test',aud:'https://titian.test/mcp',exp:Date.now()/1000+60};
  for (const change of [{exp:'forever'},{exp:null},{iss:'https://other.test'},{aud:'https://other.test/mcp'}]) assert.equal(proxy.verifyJWT(proxy.signJWT({...claims,...change})),null);
});
it('preserves registered callback query parameters', async () => {
  const redirect_uri='https://client.test/callback?existing=1';
  const {body:client}=await register(base,{redirect_uris:[redirect_uri]});
  const res=await fetch(authorizeUrl(base,{client_id:client.client_id,redirect_uri,code_challenge:pkcePair().challenge}));
  const authId=(await res.text()).match(/name="auth_id" value="([0-9a-f]+)"/)[1];
  const approved=await submitConsent(base,authId,PIN);
  const url=new URL(approved.headers.get('location'));
  assert.equal(url.searchParams.get('existing'),'1');assert.ok(url.searchParams.get('code'));
});
