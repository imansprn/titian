'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
function projectBySlug(slug) {
  // The manager atomically replaces this small registry. Read on lookup so
  // add/remove takes effect without restarting or dropping other sessions.
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'projects.json'), 'utf8')).find(p => p.slug === slug && p.enabled !== false);
}
function route(pathname) {
  const scoped = pathname.match(/^\/projects\/([^/]+)(\/.*)?$/);
  if (scoped) {
    const project = projectBySlug(scoped[1]);
    return project ? { port: project.authPort, path: scoped[2] || '/' } : null;
  }
  const metadata = pathname.match(/^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)\/projects\/([^/]+)(\/mcp)?$/);
  if (metadata) {
    const project = projectBySlug(metadata[2]);
    return project ? { port: project.authPort, path: '/.well-known/' + metadata[1] } : null;
  }
  // Preserve the original Gobliggg connection and its OAuth issuer.
  return { port: 8000, path: pathname };
}
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400).end('Invalid URL'); return; }
  if (url.pathname === '/healthz' || url.pathname === '/health') {
    res.writeHead(200, {'Content-Type': 'text/plain'}).end('ok'); return;
  }
  let target;
  try { target = route(url.pathname); }
  catch { res.writeHead(503).end('Project registry unavailable'); return; }
  if (!target) { res.writeHead(404).end('Unknown project'); return; }
  const upstream = http.request({agent:false,hostname:'127.0.0.1',port:target.port,path:target.path+url.search,method:req.method,headers:{...req.headers,host:`127.0.0.1:${target.port}`}}, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) res.destroy();
    else res.writeHead(502, {'Content-Type':'application/json'}).end(JSON.stringify({error:'upstream_unavailable'}));
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
});
server.on('clientError', (error, socket) => { console.error('clientError', error.code, error.message); socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
server.requestTimeout = 0;
server.listen(Number(process.env.MCP_GATEWAY_PORT || 8300), '127.0.0.1', () => console.error('Project MCP gateway listening on 127.0.0.1:8300'));
