---
status: published
category: mcp-server
author: arnaldo-delisio
published_npm: false
npm_package: vault-mcp
published_directories: []
production_url: null
last_active: 2026-01-26
---

# vault-mcp

MCP server providing authenticated mobile access to vault operations from Claude Mobile.

## Overview

vault-mcp is a Model Context Protocol (MCP) server that enables Claude Mobile to interact with your personal vault stored in Supabase. It provides authenticated access to search, read, capture, and synthesize content directly from your mobile device.

The server uses OAuth 2.1 password flow for authentication and connects to the same Supabase database used by vault-daemon for bidirectional sync.

## Features

vault-mcp provides 5 tools accessible from Claude Mobile:

- **vault_search_tools**: Intelligent tool discovery using hybrid BM25 + OpenAI embeddings search with Reciprocal Rank Fusion for >90% query accuracy
- **synthesize_content**: Extract content from URLs (YouTube videos or web articles), conduct multi-turn conversation to gather context, and save synthesized learnings with frontmatter
- **add_note**: Append timestamped notes to today's daily journal file (daily/YYYY-MM-DD.md) with automatic file creation
- **search_notes**: Hybrid keyword + semantic search across vault content using file_chunks, returns formatted results with snippets and relevance scores
- **read_note**: Retrieve file contents by exact path. Optional `search` parameter filters to relevant sections using semantic + keyword search in chunks (for files >50k chars)

## Prerequisites

- Node.js 20 or higher
- Supabase account with vault database (vault_files table from Phase 1)
- Railway account for deployment
- OpenAI API key (for tool discovery embeddings)
- Git repository for automatic Railway deployments

## Local Development

### 1. Clone repository

```bash
cd /home/arn/projects/mcp-servers
git clone <repository-url> vault-mcp
cd vault-mcp
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create environment file

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

### 4. Generate required secrets

Generate OAuth credentials and session secrets:

```bash
# Generate OAuth client ID (UUID format)
uuidgen

# Generate OAuth client secret (32 characters)
openssl rand -hex 32

# Generate bcrypt password hash (choose a strong password)
node -e "require('bcrypt').hash('YOUR_PASSWORD_HERE', 12).then(console.log)"

# Generate session secret (64 characters)
openssl rand -hex 64

# Generate API key (32 characters)
openssl rand -hex 32
```

### 5. Configure environment variables

Edit `.env` and set all required values (see Environment Variables Reference below).

### 6. Apply OAuth tables migration

Apply the migration to your Supabase database:

```bash
# Option 1: Via Supabase SQL Editor
# - Open Supabase Dashboard → SQL Editor
# - Copy contents of migrations/003_oauth_tables.sql
# - Run query

# Option 2: Via psql (if you have DATABASE_URL)
psql "$DATABASE_URL" < migrations/003_oauth_tables.sql
```

### 7. Run development server

```bash
npm run dev
```

### 8. Test health check

```bash
curl http://localhost:3000/
# Should return: {"status":"ok","service":"vault-mcp"}
```

## Railway Deployment

### 1. Create Railway project

- Visit https://railway.app
- Click "New Project" → "Deploy from GitHub repo"
- Select your vault-mcp repository
- Railway auto-detects Node.js and uses package.json scripts

### 2. Set environment variables

In Railway Dashboard → Variables tab, configure all environment variables:

| Variable | Description | How to Generate |
|----------|-------------|-----------------|
| `SERVER_URL` | Railway deployment URL | Copy from Railway deployment (e.g., https://vault-mcp-production.up.railway.app) |
| `DATABASE_URL` | PostgreSQL connection string | Supabase Dashboard → Settings → Database → Connection string |
| `SUPABASE_URL` | Supabase project URL | Supabase Dashboard → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (NOT anon key) | Supabase Dashboard → Settings → API → service_role key (secret) |
| `OAUTH_CLIENT_ID` | OAuth client identifier | `uuidgen` |
| `OAUTH_CLIENT_SECRET` | OAuth client secret | `openssl rand -hex 32` |
| `OAUTH_PASSWORD_HASH` | Bcrypt-hashed password | `node -e "require('bcrypt').hash('yourpassword', 12).then(console.log)"` |
| `SESSION_SECRET` | Express session secret | `openssl rand -hex 64` |
| `API_KEY` | API authentication key | `openssl rand -hex 32` |
| `OPENAI_API_KEY` | OpenAI API key for embeddings | OpenAI Dashboard → API keys → Create new secret key |

**Important notes:**

- Use the **service_role** key, NOT the anon key - vault-mcp needs write access to vault_files
- Generate unique OAuth credentials per deployment (never reuse across environments)
- Store the password you hash - you'll need it to authenticate from Claude Mobile
- OPENAI_API_KEY is required for intelligent tool search (~$0.01 one-time cost on startup)

### 3. Apply OAuth tables migration

Before first deployment, apply the migration to Supabase:

```bash
# In Supabase SQL Editor, run migrations/003_oauth_tables.sql
```

### 4. Trigger deployment

Railway automatically deploys when you:
- Set environment variables and click Save
- Push commits to GitHub main branch

Watch Deployments tab for build progress.

### 5. Verify deployment

```bash
# Health check
curl https://your-railway-url.up.railway.app/

# OAuth endpoint (should return login page HTML)
curl https://your-railway-url.up.railway.app/oauth/authorize
```

Check Railway logs for:
- "vault-mcp listening on port 3000" (or Railway-assigned port)
- "✓ Pre-computed embeddings for 5 tools" (confirms OpenAI API key working)
- No database connection errors

## Claude Mobile Configuration

### 1. Open Claude Mobile app

- iOS: Settings → Integrations
- Android: Menu → Settings → Integrations

### 2. Add MCP Server

- Tap "Add MCP Server" or "Connect to MCP Server"
- Enter server URL: `https://your-railway-url.up.railway.app/mcp`

### 3. Authenticate

- You'll be redirected to OAuth login page
- Enter the password you used when generating OAUTH_PASSWORD_HASH
- Grant permissions

### 4. Verify connection

Ask Claude:
```
Search my vault for "test"
```

Claude should respond with search results from your vault, confirming successful connection.

### 5. Test all tools

Try each tool to ensure full functionality:

```
# Tool discovery
Find tools for capturing content

# Synthesize content
Help me synthesize this video: https://youtube.com/watch?v=VIDEO_ID

# Add note
Add a note to my daily journal: "Tested vault-mcp deployment"

# Search notes
Search my vault for "project"

# Read note
Read the file at path: daily/2026-01-20.md
```

## Environment Variables Reference

Complete reference of all environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3000 | HTTP server port (Railway assigns dynamically) |
| `SERVER_URL` | Yes | - | Full deployment URL including https:// |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string (postgres://...) |
| `SUPABASE_URL` | Yes | - | Supabase project URL (https://xxx.supabase.co) |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | - | Service role key for bypassing RLS |
| `OAUTH_CLIENT_ID` | Yes | - | OAuth client identifier (UUID format) |
| `OAUTH_CLIENT_SECRET` | Yes | - | OAuth client secret (32+ characters) |
| `OAUTH_PASSWORD_HASH` | Yes | - | Bcrypt hash of authentication password |
| `SESSION_SECRET` | Yes | - | Express session encryption key (64+ characters) |
| `API_KEY` | Yes | - | API authentication key for MCP endpoint |
| `OPENAI_API_KEY` | Yes | - | OpenAI API key for tool discovery embeddings |

### Environment Variable Security

**Critical - Keep SECRET:**
- `SUPABASE_SERVICE_ROLE_KEY`: Full database access, bypasses Row Level Security
- `OAUTH_CLIENT_SECRET`: Authenticates OAuth clients
- `OAUTH_PASSWORD_HASH`: Protects authentication endpoint
- `SESSION_SECRET`: Encrypts session cookies
- `API_KEY`: Authenticates MCP requests
- `OPENAI_API_KEY`: Charged to your OpenAI account

**Public (can be in client code):**
- `SERVER_URL`: Public deployment URL
- `SUPABASE_URL`: Public project URL (RLS enforces security)

## Security Notes

### Password Hashing

- OAUTH_PASSWORD_HASH must use bcrypt with **12+ rounds** for 2026 security standards
- Never store plaintext passwords in environment variables
- Use a strong, unique password (16+ characters, mixed case, numbers, symbols)

### Session Security

- SESSION_SECRET must be **cryptographically random** (use openssl rand -hex 64)
- Sessions persist for 90 days (configured in src/index.ts)
- Sessions stored in PostgreSQL session table with automatic expiry cleanup

### API Authentication

- API_KEY protects the /mcp endpoint from unauthorized access
- Must be cryptographically random (use openssl rand -hex 32)
- Sent as Bearer token: Authorization: Bearer {API_KEY}

### Service Role Key

- SUPABASE_SERVICE_ROLE_KEY gives **full database access**
- Bypasses Row Level Security policies
- Only use in trusted server environments (never in client code)
- vault-mcp uses it to write to vault_files on behalf of authenticated users

### OAuth Flow

- OAuth 2.1 with PKCE (Proof Key for Code Exchange)
- Dynamic Client Registration for Claude Mobile
- Authorization codes expire in 10 minutes
- Access tokens embedded in session cookies (httpOnly, secure, sameSite=lax)

### OpenAI API Key

- Used only for pre-computing tool embeddings on server startup
- One-time cost (~$0.01 for 5 tools)
- Embeddings cached in memory, no per-query API calls
- If missing, tool search falls back to BM25-only mode (~70-80% accuracy vs >90%)

## Troubleshooting

### "unauthorized" errors when calling MCP tools

**Cause:** API_KEY mismatch between Railway environment and Claude Mobile configuration

**Fix:**
1. Check Railway Variables tab - verify API_KEY is set
2. Regenerate API_KEY: `openssl rand -hex 32`
3. Update in Railway Variables
4. Wait for automatic redeployment
5. Reconnect Claude Mobile to vault-mcp

### Session expires immediately after login

**Cause:** SESSION_SECRET not set correctly or missing

**Fix:**
1. Check Railway Variables tab - verify SESSION_SECRET exists
2. Generate new secret: `openssl rand -hex 64`
3. Update SESSION_SECRET in Railway
4. Clear browser/app cache
5. Re-authenticate

### Database connection fails on startup

**Cause:** Invalid DATABASE_URL format or incorrect credentials

**Fix:**
1. Verify DATABASE_URL in Supabase Dashboard → Settings → Database
2. Ensure format: `postgres://postgres.[project]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres`
3. Check Railway logs for specific error (timeout, auth failed, SSL error)
4. For SSL errors, append `?sslmode=require` to DATABASE_URL

### Tools not appearing in Claude Mobile

**Cause:** MCP server not registered correctly or tools not loaded

**Fix:**
1. Check Railway logs for "✓ Registered 5 tools" message
2. Verify /mcp endpoint responds: `curl https://your-url/mcp`
3. Check src/mcp-server.ts - all 5 tools should be in ListToolsRequestSchema handler
4. Rebuild and redeploy: `railway up` or push to GitHub
5. Disconnect and reconnect MCP server in Claude Mobile

### Tool search returns irrelevant results

**Cause:** OpenAI embeddings not loaded or OPENAI_API_KEY invalid

**Fix:**
1. Check Railway logs for "✓ Pre-computed embeddings for 5 tools"
2. If missing, verify OPENAI_API_KEY in Railway Variables
3. Test API key: `curl https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"`
4. Generate new key at https://platform.openai.com/api-keys
5. Update OPENAI_API_KEY in Railway and redeploy

### YouTube transcript extraction fails

**Cause:** Video has no English captions or captions disabled

**Fix:**
1. Verify video has captions: Open YouTube video → Settings → Subtitles
2. Check for "English" or "English (auto-generated)" option
3. If unavailable, use WebFetch for video description instead
4. Check Railway logs for specific youtube-caption-extractor error

### Daily journal file not created

**Cause:** File path mismatch or Supabase write permissions

**Fix:**
1. Verify vault_files table exists in Supabase
2. Check service role key has INSERT permissions
3. Verify path format: `daily/YYYY-MM-DD.md` (not `journal/`)
4. Check Railway logs for Supabase error details
5. Test manual insert via Supabase SQL Editor

## Development Workflow

### Building for production

```bash
npm run build
# Output: dist/ directory with compiled JavaScript
```

### Running production build locally

```bash
npm run build
npm start
# Runs compiled dist/index.js
```

### Watching for changes during development

```bash
npm run dev
# tsx watch restarts server on file changes
```

### Checking TypeScript compilation

```bash
npx tsc --noEmit
# Type-checks without emitting files
```

## Architecture

### Directory Structure

```
vault-mcp/
├── src/
│   ├── index.ts              # Express app with OAuth setup
│   ├── mcp-server.ts         # MCP server instance and tool registry
│   ├── tools/                # Tool implementations
│   │   ├── tool-search.ts    # vault_search_tools (hybrid BM25 + embeddings)
│   │   ├── synthesize.ts     # synthesize_content (multi-turn conversation)
│   │   ├── notes.ts          # add_note (daily journal appends)
│   │   ├── search.ts         # search_notes (ILIKE full-text search)
│   │   └── read.ts           # read_note (exact path file retrieval)
│   ├── services/
│   │   ├── vault-client.ts   # Supabase client with service role
│   │   └── content-extract.ts # YouTube transcript extraction
│   └── utils/
│       └── frontmatter.ts    # YAML frontmatter utilities
├── migrations/
│   └── 003_oauth_tables.sql # OAuth database schema
├── dist/                     # Compiled JavaScript (gitignored)
├── package.json              # Dependencies and Railway scripts
├── tsconfig.json             # TypeScript configuration
└── .env.example              # Environment variable template
```

### Authentication Flow

1. Claude Mobile initiates OAuth flow → `/oauth/authorize`
2. User redirected to login page (EJS view from mcp-oauth-password)
3. User enters password → bcrypt comparison with OAUTH_PASSWORD_HASH
4. Authorization code generated and stored in authorization_codes table
5. Claude Mobile exchanges code for access token (PKCE verified)
6. Access token embedded in session cookie (PostgreSQL session table)
7. Subsequent MCP requests authenticated via session cookie + API_KEY

### Tool Execution Flow

1. Claude Mobile sends MCP request to `/mcp` endpoint
2. Auth middleware validates session cookie + API_KEY
3. MCP server routes request to appropriate tool handler
4. Tool executes (Supabase queries, content extraction, etc.)
5. Result returned as MCP response
6. Claude Mobile displays result to user

### Database Schema

vault-mcp interacts with these Supabase tables:

**vault_files** (from Phase 1):
- `id`: UUID primary key
- `user_id`: Text (authenticated user from OAuth session)
- `path`: Text (e.g., "learnings/youtube-abc123.md")
- `content`: Text (full markdown content)
- `frontmatter`: JSONB (created_at, source_url, tags, type)
- `content_hash`: Text (SHA256 hash for conflict detection)
- `updated_at`: Timestamptz

**OAuth tables** (from migrations/003_oauth_tables.sql):
- `authorization_codes`: OAuth flow temporary codes
- `oauth_clients`: Registered OAuth client configurations
- `session`: Express session persistence
- `auth_logs`: Authentication event audit trail

## Contributing

This is a personal project for vault management. No external contributions accepted.

## License

ISC

## Support

For issues or questions, check:
- Railway deployment logs
- Supabase table query performance
- Claude Mobile MCP connection status
- OpenAI API quota and billing

Refer to Troubleshooting section above for common issues and resolutions.
