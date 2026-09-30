// Opt-in integration with the pinned Desktop Commander. All state is temporary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const REPO = fileURLToPath(new URL('../', import.meta.url));
const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

test('pinned runtime: scoped reads, no-write denial, approve/resume, input ownership and backend blocks', { timeout: 90000 }, async t => {
  const directory = fs.mkdtempSync('/tmp/tpr-');
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const built = spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import runtime; print(runtime.build())', path.join(REPO, 'src/manager')], {
    env: { ...process.env, TITIAN_DATA_DIR: directory, MCP_NODE_BIN: process.execPath }, encoding: 'utf8', timeout: 45000,
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const runtime = built.stdout.trim().split('\n').at(-1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, 'build.json'), 'utf8')).permissionVersion, 2);

  async function start(preset, rules = {}) {
    const parent = path.join(directory, preset); fs.mkdirSync(parent);
    const root = path.join(parent, 'work'); fs.mkdirSync(root);
    const state = path.join(parent, 'state'); fs.mkdirSync(state, { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'readme.txt'), 'permission smoke fixture');
    const config = { allowedDirectories: [fs.realpathSync(root)], blockedCommands: ['whoami'], defaultShell: '/bin/sh', telemetryEnabled: false, pendingWelcomeOnboarding: false, welcomeOnboardingEligible: false };
    fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const child = spawn(process.execPath, [path.join(runtime, 'bridge/server.mjs')], { env: { ...process.env,
      MCP_PROJECT_SLUG: 'smoke', MCP_SERVER_LABEL: 'Temporary smoke test', MCP_PROJECT_ROOT: root,
      MCP_PROJECT_ROOTS: JSON.stringify([root]), MCP_PROJECT_CAPABILITIES: '[]', MCP_DC_CONFIG_DIR: state,
      MCP_PROTECTED_PATHS: JSON.stringify([state]), MCP_PERMISSION_POLICY: JSON.stringify({ version: 2, preset, rules }),
      MCP_STDIO_COMMAND: process.execPath, MCP_STDIO_WRAPPER: path.join(runtime, 'bridge/stdio.cjs'),
      DESKTOP_COMMANDER_BIN: path.join(runtime, 'dc/dist/index.js'), MCP_BRIDGE_PORT: String(port),
      MCP_AUTH_TOKEN: 'temporary-smoke-token', MCP_PUBLIC_BASE: 'https://smoke.invalid',
    }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    children.push(child);
    const deadline = Date.now() + 20000;
    while (!stderr.includes('listening on')) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(stderr);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    async function call(name, args = {}) {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer temporary-smoke-token',
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(20000) });
      const body = await response.text();
      const data = JSON.parse(body.split('\n').find(line => line.startsWith('data: '))?.slice(6) || body);
      assert.ok(data.result, body); return data.result;
    }
    async function owner(message) {
      const socket = net.createConnection(path.join(state, 'owner.sock')); socket.setEncoding('utf8');
      await once(socket, 'connect'); socket.write(JSON.stringify(message) + '\n');
      let body = ''; for await (const chunk of socket) body += chunk;
      const data = JSON.parse(body); assert.ok(!data.error, body); return data.result;
    }
    async function approve(result) {
      assert.equal(result.structuredContent.status, 'approval_required');
      const id = result.structuredContent.requestId;
      const preview = await owner({ action: 'show', requestId: id });
      await owner({ action: 'approve', requestId: id, requestHash: preview.requestHash });
      return id;
    }
    return { root, state, call, owner, approve };
  }
  const readonly = await start('readonly');
  const read = await readonly.call('read_file', { path: path.join(readonly.root, 'readme.txt') });
  assert.equal(read.isError, false); assert.match(text(read), /permission smoke fixture/);
  const denied = await readonly.call('write_file', { path: path.join(readonly.root, 'denied.txt'), content: 'not authorized' });
  assert.equal(denied.structuredContent.status, 'denied'); assert.equal(fs.existsSync(path.join(readonly.root, 'denied.txt')), false);
  assert.equal((await readonly.call('start_process', { command: 'pwd', timeout_ms: 1000 })).structuredContent.status, 'denied');
  const search = await readonly.call('start_search', { path: readonly.root, pattern: 'permission', searchType: 'content' });
  const session = text(search).match(/search_\w+/)?.[0]; assert.ok(session, text(search));
  assert.equal((await readonly.call('get_more_search_results', { sessionId: session })).isError, false);

  const developer = await start('custom', { 'files.read': 'allow', 'files.write': 'allow', 'process.start': 'ask', 'process.input': 'ask', 'process.read': 'allow', 'process.stop': 'ask' });
  const marker = path.join(developer.root, 'approved.txt');
  const pending = await developer.call('start_process', { command: `printf approved > '${marker}'`, shell: '/bin/sh', timeout_ms: 1000 });
  assert.equal(fs.existsSync(marker), false);
  const id = await developer.approve(pending); assert.equal(fs.existsSync(marker), false);
  const executed = await developer.call('titian_resume', { requestId: id });
  assert.equal(executed.isError, false, text(executed));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'approved');
  assert.equal((await developer.call('titian_resume', { requestId: id })).isError, true);
  const shell = await developer.call('start_process', { command: 'cat', shell: '/bin/sh', timeout_ms: 100 });
  const shellId = await developer.approve(shell);
  const started = await developer.call('titian_resume', { requestId: shellId });
  const pid = Number(text(started).match(/Process started with PID (\d+)/)?.[1]); assert.ok(pid, text(started));
  const input = await developer.call('interact_with_process', { pid, input: 'owned-session-smoke\n', timeout_ms: 1000, wait_for_prompt: false });
  assert.equal(input.structuredContent.status, 'approval_required');
  const inputId = await developer.approve(input);
  assert.equal((await developer.call('titian_resume', { requestId: inputId })).isError, false);
  const output = await developer.call('read_process_output', { pid, timeout_ms: 1000 });
  assert.match(text(output), /owned-session-smoke/);
  const stopId = await developer.approve(await developer.call('force_terminate', { pid }));
  assert.equal((await developer.call('titian_resume', { requestId: stopId })).isError, false);
  const blockedId = await developer.approve(await developer.call('start_process', { command: 'whoami', shell: '/bin/sh', timeout_ms: 1000 }));
  const blocked = await developer.call('titian_resume', { requestId: blockedId });
  assert.equal(blocked.isError, true); assert.match(text(blocked), /not allowed/i);
  const effective = await developer.call('titian_permissions');
  assert.equal(effective.structuredContent.rules['process.start'], 'ask');
});
