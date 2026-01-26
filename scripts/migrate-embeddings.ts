#!/usr/bin/env node
/**
 * Migration Script: Re-embed existing content with chunked embeddings
 *
 * Purpose: Migrate library content from naive truncation (30k chars) to proper chunking
 *
 * Process:
 * 1. Query files with embeddings but no chunks in file_chunks table
 * 2. For each file, generate chunked embeddings from body text
 * 3. Insert chunks into file_chunks table
 *
 * Usage:
 *   npx tsx scripts/migrate-embeddings.ts [--dry-run]
 *
 * Flags:
 *   --dry-run: Preview files to migrate without writing to database
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { generateChunkedEmbeddings } from '../src/services/embeddings.js';

// Parse command line arguments
const isDryRun = process.argv.includes('--dry-run');

// Validate Supabase configuration
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: Missing Supabase configuration');
  console.error('Required: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env file');
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error('Error: Missing OPENAI_API_KEY');
  console.error('Required: OPENAI_API_KEY in .env file for embedding generation');
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

interface FileToMigrate {
  id: string;
  path: string;
  body: string;
}

/**
 * Find files that need migration
 * (have embeddings in files.embedding but no chunks in file_chunks)
 */
async function findFilesToMigrate(): Promise<FileToMigrate[]> {
  console.log('Finding files to migrate...');

  // Query files with embeddings but no chunks
  const { data, error } = await supabase
    .from('files')
    .select('id, path, body')
    .not('embedding', 'is', null)
    .not('body', 'is', null);

  if (error) {
    throw new Error(`Failed to query files: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return [];
  }

  // Filter out files that already have chunks
  const fileIds = data.map(f => f.id);
  const { data: existingChunks } = await supabase
    .from('file_chunks')
    .select('file_id')
    .in('file_id', fileIds);

  const filesWithChunks = new Set(
    (existingChunks || []).map((c: { file_id: string }) => c.file_id)
  );

  const filesToMigrate = data.filter(f => !filesWithChunks.has(f.id));

  console.log(`Found ${filesToMigrate.length} files to migrate (${filesWithChunks.size} already have chunks)`);

  return filesToMigrate as FileToMigrate[];
}

/**
 * Migrate a single file's embeddings to chunks
 */
async function migrateFile(file: FileToMigrate): Promise<void> {
  console.log(`  Processing: ${file.path}`);

  try {
    // Generate chunked embeddings
    const chunks = await generateChunkedEmbeddings(file.body);

    console.log(`    Generated ${chunks.length} chunks`);

    if (isDryRun) {
      console.log(`    [DRY RUN] Would insert ${chunks.length} chunks`);
      return;
    }

    // Insert chunks into database
    const { error } = await supabase
      .from('file_chunks')
      .insert(
        chunks.map(c => ({
          file_id: file.id,
          chunk_index: c.chunk_index,
          chunk_text: c.chunk_text,
          embedding: c.embedding
        }))
      );

    if (error) {
      throw new Error(`Failed to insert chunks: ${error.message}`);
    }

    console.log(`    ✓ Saved ${chunks.length} chunks`);
  } catch (error) {
    console.error(`    ✗ Error: ${error instanceof Error ? error.message : String(error)}`);
    // Continue with next file despite error
  }
}

/**
 * Main migration function
 */
async function migrate() {
  console.log('Embedding Migration Script');
  console.log('==========================\n');

  if (isDryRun) {
    console.log('*** DRY RUN MODE - No database writes ***\n');
  }

  try {
    // Find files to migrate
    const files = await findFilesToMigrate();

    if (files.length === 0) {
      console.log('No files need migration. All done!');
      return;
    }

    console.log(`\nMigrating ${files.length} file${files.length === 1 ? '' : 's'}...\n`);

    // Migrate each file
    let successCount = 0;
    let errorCount = 0;

    for (const file of files) {
      try {
        await migrateFile(file);
        successCount++;
      } catch (error) {
        errorCount++;
        console.error(`  Failed to migrate ${file.path}:`, error);
      }
    }

    console.log(`\nMigration complete!`);
    console.log(`  Success: ${successCount}`);
    console.log(`  Errors: ${errorCount}`);

    if (isDryRun) {
      console.log('\nRun without --dry-run to apply changes.');
    }

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// Run migration
migrate().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
