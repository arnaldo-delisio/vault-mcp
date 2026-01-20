import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

// Create MCP server instance
const server = new Server(
  {
    name: 'vault-mcp',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// List available tools (empty initially, tools added in subsequent plans)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: []
}));

// Handle tool calls (no tools yet, handlers added in subsequent plans)
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  throw new Error(`Unknown tool: ${name}`);
});

export { server };
