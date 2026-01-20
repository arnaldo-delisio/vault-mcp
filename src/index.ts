import express from 'express';
import { setupOAuth, createAuthMiddleware } from 'mcp-oauth-password';
import { server } from './mcp-server.js';

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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'vault-mcp',
    version: '1.0.0'
  });
});

// Protected MCP endpoint
app.post('/mcp', authMiddleware, async (req, res) => {
  try {
    const mcpRequest = req.body;

    // Process MCP request through server
    // For now, return a basic response - full handler added in future tasks
    res.json({
      jsonrpc: '2.0',
      id: mcpRequest.id,
      result: {
        content: [{ type: 'text', text: 'MCP server running' }]
      }
    });
  } catch (error) {
    console.error('MCP request error:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      id: req.body.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error'
      }
    });
  }
});

// Start server
const PORT = parseInt(process.env.PORT || '3000', 10);
console.log(`[DEBUG] PORT env var: ${process.env.PORT}`);
console.log(`[DEBUG] Parsed PORT: ${PORT}`);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`vault-mcp listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
  console.log(`OAuth endpoints ready at ${process.env.SERVER_URL}`);
});

// Export for testing
export { app, pool };
