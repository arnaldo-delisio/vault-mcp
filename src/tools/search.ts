/**
 * Search Notes - Hybrid keyword + semantic search across vault content
 *
 * Uses hybrid_search RPC function combining:
 * - ILIKE keyword matching for exact term hits
 * - pgvector embedding similarity for semantic matches
 * - Reciprocal Rank Fusion (RRF) for result ranking
 *
 * Supports advanced filters:
 * - file_type: library, learnings, daily, mocs
 * - tags: array (OR within array)
 * - author: matches author field OR guests array
 * - source: youtube, article, pdf (library only)
 * - after/before: date range filtering
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

interface SearchFilters {
  file_type?: 'library' | 'learnings' | 'daily' | 'mocs';
  tags?: string[];
  author?: string;
  source?: 'youtube' | 'article' | 'pdf';
  after?: string;  // YYYY-MM-DD
  before?: string; // YYYY-MM-DD
}

/**
 * Search vault files using hybrid keyword + semantic search with advanced filters
 *
 * @param query - Search query text (optional for filtered browse)
 * @param limit - Maximum results (1-20)
 * @param filters - Advanced filters
 */
async function searchNotes(
  query: string | null,
  limit: number = 10,
  filters?: SearchFilters
): Promise<SearchResult[]> {

  // Enforce max limit to prevent overwhelming mobile context
  const safeLimit = Math.min(Math.max(1, limit), 20);

  try {
    // Validate date filters
    if (filters?.after && !isValidDate(filters.after)) {
      throw new Error(`Invalid after date: must be YYYY-MM-DD format`);
    }
    if (filters?.before && !isValidDate(filters.before)) {
      throw new Error(`Invalid before date: must be YYYY-MM-DD format`);
    }

    // If query provided: use hybrid search with filters
    if (query) {
      return await hybridSearchWithFilters(query, safeLimit, filters);
    }

    // No query: filtered browse (direct SELECT with filters)
    return await filteredBrowse(safeLimit, filters);
  } catch (error) {
    throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Validate YYYY-MM-DD date format
 */
function isValidDate(dateStr: string): boolean {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) return false;

  const date = new Date(dateStr);
  return date instanceof Date && !isNaN(date.getTime());
}

/**
 * Build SQL filters from SearchFilters object
 */
function buildFilters(builder: any, filters?: SearchFilters, userId: string = '00000000-0000-0000-0000-000000000001') {
  // Always filter by user_id
  builder = builder.eq('user_id', userId);

  if (!filters) return builder;

  // File type filter (path prefix)
  if (filters.file_type) {
    builder = builder.like('path', `${filters.file_type}/%`);
  }

  // Tag filter (array contains ANY of provided tags)
  // Use overlaps for JSONB array: checks if any tag in filters matches any tag in frontmatter
  if (filters.tags && filters.tags.length > 0) {
    builder = builder.overlaps('frontmatter->tags', filters.tags);
  }

  // Author filter (author field OR guests array)
  if (filters.author) {
    // Use .or() with proper PostgREST filter syntax
    builder = builder.or(
      `frontmatter->>author.eq.${filters.author},frontmatter->guests.cs.{${filters.author}}`
    );
  }

  // Source type filter (library only)
  if (filters.source) {
    builder = builder.like('path', 'library/%');
    builder = builder.eq('frontmatter->>source_type', filters.source);
  }

  // Date range filters
  if (filters.after || filters.before) {
    // For library files, prefer published_date if available, otherwise use created_at
    // For other files, always use created_at
    const isLibrary = filters.file_type === 'library' ||
                      (filters.source !== undefined); // source filter implies library

    if (isLibrary) {
      // For library files: use published_date when filtering by date
      if (filters.after) {
        builder = builder.gte('frontmatter->>published_date', filters.after);
      }
      if (filters.before) {
        builder = builder.lte('frontmatter->>published_date', filters.before);
      }
    } else {
      // For non-library files: use created_at
      if (filters.after) {
        builder = builder.gte('created_at', filters.after);
      }
      if (filters.before) {
        builder = builder.lte('created_at', filters.before);
      }
    }
  }

  return builder;
}

/**
 * Decode HTML entities in text
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

/**
 * Extract snippet from content (300 chars around match or first 300 chars)
 */
function extractSnippet(content: string, query?: string): string {
  if (!content) return '';

  // Decode HTML entities first
  const decoded = decodeHtmlEntities(content);
  const maxLength = 300;  // Increased from 150 for better context

  if (!query) {
    return decoded.substring(0, maxLength) + (decoded.length > maxLength ? '...' : '');
  }

  // Find first occurrence of any query term (case-insensitive)
  const terms = query.toLowerCase().split(/\s+/);
  const contentLower = decoded.toLowerCase();

  let earliestMatch = -1;
  for (const term of terms) {
    const index = contentLower.indexOf(term);
    if (index !== -1 && (earliestMatch === -1 || index < earliestMatch)) {
      earliestMatch = index;
    }
  }

  if (earliestMatch === -1) {
    // No match found, return first 300 chars
    return decoded.substring(0, maxLength) + (decoded.length > maxLength ? '...' : '');
  }

  // Extract ~300 chars centered on match
  const start = Math.max(0, earliestMatch - 100);
  const end = Math.min(decoded.length, start + maxLength);
  const snippet = decoded.substring(start, end);

  return (start > 0 ? '...' : '') + snippet + (end < decoded.length ? '...' : '');
}

/**
 * Hybrid search with filters (when query provided)
 */
async function hybridSearchWithFilters(
  query: string,
  limit: number,
  filters?: SearchFilters
): Promise<SearchResult[]> {
  // People search pattern: add author to query for body text matching
  let searchQuery = query;
  if (filters?.author) {
    searchQuery = `${query} ${filters.author}`;
    console.log(`[Hybrid] Added author to query: "${searchQuery}"`);
  }

  // Generate query embedding for semantic search
  let queryEmbedding: number[] | null = null;
  if (isEmbeddingAvailable()) {
    try {
      console.log('[Hybrid] Generating query embedding...');
      queryEmbedding = await generateEmbedding(searchQuery);
      console.log('[Hybrid] Embedding generated successfully');
    } catch (err) {
      console.warn('[Hybrid] Failed to generate query embedding, falling back to keyword-only:', err);
    }
  } else {
    console.log('[Hybrid] Embeddings not available, using keyword-only search');
  }

  // Call hybrid_search_chunked RPC
  // Note: RPC doesn't support filters directly, so we'll filter results afterward
  console.log(`[Hybrid] Calling hybrid_search_chunked RPC (match_count: ${limit * 3})`);
  const { data, error } = await supabase.rpc('hybrid_search_chunked', {
    query_text: searchQuery,
    query_embedding: queryEmbedding,
    p_user_id: '00000000-0000-0000-0000-000000000001',
    match_count: limit * 3,  // Fetch more to account for filtering
    content_type: null
  });

  if (error) {
    console.error('[Hybrid] RPC error:', error);
    throw new Error(`Hybrid search RPC failed: ${error.message}`);
  }

  console.log(`[Hybrid] RPC returned ${data?.length || 0} results`);

  if (!data || data.length === 0) {
    return [];
  }

  // Fetch file metadata for filtering and tags
  const filePaths = data.map((r: { path: string }) => r.path);
  let query_builder = supabase
    .from('files')
    .select('path, frontmatter, created_at, body')
    .in('path', filePaths);

  // Apply filters to metadata fetch
  query_builder = buildFilters(query_builder, filters);

  const { data: filesMetadata, error: metaError } = await query_builder;

  if (metaError) {
    throw new Error(`Failed to fetch metadata: ${metaError.message}`);
  }

  // Create map of filtered files
  const metadataMap = new Map(
    (filesMetadata || []).map((f: any) => [f.path, f])
  );

  // Filter and format results
  const results = data
    .filter((result: { path: string }) => metadataMap.has(result.path))
    .slice(0, limit)
    .map((result: { path: string; snippet: string | null; score: number }) => {
      const metadata = metadataMap.get(result.path);

      return {
        path: result.path,
        snippet: result.snippet || extractSnippet(metadata?.body || '', query),
        tags: metadata?.frontmatter?.tags || [],
        updated_at: metadata?.created_at || new Date().toISOString(),
        score: result.score
      };
    });

  return results;
}

/**
 * Filtered browse (no query, just filters)
 */
async function filteredBrowse(
  limit: number,
  filters?: SearchFilters
): Promise<SearchResult[]> {
  let query_builder = supabase
    .from('files')
    .select('path, frontmatter, created_at, body')
    .order('created_at', { ascending: false })
    .limit(limit);

  // Apply filters
  query_builder = buildFilters(query_builder, filters);

  const { data, error } = await query_builder;

  if (error) {
    throw new Error(`Filtered browse failed: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return [];
  }

  // Format results (no scores for browse)
  return data.map((file: any) => ({
    path: file.path,
    snippet: extractSnippet(file.body || ''),
    tags: file.frontmatter?.tags || [],
    updated_at: file.created_at || new Date().toISOString(),
    score: undefined
  }));
}

/**
 * MCP tool handler for search_notes
 */
export async function searchNotesTool(args: {
  query?: string;
  limit?: number;
  file_type?: 'library' | 'learnings' | 'daily' | 'mocs';
  tags?: string[];
  author?: string;
  source?: 'youtube' | 'article' | 'pdf';
  after?: string;
  before?: string;
}): Promise<string> {
  const { query, limit, file_type, tags, author, source, after, before } = args;
  const logs: string[] = [];

  try {
    logs.push(`[Search] Query: "${query || 'none'}", Limit: ${limit || 10}`);

    // Build filters
    const filters: SearchFilters = {};
    if (file_type) filters.file_type = file_type;
    if (tags && tags.length > 0) filters.tags = tags;
    if (author) filters.author = author;
    if (source) filters.source = source;
    if (after) filters.after = after;
    if (before) filters.before = before;

    if (Object.keys(filters).length > 0) {
      logs.push(`[Search] Filters: ${JSON.stringify(filters)}`);
    }

    logs.push(`[Search] Embeddings available: ${isEmbeddingAvailable()}`);
    logs.push(`[Search] Mode: ${query ? 'hybrid search' : 'filtered browse'}`);

    const results = await searchNotes(query || null, limit, filters);

    logs.push(`[Search] Results: ${results.length} files found`);

    if (results.length === 0) {
      const filterDesc = Object.keys(filters).length > 0 ? ' with applied filters' : '';
      const debugInfo = `\n\n--- Debug Info ---\n${logs.join('\n')}`;
      return query
        ? `No files found matching query: "${query}"${filterDesc}${debugInfo}`
        : `No files found${filterDesc}${debugInfo}`;
    }

    // Format results as readable text
    const formattedResults = results.map((result, index) => {
      const tagsStr = result.tags.length > 0 ? ` [${result.tags.join(', ')}]` : '';
      const scoreStr = result.score !== undefined ? ` (score: ${result.score.toFixed(3)})` : '';
      return `${index + 1}. ${result.path}${tagsStr}${scoreStr}
   Updated: ${new Date(result.updated_at).toLocaleDateString()}
   ${result.snippet}`;
    }).join('\n\n');

    const modeDesc = query ? 'search' : 'browse';
    const debugInfo = `\n\n--- Debug Info ---\n${logs.join('\n')}`;
    const readHint = results.length > 0 ? `\n\n💡 Use read_note tool with path to see full content of any result.` : '';
    return `Found ${results.length} result${results.length === 1 ? '' : 's'} (${modeDesc}):\n\n${formattedResults}${readHint}${debugInfo}`;
  } catch (error) {
    logs.push(`[Search] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    const debugInfo = `\n--- Debug Info ---\n${logs.join('\n')}`;
    throw new Error(`Search failed${debugInfo}`);
  }
}

/**
 * Tool definition for MCP registration
 */
export const searchNotesToolDef = {
  name: 'search_notes',
  description: 'Search vault content using hybrid keyword + semantic search with advanced filters. Can search with query (hybrid keyword + semantic) or browse by filters only. People search: pass name to both author and query for BY + ABOUT results.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (keywords or natural language). Optional - can filter without query for filtered browse.'
      },
      file_type: {
        type: 'string',
        enum: ['library', 'learnings', 'daily', 'mocs'],
        description: 'Filter by file location'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by tags (OR within array)'
      },
      author: {
        type: 'string',
        description: 'Filter by author name (matches author field OR guests array). For people search, also add to query.'
      },
      source: {
        type: 'string',
        enum: ['youtube', 'article', 'pdf'],
        description: 'Filter by source type (library files only)'
      },
      after: {
        type: 'string',
        description: 'Filter by date after (YYYY-MM-DD, uses published_date for library, created_at for others)'
      },
      before: {
        type: 'string',
        description: 'Filter by date before (YYYY-MM-DD)'
      },
      limit: {
        type: 'number',
        description: 'Max results (1-20, default 10)'
      }
    },
    required: []
  }
};
