/**
 * Search Notes - Hybrid keyword + semantic search across vault content
 *
 * Uses hybrid_search RPC function combining:
 * - ILIKE keyword matching for exact term hits
 * - pgvector embedding similarity for semantic matches
 * - Reciprocal Rank Fusion (RRF) for result ranking
 */

import { supabase } from '../services/vault-client.js';
import { generateEmbedding, isEmbeddingAvailable } from '../services/embeddings.js';

interface SearchResult {
  path: string;
  snippet: string;
  tags: string[];
  updated_at: string;
  score?: number;  // RRF score from hybrid search
}

/**
 * Search vault files using hybrid keyword + semantic search
 *
 * @param query - Search query text
 * @param limit - Maximum results (1-20)
 * @param contentType - Optional filter: 'transcript', 'learning', etc.
 */
async function searchNotes(
  query: string,
  limit: number = 10,
  contentType?: string
): Promise<SearchResult[]> {
  if (!query || typeof query !== 'string') {
    throw new Error('Invalid query parameter: must be a non-empty string');
  }

  // Enforce max limit to prevent overwhelming mobile context
  const safeLimit = Math.min(Math.max(1, limit), 20);

  try {
    // Generate query embedding for semantic search
    let queryEmbedding: number[] | null = null;
    if (isEmbeddingAvailable()) {
      try {
        queryEmbedding = await generateEmbedding(query);
      } catch (err) {
        console.warn('Failed to generate query embedding, falling back to keyword-only:', err);
      }
    }

    // Call hybrid_search_chunked RPC with explicit user_id
    // Service role key makes auth.uid() return NULL, so we pass explicit p_user_id
    const { data, error } = await supabase.rpc('hybrid_search_chunked', {
      query_text: query,
      query_embedding: queryEmbedding,
      p_user_id: '00000000-0000-0000-0000-000000000001',
      match_count: safeLimit,
      content_type: contentType || null
    });

    if (error) {
      throw new Error(`Hybrid search failed: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return [];
    }

    // Fetch file metadata for tags and dates
    // hybrid_search_chunked returns minimal fields (file_id, path, score, snippet)
    // so we need to fetch frontmatter separately for tags and dates
    const filePaths = data.map((r: { path: string }) => r.path);
    const { data: filesMetadata } = await supabase
      .from('files')
      .select('path, frontmatter')
      .in('path', filePaths);

    const metadataMap = new Map(
      (filesMetadata || []).map((f: { path: string; frontmatter: unknown }) => [
        f.path,
        f.frontmatter as { tags?: string[]; created_at?: string } | null
      ])
    );

    // Format results with snippets from RPC
    return data.map((result: {
      path: string;
      snippet: string | null;
      score: number;
    }) => {
      const metadata = metadataMap.get(result.path);

      return {
        path: result.path,
        snippet: result.snippet || '',
        tags: metadata?.tags || [],
        updated_at: metadata?.created_at || new Date().toISOString(),
        score: result.score
      };
    });
  } catch (error) {
    throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * MCP tool handler for search_notes
 */
export async function searchNotesTool(args: {
  query: string;
  limit?: number;
  type?: string;
}): Promise<string> {
  const { query, limit, type } = args;

  const results = await searchNotes(query, limit, type);

  if (results.length === 0) {
    return `No files found matching query: "${query}"`;
  }

  // Format results as readable text
  const formattedResults = results.map((result, index) => {
    const tagsStr = result.tags.length > 0 ? ` [${result.tags.join(', ')}]` : '';
    const scoreStr = result.score !== undefined ? ` (score: ${result.score.toFixed(3)})` : '';
    return `${index + 1}. ${result.path}${tagsStr}${scoreStr}
   Updated: ${new Date(result.updated_at).toLocaleDateString()}
   ${result.snippet}`;
  }).join('\n\n');

  return `Found ${results.length} result${results.length === 1 ? '' : 's'}:\n\n${formattedResults}`;
}

/**
 * Tool definition for MCP registration
 */
export const searchNotesToolDef = {
  name: 'search_notes',
  description: 'Search vault content using hybrid keyword + semantic search. Returns relevance-ranked results combining exact keyword matches and semantic similarity.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (keywords or natural language)'
      },
      limit: {
        type: 'number',
        description: 'Max results (1-20, default 10)'
      },
      type: {
        type: 'string',
        description: 'Filter by content type: transcript, learning, note, etc.'
      }
    },
    required: ['query']
  }
};
