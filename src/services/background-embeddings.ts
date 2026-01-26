/**
 * 4-Level Hybrid Embedding Processing System
 *
 * Level 1: Always save file immediately with pending status (instant return)
 * Level 2: Small files (<5 chunks) processed inline (~1-2s latency, acceptable)
 * Level 3: Large files → Supabase Edge Function processes asynchronously
 * Level 4: MCP startup hook catches stuck pending files (safety net)
 */

import { createClient } from '@supabase/supabase-js';
import { generateChunkedEmbeddings } from './embeddings.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Threshold: files with ≤5 chunks (~30k chars) process inline
// Above this, defer to Edge Function for background processing
export const SYNC_THRESHOLD = 5;

/**
 * Level 2: Smart inline processing for small files
 *
 * Estimates chunk count and decides inline vs background.
 * Small files (<30k chars) processed immediately for instant semantic search.
 * Large files marked pending for Edge Function processing.
 *
 * @param fileId - Database ID of the file
 * @param text - Full text content for embedding
 * @returns Processing result with status
 */
export async function processInlineIfSmall(
  fileId: string,
  text: string
): Promise<{ processed: boolean; chunks_status: string }> {
  const estimatedChunks = Math.ceil(text.length / 6000);

  // Small file: process inline
  if (estimatedChunks <= SYNC_THRESHOLD) {
    try {
      // Mark as processing
      await supabase.from('files')
        .update({ chunks_status: 'processing' })
        .eq('id', fileId);

      // Generate and save chunks
      const chunks = await generateChunkedEmbeddings(text);
      await supabase.from('file_chunks').insert(
        chunks.map((c, i) => ({
          file_id: fileId,
          chunk_index: i,
          chunk_text: c.chunk_text,
          embedding: c.embedding
        }))
      );

      // Mark complete
      await supabase.from('files')
        .update({ chunks_status: 'complete' })
        .eq('id', fileId);

      return { processed: true, chunks_status: 'complete' };
    } catch (err) {
      console.error('Inline embedding failed, falling back to Edge Function:', err);

      // Fallback: Mark as pending for Edge Function pickup
      await supabase.from('files')
        .update({ chunks_status: 'pending' })
        .eq('id', fileId);

      return { processed: false, chunks_status: 'pending' };
    }
  }

  // Large file: leave as pending for Edge Function
  return { processed: false, chunks_status: 'pending' };
}

/**
 * Level 4: Startup processor (safety net)
 *
 * Runs when MCP server starts to catch any stuck pending files.
 * Processes files that Edge Function might have missed due to webhook failures,
 * network issues, or Edge Function errors.
 *
 * Only processes files that have been pending for >5 minutes to avoid
 * interfering with Edge Function processing.
 */
export async function startupProcessor() {
  try {
    console.log('[Background Embeddings] Running startup processor...');

    // Find stuck pending/failed files (>5 minutes old)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: pendingFiles } = await supabase
      .from('files')
      .select('id, path, body')
      .in('chunks_status', ['pending', 'failed'])
      .lt('created_at', fiveMinutesAgo)
      .limit(10);

    if (!pendingFiles || pendingFiles.length === 0) {
      console.log('[Background Embeddings] No stuck files found');
      return;
    }

    console.log(`[Background Embeddings] Processing ${pendingFiles.length} stuck files`);

    // Process each file using Level 2 logic
    for (const file of pendingFiles) {
      await processInlineIfSmall(file.id, file.body);
    }

    console.log('[Background Embeddings] Startup processing complete');
  } catch (err) {
    console.error('[Background Embeddings] Startup processor error:', err);
  }
}
