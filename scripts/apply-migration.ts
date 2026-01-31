#!/usr/bin/env node
/**
 * Apply migration via Supabase client
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: Missing Supabase configuration');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const migrationPath = process.argv[2];
if (!migrationPath) {
  console.error('Usage: npx tsx scripts/apply-migration.ts <migration-file>');
  process.exit(1);
}

const sql = readFileSync(migrationPath, 'utf-8');

console.log(`Applying migration: ${migrationPath}`);

// Split SQL by semicolons and execute each statement
const statements = sql
  .split(';')
  .map(s => s.trim())
  .filter(s => s.length > 0 && !s.startsWith('--'));

for (const statement of statements) {
  if (statement.startsWith('comment on')) {
    // Skip comments - they're metadata
    continue;
  }

  console.log(`Executing: ${statement.slice(0, 50)}...`);

  const { error } = await supabase.rpc('exec_sql', { sql: statement });

  if (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

console.log('Migration applied successfully');
