#!/usr/bin/env node
/**
 * mcp-http-bridge — stdio MCP → Streamable HTTP bridge.
 *
 * Drop-in replacement for supergateway. Uses the official MCP SDK
 * StreamableHTTPServerTransport, which keys sessions by Mcp-Session-Id header
 * (in-memory) rather than by TCP connection — so sessions survive clients that
 * open a fresh connection per request (e.g. Claude Desktop).
 *
 * Implemented as a transport-level proxy with the low-level Server class:
 * every tools/call, resources/read, prompts/get is forwarded verbatim to the
 * stdio child (Desktop Commander) and the raw JSON schemas are passed through
 * untouched (no Zod re-encoding, which was the McpServer pitfall).
 */
import { randomUUID } from 'node:crypto';
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
const STDIO_WRAPPER = process.env.MCP_STDIO_WRAPPER || fileURLToPath(new URL('../dc-wrapper.js', import.meta.url));

const log = (...a) => console.error(`[mcp-http-bridge]`, ...a);

// ---------------------------------------------------------------------------
// 1. Connect to Desktop Commander over stdio (dc-wrapper runs npx in a detached
//    process group and reaps it on stdin EOF / SIGTERM).
// ---------------------------------------------------------------------------
const stdioClient = new Client({ name: 'mcp-http-bridge', version: '1.0.0' });
const stdioTransport = new StdioClientTransport({
  command: STDIO_COMMAND,
  args: [STDIO_WRAPPER],
  stderr: 'inherit',
  env: { ...process.env },
  cwd: process.env.MCP_PROJECT_ROOT,
});
await stdioClient.connect(stdioTransport);
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

// ---------------------------------------------------------------------------
// 3. Build a fresh low-level Server per HTTP session, proxying every request
//    verbatim to the stdio client.
// ---------------------------------------------------------------------------
function makeSessionServer() {
  const server = new Server(
    { name: process.env.MCP_PROJECT_SLUG, version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: `This server handles ${process.env.MCP_SERVER_LABEL}. Project roots: ${process.env.MCP_PROJECT_ROOTS}. Use absolute file paths. Run commands in the appropriate project root. Terminal access runs as the macOS user and is not sandboxed.` },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolCatalog }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (!toolCatalog.some(t => t.name === name)) throw new Error('Tool unavailable for project server');
    const result = await stdioClient.callTool({ name, arguments: args });
    return result;
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: resourceCatalog }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
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
// 4. Session registry + HTTP routing.
// ---------------------------------------------------------------------------
const sessions = new Map(); // sessionId -> { server, transport }

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const httpServer = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; }
  catch { res.writeHead(400).end(); return; }

  if (pathname === '/healthz' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body><h2>Desktop Commander MCP HTTP Bridge</h2><p>Endpoint is at <code>/mcp</code></p></body></html>');
    return;
  }
  if (pathname !== '/mcp') { res.writeHead(404).end(); return; }

  // Strip the MCP-Protocol-Version header. The SDK (1.30.0) only supports up to
  // 2025-11-25 and hard-rejects newer values (e.g. clients sending 2026-07-28)
  // on post-initialize requests. Version negotiation happens via the initialize
  // body, which the SDK handles gracefully — so dropping the header is safe and
  // future-proofs against any client protocol version.
  // NOTE: @hono/node-server builds the Web Request from `rawHeaders` (not the
  // parsed `headers` object), so both must be stripped.
  delete req.headers['mcp-protocol-version'];
  if (req.rawHeaders) {
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (req.rawHeaders[i].toLowerCase() === 'mcp-protocol-version') {
        req.rawHeaders.splice(i, 2);
      }
    }
  }

  const sessionId = Array.isArray(req.headers['mcp-session-id'])
    ? req.headers['mcp-session-id'][0]
    : req.headers['mcp-session-id'];

  if (req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : null; }
    catch { sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }); return; }

    // server/discover (2026 spec, SEP-2577) isn't supported by SDK 1.30.0; replying
    // method-not-found makes the client fall back to the classic initialize handshake.
    if (parsed && parsed.method === 'server/discover') {
      log(`POST server/discover id=${parsed.id} -> method not found (client should fall back to initialize)`);
      sendJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32601, message: 'Method not found: server/discover' } });
      return;
    }

    if (sessionId && sessions.has(sessionId)) {
      log(`POST existing session ${sessionId} bodyLen=${raw.length} parsed=${parsed ? parsed.method : 'NULL'}`);
      await sessions.get(sessionId).transport.handleRequest(req, res, parsed);
    } else if (!sessionId && parsed && parsed.method === 'initialize') {
      log(`POST initialize (new session)`);
      const srv = makeSessionServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { log(`onsessioninitialized sid=${sid}`); sessions.set(sid, { server: srv, transport }); },
        onsessionclosed: (sid) => { log(`onsessionclosed sid=${sid}`); sessions.delete(sid); },
      });
      await srv.connect(transport);
      transport.onerror = (e) => log(`[transport onerror] ${e?.message}`);
      await transport.handleRequest(req, res, parsed);
    } else {
      log(`POST REJECT: sessionId=${sessionId} inMap=${sessionId ? sessions.has(sessionId) : false} method=${parsed?.method}`);
      // Echo the request id so the client can correlate this error and re-initialize.
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing session' }, id: parsed?.id ?? null });
    }
  } else if (req.method === 'GET') {
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId).transport.handleRequest(req, res);
    } else {
      res.writeHead(400).end('No valid session');
    }
  } else if (req.method === 'DELETE') {
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId).transport.handleRequest(req, res);
    } else {
      res.writeHead(400).end('No valid session');
    }
  } else {
    res.writeHead(405).end();
  }
});

httpServer.listen(PORT, HOST, () => log(`listening on ${HOST}:${PORT}`));

// ---------------------------------------------------------------------------
// 5. Graceful shutdown.
// ---------------------------------------------------------------------------
async function shutdown() {
  log('shutting down');
  try { await stdioClient.close(); } catch (_) {}
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
