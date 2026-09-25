import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ECHO_SCHEMA } from './fixtures/echo-schema.mjs';

const BRIDGE = fileURLToPath(new URL('../bridge.js', import.meta.url));
const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-stdio-server.mjs', import.meta.url));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let bridge, base;

before(async () => {
  const port = await freePort();
  bridge = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, MCP_BRIDGE_PORT: String(port), MCP_STDIO_COMMAND: process.execPath, MCP_STDIO_WRAPPER: FAKE_SERVER },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  bridge.stderr.on('data', (c) => { stderr += c; });
  const deadline = Date.now() + 15000;
  while (!stderr.includes('listening on')) {
    if (bridge.exitCode !== null || Date.now() > deadline) throw new Error(`bridge failed to start:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (bridge.exitCode === null) {
    bridge.kill('SIGTERM');
    await once(bridge, 'exit');
  }
});

const ACCEPT = 'application/json, text/event-stream';
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };

function rpc(body, headers = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// Responses may be plain JSON or a single SSE event.
async function readRpc(res) {
  const text = await res.text();
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) return JSON.parse(text);
  const data = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(data.slice(6));
}

async function openRawSession() {
  const res = await rpc(initialize);
  assert.equal(res.status, 200);
  await readRpc(res);
  const sessionId = res.headers.get('mcp-session-id');
  assert.ok(sessionId);
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sessionId });
  return sessionId;
}

describe('plain HTTP routes', () => {
  it('answers health checks', async () => {
    assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
  });
  it('serves an info page at /', async () => {
    assert.match(await (await fetch(base)).text(), /\/mcp/);
  });
  it('returns 404 for unknown paths', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
  it('returns 405 for unsupported methods on /mcp', async () => {
    assert.equal((await fetch(`${base}/mcp`, { method: 'PUT' })).status, 405);
  });
});

describe('MCP proxying through the SDK client', () => {
  let client;
  before(async () => {
    client = new Client({ name: 'bridge-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  });
  after(() => client.close());

  it('lists tools with their raw input schemas', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['echo', 'fail']);
    const echo = tools.find((t) => t.name === 'echo');
    assert.deepEqual(echo.inputSchema, ECHO_SCHEMA);
  });

  it('forwards tool calls', async () => {
    const res = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    assert.deepEqual(res.content, [{ type: 'text', text: 'echo: hi' }]);
    assert.equal(res.isError, false);
  });

  it('preserves isError from the stdio server', async () => {
    const res = await client.callTool({ name: 'fail', arguments: {} });
    assert.equal(res.isError, true);
  });

  it('forwards resources', async () => {
    const { resources } = await client.listResources();
    assert.equal(resources[0].uri, 'mem://hello');
    const { contents } = await client.readResource({ uri: 'mem://hello' });
    assert.equal(contents[0].text, 'hello world');
  });

  it('forwards prompts', async () => {
    const { prompts } = await client.listPrompts();
    assert.equal(prompts[0].name, 'greet');
    const { messages } = await client.getPrompt({ name: 'greet', arguments: { who: 'titian' } });
    assert.equal(messages[0].content.text, 'Hello, titian!');
  });
});

describe('session handling', () => {
  it('replies method-not-found to server/discover so clients fall back to initialize', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 7, method: 'server/discover' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 7);
    assert.equal(body.error.code, -32601);
  });

  it('returns a parse error for invalid JSON', async () => {
    const res = await rpc('{not json');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32700);
  });

  it('rejects non-initialize requests without a session and echoes the id', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 42, method: 'tools/list' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.id, 42);
    assert.equal(body.error.code, -32000);
  });

  it('rejects an unknown session id', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-session-id': 'does-not-exist' });
    assert.equal(res.status, 400);
  });

  it('rejects GET and DELETE without a session', async () => {
    assert.equal((await fetch(`${base}/mcp`, { headers: { accept: 'text/event-stream' } })).status, 400);
    assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE' })).status, 400);
  });

  it('ignores an unsupported MCP-Protocol-Version header', async () => {
    const sessionId = await openRawSession();
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2099-01-01' });
    assert.equal(res.status, 200);
    assert.equal((await readRpc(res)).result.tools.length, 2);
  });

  it('closes a session on DELETE', async () => {
    const sessionId = await openRawSession();
    const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } });
    assert.equal(del.status, 200);
    const after = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'mcp-session-id': sessionId });
    assert.equal(after.status, 400);
  });
});
