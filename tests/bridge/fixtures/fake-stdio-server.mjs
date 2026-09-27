// Minimal stdio MCP server standing in for Desktop Commander in bridge tests.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ECHO_SCHEMA } from './echo-schema.mjs';

const server = new Server(
  { name: 'fake-desktop-commander', version: '0.0.1' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'Echo text back', inputSchema: ECHO_SCHEMA },
    { name: 'fail', description: 'Always fails', inputSchema: { type: 'object' } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'echo') return { content: [{ type: 'text', text: `echo: ${req.params.arguments.text}` }] };
  return { content: [{ type: 'text', text: 'boom' }], isError: true };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: 'mem://hello', name: 'hello', mimeType: 'text/plain' }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
  contents: [{ uri: req.params.uri, mimeType: 'text/plain', text: 'hello world' }],
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: 'greet', arguments: [{ name: 'who', required: true }] }],
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `Hello, ${req.params.arguments.who}!` } }],
}));

await server.connect(new StdioServerTransport());
