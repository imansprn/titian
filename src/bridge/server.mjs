#!/usr/bin/env node
/**
 * mcp-http-bridge — stdio MCP → Streamable HTTP bridge.
 *
 * Drop-in replacement for supergateway. Uses the official MCP SDK
 * StreamableHTTPServerTransport in stateless mode, so every POST is independent
 * and bridge restarts cannot invalidate an in-memory Mcp-Session-Id.
 *
 * Implemented as a transport-level proxy with the low-level Server class:
 * every tools/call, resources/read, prompts/get is forwarded verbatim to the
 * stdio child (Desktop Commander) and the raw JSON schemas are passed through
 * untouched (no Zod re-encoding, which was the McpServer pitfall).
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const HOST = process.env.MCP_BRIDGE_HOST || '127.0.0.1';
const PORT = parseInt(process.env.MCP_BRIDGE_PORT || '8001', 10);
const STDIO_COMMAND = process.env.MCP_STDIO_COMMAND || process.execPath;
const STDIO_WRAPPER = process.env.MCP_STDIO_WRAPPER || fileURLToPath(new URL('./stdio.cjs', import.meta.url));

const log = (...a) => console.error(`[mcp-http-bridge]`, ...a);

// ---------------------------------------------------------------------------
// 1. Connect to Desktop Commander over stdio (dc-wrapper runs npx in a detached
//    process group and reaps it on stdin EOF / SIGTERM).
// ---------------------------------------------------------------------------
let shuttingDown = false;
let httpServer;
let heartbeat;
let pendingProbe;

const stdioClient = new Client({ name: 'mcp-http-bridge', version: '1.0.0' });
const stdioTransport = new StdioClientTransport({
  command: STDIO_COMMAND,
  args: [STDIO_WRAPPER],
  stderr: 'inherit',
  env: { ...process.env },
  cwd: process.env.MCP_PROJECT_ROOT,
});
stdioClient.onclose = () => {
  if (!shuttingDown) {
    log('Desktop Commander disconnected; exiting so launchd can restart the bridge');
    void shutdown(1);
  }
};
await stdioClient.connect(stdioTransport);

async function backendHealthy() {
  if (shuttingDown) return false;
  if (!pendingProbe) {
    pendingProbe = stdioClient.ping({ timeout: 5000 })
      .then(() => true, error => { log('Desktop Commander probe failed:', error.message); return false; })
      .finally(() => { pendingProbe = undefined; });
  }
  return pendingProbe;
}
heartbeat = setInterval(async () => {
  if (!(await backendHealthy()) && !shuttingDown) void shutdown(1);
}, 30000);
heartbeat.unref();
log('connected to Desktop Commander over stdio');

// ---------------------------------------------------------------------------
// 2. Snapshot the catalog once at startup (raw schemas, passed through as-is).
// ---------------------------------------------------------------------------
let toolCatalog = [];
let resourceCatalog = [];
let promptCatalog = [];
try { toolCatalog = ((await stdioClient.listTools()).tools || []).filter(t => t.name !== 'set_config_value').map(t => ({...t, description: `[${process.env.MCP_SERVER_LABEL}; roots: ${process.env.MCP_PROJECT_ROOTS}] ${t.description || ''}`})); log(`loaded ${toolCatalog.length} tools`); }
catch (e) { log('listTools failed:', e.message); }
try { resourceCatalog = (await stdioClient.listResources()).resources || []; log(`loaded ${resourceCatalog.length} resources`); }
catch (e) { log('listResources failed:', e.message); }
try { promptCatalog = (await stdioClient.listPrompts()).prompts || []; log(`loaded ${promptCatalog.length} prompts`); }
catch (e) { log('listPrompts failed:', e.message); }

const projectMetadata = {
  project: process.env.MCP_PROJECT_SLUG || 'titian',
  roots: JSON.parse(process.env.MCP_PROJECT_ROOTS || '[]'),
  capabilities: JSON.parse(process.env.MCP_PROJECT_CAPABILITIES || '[]'),
};
for (const key of ['roots', 'capabilities']) {
  if (!Array.isArray(projectMetadata[key]) || projectMetadata[key].some(value => typeof value !== 'string')) {
    throw new Error(`Invalid project metadata: ${key} must be an array of strings`);
  }
}
const metadataUri = 'titian://project/metadata';
const metadataTool = {
  name: 'titian_project_info',
  description: 'Read this server’s configured project, filesystem roots, and descriptive capability labels. Labels are not permissions or executable commands.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
    type: 'object', properties: {
      project: { type: 'string' },
      roots: { type: 'array', items: { type: 'string' } },
      capabilities: { type: 'array', items: { type: 'string' } },
    }, required: ['project', 'roots', 'capabilities'], additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
toolCatalog = [...toolCatalog.filter(tool => tool.name !== metadataTool.name), metadataTool];
resourceCatalog = [...resourceCatalog.filter(resource => resource.uri !== metadataUri), {
  uri: metadataUri, name: 'Titian project metadata', mimeType: 'application/json',
  description: 'Project identity, configured roots, and descriptive capability labels.',
}];

// ---------------------------------------------------------------------------
// 3. Build a fresh low-level Server per HTTP request, proxying every request
//    verbatim to the long-lived stdio client.
//
// The HTTP side is deliberately stateless. Titian does not keep MCP client
// state in the bridge; Desktop Commander owns the long-lived project process.
// Avoiding HTTP sessions also means a bridge restart cannot strand clients with
// stale Mcp-Session-Id values.
// ---------------------------------------------------------------------------
function makeRequestServer() {
  const server = new Server(
    { name: process.env.MCP_PROJECT_SLUG || 'titian', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: `This server handles ${process.env.MCP_SERVER_LABEL}. Project roots: ${process.env.MCP_PROJECT_ROOTS}. Use absolute file paths. Run commands in the appropriate project root. Terminal access runs as the macOS user and is not sandboxed. Project metadata: ${JSON.stringify(projectMetadata)}` },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolCatalog }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === metadataTool.name) return { content: [{ type: 'text', text: JSON.stringify(projectMetadata) }], structuredContent: projectMetadata, isError: false };
    if (!toolCatalog.some(t => t.name === name)) throw new Error('Tool unavailable for project server');
    const result = await stdioClient.callTool({ name, arguments: args });
    return { ...result, isError: result.isError ?? false };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: resourceCatalog }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri === metadataUri) return { contents: [{ uri: metadataUri, mimeType: 'application/json', text: JSON.stringify(projectMetadata) }] };
    const result = await stdioClient.readResource({ uri: req.params.uri });
    return { contents: result.contents };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: promptCatalog }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const result = await stdioClient.getPrompt({ name: req.params.name, arguments: req.params.arguments });
    return { messages: result.messages };
  });

  return server;
}

// ---------------------------------------------------------------------------
// 4. Stateless HTTP routing.
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleStatelessPost(req, res, parsed, rawLength) {
  const srv = makeRequestServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  transport.onerror = (e) => log(`[transport onerror] ${e?.message}`);

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try { await transport.close(); } catch (_) {}
    try { await srv.close(); } catch (_) {}
  };
  res.once('close', () => { cleanup(); });

  await srv.connect(transport);
  log(`POST stateless bodyLen=${rawLength} method=${parsed?.method || 'UNKNOWN'} suppliedSession=${Boolean(req.headers['mcp-session-id'])}`);
  try {
    await transport.handleRequest(req, res, parsed);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

httpServer = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; }
  catch { res.writeHead(400).end(); return; }

  if (pathname === '/healthz' || pathname === '/health') {
    const healthy = await backendHealthy();
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'text/plain' }).end(healthy ? 'ok' : 'backend unavailable');
    if (!healthy && !shuttingDown) void shutdown(1);
    return;
  }
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body><h2>Desktop Commander MCP HTTP Bridge</h2><p>Endpoint is at <code>/mcp</code></p></body></html>');
    return;
  }
  if (pathname !== '/mcp') { res.writeHead(404).end(); return; }

  // SDK 1.30.0 predates the 2026 protocol version. Version negotiation still
  // happens in the initialize body, so strip a newer transport header before
  // handing the request to the SDK. @hono/node-server reads rawHeaders too.
  delete req.headers['mcp-protocol-version'];
  if (req.rawHeaders) {
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (req.rawHeaders[i].toLowerCase() === 'mcp-protocol-version') req.rawHeaders.splice(i, 2);
    }
  }

  if (req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : null; }
    catch { sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }); return; }

    // server/discover (2026 spec, SEP-2577) isn't supported by SDK 1.30.0;
    // method-not-found makes legacy-compatible clients fall back to initialize.
    if (parsed && parsed.method === 'server/discover') {
      log(`POST server/discover id=${parsed.id} -> method not found (client should fall back to initialize)`);
      sendJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32601, message: 'Method not found: server/discover' } });
      return;
    }

    try {
      await handleStatelessPost(req, res, parsed, raw.length);
    } catch (error) {
      log(`POST failed method=${parsed?.method || 'UNKNOWN'}: ${error?.stack || error}`);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: parsed?.id ?? null });
      else res.destroy();
    }
  } else if (req.method === 'GET' || req.method === 'DELETE') {
    // Stateless Streamable HTTP has no session stream to resume or terminate.
    res.writeHead(405, { Allow: 'POST' }).end();
  } else {
    res.writeHead(405, { Allow: 'POST' }).end();
  }
});

httpServer.listen(PORT, HOST, () => log(`listening on ${HOST}:${httpServer.address().port} (stateless HTTP)`));

// ---------------------------------------------------------------------------
// 5. Graceful shutdown.
// ---------------------------------------------------------------------------
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  log(`shutting down (exit ${exitCode})`);
  // Set the deadline before waiting for stdio cleanup; broken children may hang.
  setTimeout(() => process.exit(exitCode), 2000);
  try { await stdioClient.close(); } catch (_) {}
  if (httpServer?.listening) httpServer.close(() => process.exit(exitCode));
  else process.exit(exitCode);
}
process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(0); });
