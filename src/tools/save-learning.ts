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
import { isEmbeddingAvailable } from '../services/embeddings.js';
import { processInlineIfSmall } from '../services/background-embeddings.js';
import { supabase } from '../services/vault-client.js';
import { AutoTagger } from '../services/auto-tagger.js';
import { MOCGenerator } from '../services/moc-generator.js';

interface SaveResult {
  success: boolean;
  path?: string;
  chunks_status?: string;
  message: string;
  error?: string;
  awaitingApproval?: boolean;
  newTags?: string[];
  existingTags?: string[];
  retagCount?: number;
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
export async function saveLearningTool(args: {
  synthesis: string;
  approveNewTags?: boolean;
  suggestedNewTags?: string[];
}): Promise<SaveResult> {
  const { synthesis, approveNewTags, suggestedNewTags } = args;

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

  // Auto-tagging: suggest tags from taxonomy
  const autoTagger = new AutoTagger();
  let finalTags = fm.tags as string[];

  // Only run auto-tagging if OpenAI is available
  if (autoTagger.isAvailable()) {
    try {
      const { existingTags, newTags } = await autoTagger.suggestTags(body, fm.title!);

      // Combine user-provided tags with suggested existing tags (deduplicate)
      const allExistingTags = [...new Set([...finalTags, ...existingTags])];

      // If new tags suggested and not yet approved, prompt user
      if (newTags.length > 0 && !approveNewTags) {
        const userId = '00000000-0000-0000-0000-000000000001';
        const retagCount = await autoTagger.countRetagCandidates(newTags, supabase, userId);

        return {
          success: false,
          awaitingApproval: true,
          message: `New tags suggested: ${newTags.join(', ')}. This would re-tag approximately ${retagCount} existing learnings. Do you want to add these tags to the taxonomy?`,
          newTags,
          existingTags: allExistingTags,
          retagCount
        };
      }

      // If approval received, add new tags to taxonomy and include in final tags
      if (approveNewTags && suggestedNewTags && suggestedNewTags.length > 0) {
        await autoTagger.approveTags(suggestedNewTags);
        finalTags = [...new Set([...allExistingTags, ...suggestedNewTags])];

        // Trigger background re-tagging via Edge Function
        const userId = '00000000-0000-0000-0000-000000000001';
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

        if (supabaseUrl && supabaseAnonKey) {
          // Fire and forget - don't wait for completion
          fetch(`${supabaseUrl}/functions/v1/retag-learnings`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${supabaseAnonKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ newTags: suggestedNewTags, userId })
          }).catch(error => {
            console.error('Failed to trigger re-tagging:', error);
          });
        }
      } else {
        // No new tags or approval not needed, just use existing tags
        finalTags = allExistingTags;
      }
    } catch (error) {
      console.error('Auto-tagging failed, using user-provided tags:', error);
      // Graceful degradation: continue with user-provided tags
    }
  }

  // Generate slug from title
  const slug = fm.title!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  const path = `learnings/${slug}.md`;

  // Add default frontmatter fields with final computed tags
  const frontmatter: Frontmatter = {
    ...fm as Frontmatter,
    tags: finalTags, // Use auto-tagged tags
    created_at: fm.created_at || new Date().toISOString(),
    type: fm.type || 'learning'
  };

  // Build content hash
  const contentHash = createHash('sha256')
    .update(synthesis)
    .digest('hex');

  const userId = '00000000-0000-0000-0000-000000000001'; // Single-user system

  // Save to database
  try {
    // Level 1: Save file immediately with pending status
    const { data: fileData, error: fileError } = await supabase
      .from('files')
      .insert({
        path,
        body,
        frontmatter,
        embedding: null, // Deprecated: chunks stored in file_chunks table
        content_hash: contentHash,
        user_id: userId,
        chunks_status: 'pending' // Start as pending
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

    // Level 2: DISABLED - Inline processing causes OOM crashes on Railway
    // Always use Level 3 (Edge Function) for background processing
    let chunksStatus = 'pending';
    // Skip inline processing - embeddings will be ready in ~30s via Edge Function

    // Check MOC threshold after saving
    const mocGenerator = new MOCGenerator(supabase, userId);
    const { shouldGenerate, counts } = await mocGenerator.checkThreshold(finalTags);

    // Generate MOCs for topics that reached threshold
    const generatedMocs: string[] = [];
    for (const topic of shouldGenerate) {
      try {
        await mocGenerator.generateMOC(topic);
        generatedMocs.push(`${topic} (${counts[topic]} learnings)`);
      } catch (error) {
        console.error(`Failed to generate MOC for ${topic}:`, error);
        // Non-fatal: continue even if MOC generation fails
      }
    }

    // Build success message
    let successMessage = chunksStatus === 'complete'
      ? 'Learning saved with instant semantic search.'
      : 'Learning saved. Semantic search processing in background.';

    // Add re-tagging notification if new tags were approved
    if (approveNewTags && suggestedNewTags && suggestedNewTags.length > 0) {
      successMessage += ` Re-tagging existing learnings with new tags in background.`;
    }

    // Add MOC generation notification if any generated
    if (generatedMocs.length > 0) {
      successMessage += ` MOCs created for: ${generatedMocs.join(', ')}. Check mocs/ folder.`;
    }

    return {
      success: true,
      path,
      chunks_status: chunksStatus,
      message: successMessage
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
  description: 'Save a synthesis to the vault. Automatically suggests tags from taxonomy. If new tags are suggested, returns awaitingApproval=true for user to approve. Requires frontmatter with title, tags, and source fields.',
  inputSchema: {
    type: 'object',
    properties: {
      synthesis: {
        type: 'string',
        description: 'Markdown content with YAML frontmatter containing title, tags, and source'
      },
      approveNewTags: {
        type: 'boolean',
        description: 'Set to true to approve and add suggested new tags to taxonomy'
      },
      suggestedNewTags: {
        type: 'array',
        items: { type: 'string' },
        description: 'The new tags to approve (must match tags from previous awaitingApproval response)'
      }
    },
    required: ['synthesis']
  }
};
