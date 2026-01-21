import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { searchToolsTool } from './tools/tool-search.js';
import { extractContentTool, extractContentToolDef } from './tools/extract-content.js';
import { saveLearningTool, saveLearningToolDef } from './tools/save-learning.js';
import { addNoteTool, addNoteToolDef } from './tools/notes.js';
import { searchNotesTool } from './tools/search.js';
import { readNoteTool } from './tools/read.js';
import { workflowInstructionsResource, getWorkflowInstructions } from './resources/workflow-instructions.js';

// Factory function to create MCP server instances (one per session)
export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'vault-mcp',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {},
        resources: {}
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
    },
    extractContentToolDef,
    saveLearningToolDef,
    addNoteToolDef,
    {
      name: 'search_notes',
      description: 'Search vault content by keyword or phrase across all files.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (keyword or phrase)'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results (default: 10, max: 20)',
            default: 10
          }
        },
        required: ['query']
      }
    },
    {
      name: 'read_note',
      description: 'Read the full contents of a vault file by path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path (e.g., "learnings/2024-01-15-api-design.md")'
          }
        },
        required: ['path']
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

  if (name === 'extract_content') {
    const result = await extractContentTool(args as { url: string });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }

  if (name === 'save_learning') {
    const result = await saveLearningTool(args as { synthesis: string });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }

  if (name === 'add_note') {
    const result = await addNoteTool(args as any);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }

  if (name === 'search_notes') {
    const result = await searchNotesTool(args as { query: string; limit?: number });
    return {
      content: [
        {
          type: 'text',
          text: result
        }
      ]
    };
  }

  if (name === 'read_note') {
    const result = await readNoteTool(args as { path: string });
    return {
      content: [
        {
          type: 'text',
          text: result
        }
      ]
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: workflowInstructionsResource.uri,
      name: workflowInstructionsResource.name,
      mimeType: workflowInstructionsResource.mimeType,
      description: workflowInstructionsResource.description
    }
  ]
}));

// Read resource content
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === workflowInstructionsResource.uri) {
    return {
      contents: [
        {
          uri,
          mimeType: workflowInstructionsResource.mimeType,
          text: getWorkflowInstructions()
        }
      ]
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

  return server;
}
