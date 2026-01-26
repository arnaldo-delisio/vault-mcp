/**
 * Embeddings Service - Reusable embedding generation for vault content
 *
 * Extracted from tool-search.ts for shared use by:
 * - extract_content (library content embeddings)
 * - save_learning (synthesis embeddings)
 * - search_notes (query embeddings for semantic search)
 */

import OpenAI from 'openai';

// Lazy-initialized OpenAI client
let openai: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
  if (openai) return openai;
  if (!process.env.OPENAI_API_KEY) return null;
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

/**
 * Generate embedding for text using OpenAI text-embedding-3-small
 * Truncates to ~7500 tokens (30000 chars) to stay within 8191 token limit
 *
 * @param text - Text content to embed
 * @returns 1536-dimension embedding vector
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OPENAI_API_KEY not set - cannot generate embedding');
  }

  const truncated = text.slice(0, 30000);

  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: truncated
  });

  return response.data[0].embedding;
}

/**
 * Check if embedding generation is available
 * Returns false if OPENAI_API_KEY is not set
 */
export function isEmbeddingAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Chunk text into smaller segments for embedding generation
 * Uses sentence-aware splitting to avoid cutting concepts mid-sentence
 *
 * Strategy:
 * - Split on sentence boundaries (. ! ? or double newline)
 * - Target chunk size: ~6000 chars (~1500 tokens, well under 8191 limit)
 * - Apply 500-char overlap between chunks to prevent context loss at boundaries
 * - Fallback to hard split if no sentence boundary found within reasonable distance
 *
 * @param text - Text content to chunk
 * @param maxChunkSize - Maximum characters per chunk (default 6000)
 * @param overlap - Character overlap between consecutive chunks (default 500)
 * @returns Array of text chunks
 */
function chunkText(
  text: string,
  maxChunkSize: number = 6000,
  overlap: number = 500
): string[] {
  if (text.length <= maxChunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    // Determine end position for this chunk
    let end = Math.min(start + maxChunkSize, text.length);

    // If not at the end of text, try to find a sentence boundary
    if (end < text.length) {
      // Look for sentence boundaries within last 500 chars of chunk
      const searchStart = Math.max(start, end - 500);
      const searchText = text.slice(searchStart, end);

      // Try to find sentence boundaries (in order of preference)
      const boundaries = [
        searchText.lastIndexOf('. '),
        searchText.lastIndexOf('! '),
        searchText.lastIndexOf('? '),
        searchText.lastIndexOf('\n\n')
      ];

      const bestBoundary = Math.max(...boundaries);

      if (bestBoundary > 0) {
        // Found a sentence boundary - adjust end to that position
        // +2 to include the punctuation and space
        end = searchStart + bestBoundary + 2;
      }
      // If no boundary found, use hard split at maxChunkSize (end is already set)
    }

    // Extract chunk
    chunks.push(text.slice(start, end));

    // Move start position forward with overlap
    // Overlap prevents context loss at chunk boundaries
    start = end - overlap;

    // Ensure we make progress (avoid infinite loop if overlap >= maxChunkSize)
    if (start <= chunks[chunks.length - 1].length - maxChunkSize) {
      start = end;
    }
  }

  return chunks;
}

/**
 * Generate chunked embeddings for long text content
 * Splits text into ~6000 char chunks and generates embeddings for each
 *
 * This solves the information loss problem with naive truncation:
 * - Long YouTube videos: Full content searchable, not just first 30k chars
 * - Research PDFs: Key insights searchable regardless of page number
 * - Long articles: Complete semantic coverage
 *
 * @param text - Text content to embed (full document, no truncation)
 * @returns Array of chunk objects with index, text, and embedding
 */
export async function generateChunkedEmbeddings(
  text: string
): Promise<Array<{ chunk_index: number; chunk_text: string; embedding: number[] }>> {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OPENAI_API_KEY not set - cannot generate embeddings');
  }

  // Split text into chunks
  const chunks = chunkText(text);

  // Generate embeddings for all chunks
  // Process sequentially to avoid rate limits (could parallelize with rate limiting in future)
  const results = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const response = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunks[i]
      });

      results.push({
        chunk_index: i,
        chunk_text: chunks[i],
        embedding: response.data[0].embedding
      });
    } catch (error) {
      // Log error but continue with other chunks
      console.error(`Failed to generate embedding for chunk ${i}:`, error);
      // Skip this chunk rather than failing entire operation
      continue;
    }
  }

  if (results.length === 0) {
    throw new Error('Failed to generate any embeddings for chunks');
  }

  return results;
}
