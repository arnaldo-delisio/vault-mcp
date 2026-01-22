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
import { generateEmbedding, isEmbeddingAvailable } from '../services/embeddings.js';
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

  // Generate embedding for semantic search
  let embedding: number[] | null = null;
  if (isEmbeddingAvailable()) {
    try {
      embedding = await generateEmbedding(body);
    } catch (error) {
      console.warn('Failed to generate embedding:', error);
      // Continue without embedding - can be generated later
    }
  }

  // Build content hash
  const contentHash = createHash('sha256')
    .update(synthesis)
    .digest('hex');

  // Save to database
  try {
    const { error } = await supabase.from('files').insert({
      path,
      body,
      frontmatter,
      embedding,
      content_hash: contentHash,
      user_id: '00000000-0000-0000-0000-000000000001' // Single-user system
    });

    if (error) {
      // Check for duplicate path
      if (error.code === '23505') {
        return {
          success: false,
          message: 'A learning with this title already exists',
          error: `File already exists at ${path}. Use a different title.`
        };
      }
      return {
        success: false,
        message: 'Database error',
        error: error.message
      };
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
