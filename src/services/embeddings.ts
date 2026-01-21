/**
 * Embeddings Service - Reusable embedding generation for vault content
 *
 * Extracted from tool-search.ts for shared use by:
 * - extract_content (library content embeddings)
 * - save_learning (synthesis embeddings)
 * - search_notes (query embeddings for semantic search)
 */

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generate embedding for text using OpenAI text-embedding-3-small
 * Truncates to ~7500 tokens (30000 chars) to stay within 8191 token limit
 *
 * @param text - Text content to embed
 * @returns 1536-dimension embedding vector
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const truncated = text.slice(0, 30000);

  const response = await openai.embeddings.create({
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
