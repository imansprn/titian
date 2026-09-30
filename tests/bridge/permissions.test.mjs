import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const BRIDGE = fileURLToPath(new URL('../../src/bridge/server.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/permission-stdio-server.mjs', import.meta.url));
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function start(t, preset = 'custom', rules = { 'files.read': 'allow', 'files.write': 'allow', 'process.start': 'ask', 'process.input': 'ask', 'process.read': 'allow', search: 'allow' }) {
  // Short paths also exercise the macOS Unix-socket length limit correctly.
  const dir = fs.mkdtempSync('/tmp/tp-');
  const root = fs.realpathSync(fs.mkdirSync(path.join(dir, 'work'), { recursive: true }));
  const state = path.join(dir, 'state'); fs.mkdirSync(state, { mode: 0o700 });
  const log = path.join(dir, 'calls.jsonl'); fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(root, 'readme.txt'), 'hello');
  const port = await freePort();
  const child = spawn(process.execPath, [BRIDGE], { env: { ...process.env,
    MCP_BRIDGE_PORT: String(port), MCP_STDIO_COMMAND: process.execPath, MCP_STDIO_WRAPPER: FIXTURE,
    MCP_PROJECT_SLUG: 'demo', MCP_PROJECT_ROOT: root, MCP_PROJECT_ROOTS: JSON.stringify([root]),
    MCP_DC_CONFIG_DIR: state, MCP_PROTECTED_PATHS: JSON.stringify([state]),
    MCP_PERMISSION_POLICY: JSON.stringify({ version: 2, preset, rules }),
    MCP_OAUTH_SIGNING_KEY: 'fixture-signing-key', MCP_PUBLIC_BASE: 'https://fixture.test/demo', TEST_CALL_LOG: log,
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', c => { stderr += c; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 15000;
  while (!stderr.includes('listening on')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(stderr);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  function token(principal) {
    const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: principal, iss: 'https://fixture.test/demo', aud: 'https://fixture.test/demo/mcp', exp: Date.now() / 1000 + 120 })).toString('base64url');
    return `${header}.${payload}.` + crypto.createHmac('sha256', 'fixture-signing-key').update(`${header}.${payload}`).digest('base64url');
  }
  async function rpc(method, params, principal = 'a', extraHeaders = {}) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(principal ? { authorization: 'Bearer ' + token(principal) } : {}), ...extraHeaders }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = await res.text();
    return JSON.parse(body.split('\n').find(line => line.startsWith('data: '))?.slice(6) || body);
  }
  async function call(name, args = {}, principal = 'a') { return (await rpc('tools/call', { name, arguments: args }, principal)).result; }
  async function owner(message) {
    const socket = net.createConnection(path.join(state, 'owner.sock')); socket.setEncoding('utf8');
    await once(socket, 'connect'); socket.write(JSON.stringify(message) + '\n');
    let data = ''; for await (const chunk of socket) data += chunk;
    const result = JSON.parse(data); if (result.error) throw new Error(result.error); return result.result;
  }
  const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  async function approve(id) {
    const preview = await owner({ action: 'show', requestId: id });
    return owner({ action: 'approve', requestId: id, requestHash: preview.requestHash });
  }
  return { root, state, call, rpc, owner, approve, calls, port, stderr: () => stderr };
}

test('real bridge: owner approval does not dispatch; authenticated single-use resume does', async t => {
  const app = await start(t);
  const pending = await app.call('start_process', { command: 'printf approved', timeout_ms: 1000 });
  assert.equal(pending.isError, true); assert.equal(pending.structuredContent.status, 'approval_required');
  const id = pending.structuredContent.requestId;
  assert.deepEqual(app.calls(), []);
  assert.equal(fs.statSync(path.join(app.state, 'owner.sock')).mode & 0o777, 0o600);
  await assert.rejects(app.owner({ action: 'approve', requestId: id, requestHash: 'forged' }));
  await app.approve(id); assert.deepEqual(app.calls(), []);
  assert.equal((await app.call('titian_resume', { requestId: id }, 'b')).isError, true);
  const resumed = await Promise.all([app.call('titian_resume', { requestId: id }), app.call('titian_resume', { requestId: id })]);
  assert.equal(resumed.filter(result => !result.isError).length, 1);
  assert.equal(app.calls().length, 1); assert.equal(app.calls()[0].args.command, 'printf approved');
  const effective = await app.call('titian_permissions');
  assert.equal(effective.structuredContent.policy.preset, 'custom');
  assert.equal(effective.structuredContent.sandboxed, false);
  assert.equal((await app.owner({ action: 'policy' })).revision, effective.structuredContent.revision);
  assert.equal(app.stderr().includes('printf approved'), false, 'audit must not log command contents');
});
test('real bridge: readonly denial never reaches executor or changes fixture files', async t => {
  const app = await start(t, 'readonly', {});
  const file = path.join(app.root, 'blocked.txt');
  for (const [name, args] of [['start_process', { command: 'git branch -D example' }], ['write_file', { path: file, content: 'blocked' }], ['edit_block', { file_path: path.join(app.root, 'readme.txt'), old_string: 'hello', new_string: 'changed' }], ['read_file', { path: 'https://example.test', isUrl: true }]]) {
    const result = await app.call(name, args); assert.equal(result.structuredContent.status, 'denied');
  }
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(app.root, 'readme.txt'), 'utf8'), 'hello');
  assert.deepEqual(app.calls(), []);
  const resource = await app.rpc('resources/read', { uri: 'file:///private' }); assert.ok(resource.error);
  assert.deepEqual(app.calls(), []);
  const allowed = await app.call('read_file', { path: path.join(app.root, 'readme.txt') });
  assert.equal(allowed.content[0].text, 'hello'); assert.equal(app.calls().length, 1);
});
test('real bridge: forged caller approvals, identity headers, and management tool calls fail', async t => {
  const app = await start(t);
  assert.equal((await app.call('start_process', { command: 'test', approved: true })).structuredContent.status, 'denied');
  const spoof = await app.rpc('tools/call', { name: 'write_file', arguments: { path: path.join(app.root, 'spoof'), content: 'x' } }, null, { 'x-titian-principal': 'a' });
  assert.equal(spoof.result.structuredContent.status, 'authentication_required');
  for (const name of ['set_config_value', 'titian_approve', 'unknown_future_tool']) {
    const result = await app.rpc('tools/call', { name, arguments: { approved: true } });
    assert.ok(result.error || result.result?.isError);
  }
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/owner`)).status, 404);
  assert.deepEqual(app.calls(), []);
});
test('real bridge: separate approval for interactive input and no access to another client process', async t => {
  const app = await start(t);
  const pendingStart = await app.call('start_process', { command: 'interactive fixture' });
  await app.approve(pendingStart.structuredContent.requestId); await app.call('titian_resume', { requestId: pendingStart.structuredContent.requestId });
  const initial = app.calls().length;
  const other = await app.call('interact_with_process', { pid: 34567, input: 'another command' }, 'b');
  assert.equal(other.structuredContent.status, 'denied');
  const input = await app.call('interact_with_process', { pid: 34567, input: 'another command' });
  assert.equal(input.structuredContent.status, 'approval_required'); assert.equal(app.calls().length, initial);
  await app.approve(input.structuredContent.requestId);
  await app.call('titian_resume', { requestId: input.structuredContent.requestId });
  assert.equal(app.calls().length, initial + 1);
});
test('real bridge: Desktop Commander rejection stays rejected after Titian approval', async t => {
  const app = await start(t);
  const pending = await app.call('start_process', { command: 'backend-denied' }); const id = pending.structuredContent.requestId;
  await app.approve(id); const result = await app.call('titian_resume', { requestId: id });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /Blocked by Desktop Commander/);
  await app.call('titian_resume', { requestId: id }); assert.equal(app.calls().length, 1);
});
