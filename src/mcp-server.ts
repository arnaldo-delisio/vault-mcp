import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { searchToolsTool } from './tools/tool-search.js';

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

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'vault_search_tools',
      description: 'Search available vault tools by intent or keyword to find the right tool for your task. Returns top 3-5 most relevant tools with descriptions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'User\'s intent or keywords (e.g., "capture content", "add note", "search vault")'
          }
        },
        required: ['query']
      }
    }
  ]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'vault_search_tools') {
    const result = await searchToolsTool(args as { query: string });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

export { server };
