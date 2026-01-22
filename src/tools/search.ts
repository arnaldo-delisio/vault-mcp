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

    // Call hybrid_search RPC with explicit user_id
    // Service role key makes auth.uid() return NULL, so we pass explicit p_user_id
    const { data, error } = await supabase.rpc('hybrid_search', {
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

    // Format results with context snippets
    return data.map((file: {
      path: string;
      body: string | null;
      frontmatter: { tags?: string[]; created_at?: string } | null;
      score: number;
    }) => {
      // Find query in body and extract surrounding context
      const lowerBody = file.body?.toLowerCase() || '';
      const lowerQuery = query.toLowerCase();
      const matchIndex = lowerBody.indexOf(lowerQuery);

      let snippet: string;
      if (matchIndex >= 0 && file.body) {
        // Show context around the match with highlighting
        const start = Math.max(0, matchIndex - 50);
        const end = Math.min(file.body.length, matchIndex + query.length + 100);
        const rawSnippet = file.body.slice(start, end);

        // Bold the match (for display)
        snippet = rawSnippet.replace(
          new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          match => `**${match}**`
        );

        if (start > 0) snippet = '...' + snippet;
        if (end < file.body.length) snippet = snippet + '...';
      } else {
        // Semantic match - no exact keyword, show start of content
        snippet = file.body ? file.body.slice(0, 150).trim() + '...' : '';
      }

      return {
        path: file.path,
        snippet,
        tags: file.frontmatter?.tags || [],
        updated_at: file.frontmatter?.created_at || new Date().toISOString(),
        score: file.score
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
