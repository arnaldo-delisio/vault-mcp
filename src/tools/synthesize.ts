import { extractContent } from '../services/content-extract.js';
import { supabase } from '../services/vault-client.js';
import matter from 'gray-matter';
import { createHash } from 'crypto';

/**
 * synthesize_content tool implementation
 *
 * Multi-turn conversation flow:
 * 1. First call (url only): Extract content, return for Claude to analyze
 * 2. Claude provides insights and asks contextual questions
 * 3. User responds, conversation deepens understanding
 * 4. Final call (url + synthesis): Save synthesized learning to vault
 */

export interface SynthesizeContentArgs {
  url: string;
  synthesis?: string;
}

export async function synthesizeContentTool(args: SynthesizeContentArgs) {
  const { url, synthesis } = args;

  // Step 1: Content extraction (first call - url only, no synthesis)
  if (!synthesis || synthesis.trim().length === 0) {
    try {
      const extracted = await extractContent(url);

      // Return content with instructions for Claude to provide insights and ask questions
      return {
        success: true,
        stage: 'extraction',
        contentType: extracted.type,
        content: extracted.content,
        instructions: 'Provide 3-5 key insights from this content, then ask at least one contextual question to understand the user\'s perspective before synthesizing (e.g., "How does this relate to your work?", "What aspect interests you most?", "What problem are you trying to solve?").'
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to extract content from URL'
      };
    }
  }

  // Step 2: Synthesis save (final call - url + synthesis markdown provided)
  try {
    // Parse frontmatter from synthesis markdown
    const parsed = matter(synthesis);
    const frontmatter = parsed.data;
    const content_body = parsed.content;

    // Ensure required frontmatter fields exist
    if (!frontmatter.created_at) {
      frontmatter.created_at = new Date().toISOString();
    }
    if (!frontmatter.source_url) {
      frontmatter.source_url = url;
    }
    if (!frontmatter.type) {
      frontmatter.type = 'learning';
    }
    if (!frontmatter.tags || !Array.isArray(frontmatter.tags)) {
      frontmatter.tags = [];
    }

    // Generate slug from source URL for filename
    // Extract domain or video ID for more meaningful filenames
    let slug: string;
    const youtubeMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&]+)/);
    if (youtubeMatch) {
      slug = `youtube-${youtubeMatch[1]}`;
    } else {
      // Use domain name from URL
      try {
        const urlObj = new URL(url);
        const domain = urlObj.hostname.replace(/^www\./, '').replace(/\./g, '-');
        slug = `${domain}-${Date.now()}`;
      } catch {
        slug = `learning-${Date.now()}`;
      }
    }

    const path = `learnings/${slug}.md`;

    // Calculate content hash for conflict detection (Phase 2 pattern)
    const content_hash = createHash('sha256')
      .update(synthesis)
      .digest('hex');

    // Save to Supabase vault_files table
    const { error } = await supabase
      .from('files')
      .insert({
        path,
        content: synthesis,
        frontmatter, // JSONB column
        content_hash,
        updated_at: new Date().toISOString(),
        user_id: 'authenticated-user' // TODO: Get from OAuth session in future enhancement
      });

    if (error) {
      return {
        success: false,
        error: `Failed to save learning to vault: ${error.message}`
      };
    }

    return {
      success: true,
      stage: 'saved',
      path,
      message: `Learning saved to vault at ${path}`
    };

  } catch (error: any) {
    return {
      success: false,
      error: `Failed to parse or save synthesis: ${error.message}`
    };
  }
}

/**
 * Tool definition for MCP server registration
 */
export const synthesizeContentToolDef = {
  name: 'synthesize_content',
  description: 'Extract content from a URL (YouTube video or web article) and engage in a multi-turn conversation to synthesize key insights. The tool handles extraction, Claude provides insights and asks questions, user provides context, then Claude creates final synthesis saved to vault.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string' as const,
        description: 'URL to extract content from (YouTube video or web article)'
      },
      synthesis: {
        type: 'string' as const,
        description: 'Optional: Final markdown content with frontmatter from Claude after conversation. Omit this parameter on first call to extract content.'
      }
    },
    required: ['url']
  }
};
