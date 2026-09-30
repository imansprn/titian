// Records dispatch and performs only fixture file writes. NEVER runs commands.
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'permission-fixture', version: '1' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
const names = ['read_file', 'write_file', 'edit_block', 'create_directory', 'start_process', 'interact_with_process', 'read_process_output', 'kill_process', 'force_terminate', 'start_search', 'get_more_search_results', 'set_config_value', 'unknown_future_tool'];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: names.map(name => ({ name, inputSchema: { type: 'object' } })) }));
server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params;
  fs.appendFileSync(process.env.TEST_CALL_LOG, JSON.stringify({ name, args }) + '\n');
  if (name === 'read_file') return { content: [{ type: 'text', text: fs.readFileSync(args.path, 'utf8') }] };
  if (name === 'write_file') fs.writeFileSync(args.path, args.content);
  if (name === 'start_process' && args.command === 'backend-denied') return { content: [{ type: 'text', text: 'Blocked by Desktop Commander' }], isError: true };
  if (name === 'start_process') return { content: [{ type: 'text', text: 'Process started with PID 34567 (fixture; no command executed)' }] };
  if (name === 'start_search') return { content: [{ type: 'text', text: 'Started content search session: search_fixture' }] };
  return { content: [{ type: 'text', text: 'fixture response' }] };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'file:///private', name: 'private fixture' }] }));
server.setRequestHandler(ReadResourceRequestSchema, async req => {
  fs.appendFileSync(process.env.TEST_CALL_LOG, JSON.stringify({ resource: req.params.uri }) + '\n');
  return { contents: [{ uri: req.params.uri, text: 'private fixture' }] };
});
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
await server.connect(new StdioServerTransport());
