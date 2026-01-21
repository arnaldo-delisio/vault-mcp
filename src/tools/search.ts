/**
 * Search Notes - Full-text search across vault content
 *
 * Provides basic ILIKE substring matching for Phase 3.
 * Phase 4 will add advanced full-text search with ranking.
 */

import { supabase } from '../services/vault-client.js';

interface SearchResult {
  path: string;
  snippet: string;
  tags: string[];
  updated_at: string;
}

/**
 * Search vault files by content substring matching
 */
async function searchNotes(query: string, limit: number = 10): Promise<SearchResult[]> {
  if (!query || typeof query !== 'string') {
    throw new Error('Invalid query parameter: must be a non-empty string');
  }

  // Enforce max limit to prevent overwhelming mobile context
  const safeLimit = Math.min(Math.max(1, limit), 20);

  try {
    // Query files with ILIKE for substring matching
    const { data, error } = await supabase
      .from('files')
      .select('path, body, frontmatter, updated_at')
      .ilike('body', `%${query}%`)
      .order('updated_at', { ascending: false })
      .limit(safeLimit);

    if (error) {
      throw new Error(`Database query failed: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return [];
    }

    // Format results with snippets
    return data.map(file => {
      // Extract first 150 characters of body as snippet
      const snippet = file.body ? file.body.slice(0, 150).trim() : '';

      // Extract tags from frontmatter JSONB if available
      const tags = file.frontmatter?.tags || [];

      return {
        path: file.path,
        snippet: snippet + (file.body && file.body.length > 150 ? '...' : ''),
        tags: Array.isArray(tags) ? tags : [],
        updated_at: file.updated_at
      };
    });
  } catch (error) {
    throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * MCP tool handler for search_notes
 */
export async function searchNotesTool(args: { query: string; limit?: number }): Promise<string> {
  const { query, limit } = args;

  const results = await searchNotes(query, limit);

  if (results.length === 0) {
    return `No files found matching query: "${query}"`;
  }

  // Format results as readable text
  const formattedResults = results.map((result, index) => {
    const tagsStr = result.tags.length > 0 ? ` [${result.tags.join(', ')}]` : '';
    return `${index + 1}. ${result.path}${tagsStr}
   Updated: ${new Date(result.updated_at).toLocaleDateString()}
   ${result.snippet}`;
  }).join('\n\n');

  return `Found ${results.length} result${results.length === 1 ? '' : 's'}:\n\n${formattedResults}`;
}
