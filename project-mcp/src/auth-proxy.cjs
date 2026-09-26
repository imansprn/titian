#!/usr/bin/env node
'use strict';
// Share validation with the main proxy. This relative path also works in runtime/.
const proxy = require('../../mcp-auth-proxy.js');
if (require.main === module) {
  proxy.server.listen(Number(process.env.MCP_PROXY_PORT || 8000), process.env.MCP_PROXY_HOST || '127.0.0.1');
}
module.exports = proxy;
