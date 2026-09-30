import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ECHO_SCHEMA } from './fixtures/echo-schema.mjs';

const BRIDGE = fileURLToPath(new URL('../../src/bridge/server.mjs', import.meta.url));
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
    env: { ...process.env, MCP_AUTH_TOKEN: 'bridge-test-token', MCP_PERMISSION_POLICY: JSON.stringify({version: 2, preset: 'unrestricted', rules: {}}), MCP_BRIDGE_PORT: String(port), MCP_STDIO_COMMAND: process.execPath, MCP_STDIO_WRAPPER: FAKE_SERVER, MCP_PROJECT_SLUG: 'test-project', MCP_PROJECT_ROOTS: JSON.stringify(['/tmp/project-root']), MCP_PROJECT_CAPABILITIES: JSON.stringify(['mobile', 'test']) },
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
    headers: { authorization: 'Bearer bridge-test-token', 'content-type': 'application/json', accept: ACCEPT, ...headers },
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

async function initializeRawClient() {
  const res = await rpc(initialize);
  assert.equal(res.status, 200);
  const body = await readRpc(res);
  assert.equal(res.headers.get('mcp-session-id'), null);
  const notified = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notified.status, 202);
  return body;
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
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: 'Bearer bridge-test-token' } } }));
  });
  after(() => client.close());

  it('lists tools with their raw input schemas', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['get_usage_stats', 'get_config', 'titian_project_info', 'titian_permissions', 'titian_resume']);
    const echo = tools.find((t) => t.name === 'get_usage_stats');
    assert.deepEqual(echo.inputSchema, ECHO_SCHEMA);
  });

  it('forwards tool calls', async () => {
    const res = await client.callTool({ name: 'get_usage_stats', arguments: { text: 'hi' } });
    assert.deepEqual(res.content, [{ type: 'text', text: 'echo: hi' }]);
    assert.equal(res.isError, false);
  });

  it('preserves isError from the stdio server', async () => {
    const res = await client.callTool({ name: 'get_config', arguments: {} });
    assert.equal(res.isError, true);
  });

  it('forwards resources', async () => {
    const { resources } = await client.listResources();
    assert.equal(resources[0].uri, 'mem://hello');
    const { contents } = await client.readResource({ uri: 'mem://hello' });
    assert.equal(contents[0].text, 'hello world');
  });

  it('exposes consistent project metadata through a tool and resource', async () => {
    const result = await client.callTool({ name: 'titian_project_info', arguments: {} });
    const expected = { project: 'test-project', roots: ['/tmp/project-root'], capabilities: ['mobile', 'test'] };
    assert.deepEqual(result.structuredContent, expected);
    assert.deepEqual(JSON.parse(result.content[0].text), expected);
    const { resources } = await client.listResources();
    assert.ok(resources.some(resource => resource.uri === 'titian://project/metadata'));
    const { contents } = await client.readResource({ uri: 'titian://project/metadata' });
    assert.deepEqual(JSON.parse(contents[0].text), expected);
  });

  it('forwards prompts', async () => {
    const { prompts } = await client.listPrompts();
    assert.equal(prompts[0].name, 'greet');
    const { messages } = await client.getPrompt({ name: 'greet', arguments: { who: 'titian' } });
    assert.equal(messages[0].content.text, 'Hello, titian!');
  });
});

describe('stateless transport handling', () => {
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

  it('initializes without issuing an HTTP session id', async () => {
    const body = await initializeRawClient();
    assert.equal(body.id, 1);
    assert.ok(body.result);
  });

  it('accepts tools/list without a session header', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 42, method: 'tools/list' });
    assert.equal(res.status, 200);
    const body = await readRpc(res);
    assert.equal(body.id, 42);
    assert.equal(body.result.tools.length, 5);
  });

  it('accepts tools/call without a session header', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'get_usage_stats', arguments: { text: 'sessionless' } } });
    assert.equal(res.status, 200);
    const body = await readRpc(res);
    assert.deepEqual(body.result.content, [{ type: 'text', text: 'echo: sessionless' }]);
  });

  it('ignores a stale session header instead of rejecting the request', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 44, method: 'tools/list' }, { 'mcp-session-id': 'stale-after-restart' });
    assert.equal(res.status, 200);
    assert.equal((await readRpc(res)).result.tools.length, 5);
  });

  it('returns 405 for GET and DELETE because stateless mode has no session stream', async () => {
    assert.equal((await fetch(`${base}/mcp`, { headers: { accept: 'text/event-stream' } })).status, 405);
    assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE' })).status, 405);
  });

  it('ignores an unsupported MCP-Protocol-Version transport header', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 45, method: 'tools/list' }, { 'mcp-protocol-version': '2099-01-01' });
    assert.equal(res.status, 200);
    assert.equal((await readRpc(res)).result.tools.length, 5);
  });

  it('handles concurrent sessionless requests independently', async () => {
    const calls = ['a', 'b'].map((text) => rpc({
      jsonrpc: '2.0', id: text, method: 'tools/call', params: { name: 'get_usage_stats', arguments: { text } },
    }));
    const responses = await Promise.all(calls);
    const bodies = await Promise.all(responses.map(readRpc));
    assert.deepEqual(bodies.map((body) => body.result.content[0].text).sort(), ['echo: a', 'echo: b']);
  });
});
