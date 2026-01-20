import express, { Request, Response } from 'express';
import { setupOAuth, createAuthMiddleware } from 'mcp-oauth-password';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import { createMcpServer } from './mcp-server.js';

// Validate required environment variables
const requiredEnvVars = [
  'SERVER_URL',
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET',
  'OAUTH_PASSWORD_HASH',
  'SESSION_SECRET',
  'API_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const app = express();

// Parse JSON request bodies
app.use(express.json());

// OAuth configuration
const oauthConfig = {
  serverUrl: process.env.SERVER_URL!,
  database: process.env.DATABASE_URL!,
  clientId: process.env.OAUTH_CLIENT_ID!,
  clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  passwordHash: process.env.OAUTH_PASSWORD_HASH!,
  sessionSecret: process.env.SESSION_SECRET!,
  apiKey: process.env.API_KEY!,
  sessionMaxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
  allowedRedirectPrefixes: [
    'https://claude.ai',
    'https://claude.com'
  ]
};

// Setup OAuth endpoints and session handling
const { pool } = setupOAuth(app, oauthConfig);

// Configure EJS view engine for OAuth login page
app.set('view engine', 'ejs');
app.set('views', './node_modules/mcp-oauth-password/views');

// Create auth middleware to protect MCP endpoint
const authMiddleware = createAuthMiddleware(oauthConfig);

// Session storage for MCP connections
const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'vault-mcp',
    version: '1.0.0'
  });
});

// POST /mcp - Handle MCP JSON-RPC requests
app.post('/mcp', authMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const isInitialize = req.body?.method === 'initialize';

  // Existing session
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling request:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
    return;
  }

  // New session on initialize
  if (isInitialize && !sessionId) {
    const newSessionId = randomUUID();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (sid) => {
        console.log(`MCP session initialized: ${sid}`);
      },
    });

    const server = createMcpServer();

    // Connect server to transport
    await server.connect(transport);

    // Store session
    sessions.set(newSessionId, { server, transport });

    try {
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling initialize:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
    return;
  }

  res.status(400).json({ error: 'Invalid or missing session' });
});

// GET /mcp - SSE stream
app.get('/mcp', authMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const session = sessions.get(sessionId)!;
  try {
    await session.transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling SSE:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// DELETE /mcp - Terminate session
app.delete('/mcp', authMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    await session.server.close();
    sessions.delete(sessionId);
    console.log(`MCP session terminated: ${sessionId}`);
  }

  res.status(200).send();
});

// Start server
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`vault-mcp listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
  console.log(`OAuth endpoints ready at ${process.env.SERVER_URL}`);
});

// Export for testing
export { app, pool };
