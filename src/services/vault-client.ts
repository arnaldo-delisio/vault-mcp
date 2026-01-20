import { createClient } from '@supabase/supabase-js';

// Validate Supabase environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase configuration: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
}

/**
 * Supabase client for vault operations
 * 
 * Uses SERVICE_ROLE_KEY (not anon key) because vault-mcp is a trusted server.
 * Service role bypasses RLS - vault-mcp enforces user_id via OAuth session.
 * 
 * This matches vault-daemon pattern but with service role for write access.
 */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export { supabase };
