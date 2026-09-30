const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Policy, validatePolicy } = require('../src/bridge/policy.cjs');
const { ApprovalGate } = require('../src/bridge/approvals.cjs');
const { authenticate } = require('../src/bridge/identity.cjs');
let temp, root, state;
beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'titian-policy-')));
  root = path.join(temp, 'work'); state = path.join(temp, 'private');
  fs.mkdirSync(root); fs.mkdirSync(state);
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));
function policy(preset = 'readonly', rules = {}) {
  return new Policy({ policy: { version: 2, preset, rules }, roots: [root], protectedPaths: [state], cwd: root, project: 'demo' });
}
function gate(rules = { 'process.start': 'ask' }, options = {}) {
  const calls = [];
  const p = policy('custom', rules);
  const g = new ApprovalGate(p, async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: 'Process started with PID 12345 (fake)' }] }; }, options);
  g.ownerAvailable = true;
  return { g, p, calls };
}
const command = { command: 'npm test', timeout_ms: 1000 };
async function request(g, name = 'start_process', args = command, principal = 'owner-a') {
  const result = await g.call(name, args, principal);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 'approval_required');
  return result.structuredContent.requestId;
}
function approve(g, id) { return g.ownerDecision(id, 'approve', g.view(id).requestHash); }

test('strict presets, operation names, and custom-only overrides', () => {
  for (const bad of [null, {}, { version: 2, preset: 'safe', rules: {} }, { version: 2, preset: 'readonly', rules: { 'process.start': 'allow' } }, { version: 2, preset: 'custom', rules: { shell: 'allow' } }, { version: 2, preset: 'custom', rules: { 'process.start': 'maybe' } }]) assert.throws(() => validatePolicy(bad));
  assert.equal(policy('custom').decision('process.start'), 'deny');
});
test('readonly blocks mutations and ALL shell commands before backend dispatch', async () => {
  let forwarded = 0;
  const g = new ApprovalGate(policy(), async () => { forwarded++; });
  for (const value of ['git status', 'git branch -D example', 'rg --pre ./processor needle .', 'git diff --output=review.patch', 'cmd.exe /k']) {
    const result = await g.call('start_process', { command: value }, 'owner');
    assert.equal(result.structuredContent.status, 'denied');
  }
  assert.equal((await g.call('write_file', { path: path.join(root, 'new.txt'), content: 'x' }, 'owner')).isError, true);
  assert.equal(forwarded, 0);
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
});
test('editor permits scoped edits, asks for moves, and denies execution', () => {
  const p = policy('editor');
  assert.equal(p.evaluate('write_file', { path: path.join(root, 'file.txt'), content: 'x' }, 'owner').decision, 'allow');
  assert.equal(p.evaluate('move_file', { source: path.join(root, 'a'), destination: path.join(root, 'b') }, 'owner').decision, 'ask');
  assert.equal(p.evaluate('start_process', command, 'owner').decision, 'deny');
  assert.equal(p.evaluate('write_file', { path: path.join(root, 'file.docx'), content: 'x' }, 'owner').decision, 'deny');
});
test('root, symlink, dangling symlink, hardlink and protected-state escapes fail closed', () => {
  const p = policy();
  const secret = path.join(state, 'secret'); fs.writeFileSync(secret, 'private');
  fs.symlinkSync(state, path.join(root, 'outside'));
  fs.symlinkSync(path.join(state, 'missing'), path.join(root, 'dangling'));
  fs.linkSync(secret, path.join(root, 'hardlink'));
  for (const file of [secret, path.join(root, 'outside/secret'), path.join(root, 'outside/new/deep/file'), path.join(root, 'dangling'), path.join(root, 'hardlink'), path.join(root, '../private/secret')]) {
    assert.equal(p.evaluate('read_file', { path: file }, 'owner').decision, 'deny', file);
  }
  assert.equal(p.evaluate('read_multiple_files', { paths: [path.join(root, 'a'), secret] }, 'owner').decision, 'deny');
  const overlapping = new Policy({ policy: p.config, roots: [temp], protectedPaths: [state] });
  assert.equal(overlapping.evaluate('start_search', { path: temp, pattern: 'secret', includeHidden: true }, 'owner').decision, 'deny');
});
test('URLs, nested read options, unknown tools, and caller-supplied approvals do not bypass policy', () => {
  const p = policy();
  assert.equal(p.evaluate('read_file', { path: 'https://example.test', isUrl: true }, 'owner').decision, 'deny');
  assert.equal(p.evaluate('read_file', { path: root, options: { isUrl: true } }, 'owner').decision, 'deny');
  for (const name of ['set_config_value', 'approve', 'new_unreviewed_tool']) assert.equal(p.evaluate(name, {}, 'owner').decision, 'deny');
  assert.equal(p.evaluate('read_file', { path: path.join(root, 'x'), approved: true }, 'owner').decision, 'deny');
  assert.equal(p.evaluate('read_file', { path: path.join(root, 'x') }, null).decision, 'deny');
});
test('ask does not execute; owner approval requires matching preview; resume executes once', async () => {
  const { g, calls } = gate(); const id = await request(g);
  assert.equal(calls.length, 0);
  assert.equal((await g.resume(id, 'owner-a')).isError, true);
  assert.throws(() => g.ownerDecision(id, 'approve', 'forged'));
  approve(g, id); assert.equal(calls.length, 0);
  assert.equal((await g.resume(id, 'owner-b')).isError, true);
  const result = await g.resume(id, 'owner-a');
  assert.equal(result.isError, false); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, command);
  assert.equal((await g.resume(id, 'owner-a')).isError, true);
  assert.equal(calls.length, 1);
});
test('concurrent resumes consume authorization atomically', async () => {
  const { g, calls } = gate(); const id = await request(g); approve(g, id);
  const results = await Promise.all([g.resume(id, 'owner-a'), g.resume(id, 'owner-a')]);
  assert.equal(calls.length, 1);
  assert.equal(results.filter(r => !r.isError).length, 1);
});
test('different arguments cannot reuse an approval and original arguments are immutable', async () => {
  const { g, calls } = gate(); const args = { ...command };
  const id = await request(g, 'start_process', args); args.command = 'changed'; approve(g, id);
  const other = await request(g, 'start_process', { ...command, command: 'other command' });
  assert.notEqual(id, other);
  await g.resume(id, 'owner-a'); assert.equal(calls[0].args.command, 'npm test');
});
test('hard deny never creates an approvable request', async () => {
  const { g, calls } = gate({ 'process.start': 'deny' });
  assert.equal((await g.call('start_process', command, 'owner-a')).structuredContent.status, 'denied');
  assert.deepEqual(g.list(), []); assert.equal(calls.length, 0);
  assert.throws(() => approve(g, 'unknown'));
});
test('expiry, rejection and unavailable owner endpoint never execute', async () => {
  let clock = 0; const { g, calls } = gate(undefined, { now: () => clock, ttl: 100 });
  const id = await request(g); approve(g, id); clock = 100;
  assert.equal((await g.resume(id, 'owner-a')).isError, true);
  const rejected = await request(g); g.ownerDecision(rejected, 'reject', g.view(rejected).requestHash);
  assert.equal((await g.resume(rejected, 'owner-a')).isError, true);
  g.ownerAvailable = false;
  assert.equal((await g.call('start_process', command, 'owner-a')).structuredContent.status, 'approval_unavailable');
  assert.equal(calls.length, 0);
});
test('file changes between approval and execution invalidate the request', async () => {
  const { g, calls } = gate({ 'files.write': 'ask' });
  const file = path.join(root, 'file.txt'); fs.writeFileSync(file, 'before');
  const id = await request(g, 'write_file', { path: file, content: 'approved' }); approve(g, id);
  fs.writeFileSync(file, 'changed by someone else');
  assert.equal((await g.resume(id, 'owner-a')).isError, true);
  assert.equal(calls.length, 0); assert.equal(fs.readFileSync(file, 'utf8'), 'changed by someone else');
});
test('backend refusals are preserved and do not restore a consumed approval', async () => {
  const { g } = gate(); let count = 0;
  g.execute = async () => { count++; return { content: [{ type: 'text', text: 'Blocked by Desktop Commander' }], isError: true }; };
  const id = await request(g); approve(g, id);
  assert.match((await g.resume(id, 'owner-a')).content[0].text, /Blocked by Desktop Commander/);
  await g.resume(id, 'owner-a'); assert.equal(count, 1);
});
test('interactive input and process control require ownership and their own permission', async () => {
  const { g, p } = gate({ 'process.start': 'allow', 'process.input': 'ask', 'process.read': 'allow', 'process.stop': 'ask' });
  await g.call('start_process', command, 'owner-a');
  for (const tool of ['interact_with_process', 'read_process_output', 'kill_process', 'force_terminate']) {
    assert.equal((await g.call(tool, { pid: 12345, input: 'next' }, 'owner-b')).structuredContent.status, 'denied');
  }
  const id = await request(g, 'interact_with_process', { pid: 12345, input: 'next' }); approve(g, id);
  p.record('start_process', command, { content: [{ type: 'text', text: 'Process started with PID 12345 (reused)' }] }, 'owner-a');
  assert.equal((await g.resume(id, 'owner-a')).isError, true);
});
test('search follow-up is bound to the requesting client', () => {
  const p = policy(); p.record('start_search', {}, { content: [{ type: 'text', text: 'Started content search session: search_42' }] }, 'a');
  assert.equal(p.evaluate('get_more_search_results', { sessionId: 'search_42' }, 'a').decision, 'allow');
  assert.equal(p.evaluate('get_more_search_results', { sessionId: 'search_42' }, 'b').decision, 'deny');
});
test('bounded approval queue rejects overflow and releases expired entries', async () => {
  let clock = 0; const { g } = gate(undefined, { limit: 1, ttl: 100, now: () => clock });
  await request(g);
  assert.equal((await g.call('start_process', { command: 'different' }, 'owner-a')).structuredContent.status, 'approval_queue_full');
  clock = 100; await request(g, 'start_process', { command: 'different' });
});
test('execution identity verifies signatures, expiry, issuer, audience, and ignores spoofed headers', () => {
  const env = { MCP_AUTH_TOKEN: 'static-secret', MCP_OAUTH_SIGNING_KEY: 'key', MCP_PUBLIC_BASE: 'https://host.test/project' };
  const req = token => ({ url: '/mcp', headers: { authorization: 'Bearer ' + token, 'x-titian-principal': 'forged' } });
  assert.match(authenticate(req('static-secret'), env), /^static:/);
  assert.equal(authenticate(req('wrong'), env), null);
  const sign = p => {
    const head = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(p)).toString('base64url');
    return head + '.' + body + '.' + crypto.createHmac('sha256', 'key').update(head + '.' + body).digest('base64url');
  };
  const payload = { sub: 'client-a', exp: Date.now() / 1000 + 60, iss: env.MCP_PUBLIC_BASE, aud: env.MCP_PUBLIC_BASE + '/mcp' };
  assert.equal(authenticate(req(sign(payload)), env), 'oauth:client-a');
  for (const change of [{ exp: 1 }, { iss: 'wrong' }, { aud: 'wrong' }, { sub: null }]) assert.equal(authenticate(req(sign({ ...payload, ...change })), env), null);
});

test('backend execution context changes invalidate pending approvals', async () => {
  const { g, p, calls } = gate();
  let shell = '/bin/sh'; p.executionContext = () => ({ shell });
  const id = await request(g); approve(g, id); shell = '/bin/zsh';
  assert.equal((await g.resume(id, 'owner-a')).isError, true); assert.equal(calls.length, 0);
});
test('raw PID kill is denied even with process.stop allowed', async () => {
  const { g } = gate({ 'process.start': 'allow', 'process.stop': 'allow' });
  await g.call('start_process', command, 'owner-a');
  assert.equal((await g.call('kill_process', { pid: 12345 }, 'owner-a')).structuredContent.status, 'denied');
  assert.equal((await g.call('force_terminate', { pid: 12345 }, 'owner-a')).isError, false);
});

test('virtual node sessions are tracked and input still requires its own approval', async () => {
  const { g, p } = gate({ 'process.input': 'ask', 'process.stop': 'allow' });
  p.record('start_process', { command: 'node:local' }, { content: [{ type: 'text', text: 'Node.js session started with PID -1000 (MCP server execution)' }] }, 'owner-a');
  const pending = await g.call('interact_with_process', { pid: -1000, input: 'console.log(1)' }, 'owner-a');
  assert.equal(pending.structuredContent.status, 'approval_required');
  assert.equal((await g.call('interact_with_process', { pid: -1000, input: 'console.log(1)' }, 'owner-b')).structuredContent.status, 'denied');
});
