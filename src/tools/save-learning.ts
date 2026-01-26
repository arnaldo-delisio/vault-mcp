/**
 * save_learning Tool - Save user synthesis to vault
 *
 * Persists user's synthesis/learnings with:
 * - Strict frontmatter validation (title, tags, source required)
 * - Embedding generation for semantic search
 * - Slug-based path generation (learnings/{slug}.md)
 */

import { createHash } from 'crypto';
import matter from 'gray-matter';
import { generateChunkedEmbeddings, isEmbeddingAvailable } from '../services/embeddings.js';
import { supabase } from '../services/vault-client.js';

interface SaveResult {
  success: boolean;
  path?: string;
  message: string;
  error?: string;
}

interface Frontmatter {
  title: string;
  tags: string[];
  source: string;
  created_at?: string;
  type?: string;
  [key: string]: unknown;
}

/**
 * Save a synthesis to the vault
 */
export async function saveLearningTool(args: { synthesis: string }): Promise<SaveResult> {
  const { synthesis } = args;

  if (!synthesis || typeof synthesis !== 'string') {
    return {
      success: false,
      message: 'Invalid synthesis parameter',
      error: 'Synthesis must be a non-empty string with YAML frontmatter'
    };
  }

  // Parse synthesis with gray-matter
  let parsed;
  try {
    parsed = matter(synthesis);
  } catch (error) {
    return {
      success: false,
      message: 'Failed to parse frontmatter',
      error: error instanceof Error ? error.message : 'Invalid YAML frontmatter'
    };
  }

  const fm = parsed.data as Partial<Frontmatter>;
  const body = parsed.content.trim();

  // Validate required frontmatter fields (STRICT per CONTEXT.md)
  const required = ['title', 'tags', 'source'] as const;
  const missing = required.filter(f => !fm[f]);

  if (missing.length > 0) {
    return {
      success: false,
      message: `Missing required frontmatter: ${missing.join(', ')}`,
      error: 'Synthesis must include frontmatter with title, tags, and source fields'
    };
  }

  // Validate tags is an array
  if (!Array.isArray(fm.tags)) {
    return {
      success: false,
      message: 'Invalid tags format',
      error: 'Tags must be an array of strings'
    };
  }

  // Validate body is not empty
  if (!body) {
    return {
      success: false,
      message: 'Empty synthesis body',
      error: 'Synthesis must include content after the frontmatter'
    };
  }

  // Generate slug from title
  const slug = fm.title!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  const path = `learnings/${slug}.md`;

  // Add default frontmatter fields
  const frontmatter: Frontmatter = {
    ...fm as Frontmatter,
    created_at: fm.created_at || new Date().toISOString(),
    type: fm.type || 'learning'
  };

  // Generate chunked embeddings for semantic search
  let chunks = null;
  if (isEmbeddingAvailable()) {
    try {
      chunks = await generateChunkedEmbeddings(body);
    } catch (error) {
      console.warn('Failed to generate embeddings:', error);
      // Continue without embeddings - can be generated later
    }
  }

  // Build content hash
  const contentHash = createHash('sha256')
    .update(synthesis)
    .digest('hex');

  const userId = '00000000-0000-0000-0000-000000000001'; // Single-user system

  // Save to database
  try {
    // Insert file record
    const { data: fileData, error: fileError } = await supabase
      .from('files')
      .insert({
        path,
        body,
        frontmatter,
        embedding: null, // Deprecated: chunks stored in file_chunks table
        content_hash: contentHash,
        user_id: userId
      })
      .select('id')
      .single();

    if (fileError || !fileData) {
      // Check for duplicate path
      if (fileError?.code === '23505') {
        return {
          success: false,
          message: 'A learning with this title already exists',
          error: `File already exists at ${path}. Use a different title.`
        };
      }
      return {
        success: false,
        message: 'Database error',
        error: fileError?.message || 'No file data returned'
      };
    }

    // Save chunks to file_chunks table if embeddings available
    if (chunks && chunks.length > 0) {
      const { error: chunksError } = await supabase
        .from('file_chunks')
        .insert(
          chunks.map(c => ({
            file_id: fileData.id,
            chunk_index: c.chunk_index,
            chunk_text: c.chunk_text,
            embedding: c.embedding
          }))
        );

      if (chunksError) {
        // Non-fatal: file saved, but chunks failed
        // Search will still work via keyword search, just no semantic search
        console.error('Failed to save file chunks:', chunksError);
      }
    }

    return {
      success: true,
      path,
      message: `Learning saved to ${path}`
    };

  } catch (error) {
    return {
      success: false,
      message: 'Failed to save learning',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Tool definition for MCP registration
 */
export const saveLearningToolDef = {
  name: 'save_learning',
  description: 'Save a synthesis to the vault. Requires frontmatter with title, tags, and source fields. Generates embedding for semantic search.',
  inputSchema: {
    type: 'object',
    properties: {
      synthesis: {
        type: 'string',
        description: 'Markdown content with YAML frontmatter containing title, tags, and source'
      }
    },
    required: ['synthesis']
  }
};
