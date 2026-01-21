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

      // Check if transcript was written to file (large transcript case)
      if (extracted.filePath) {
        // Large transcript - return preview with metadata and instructions
        let response = `# ${extracted.metadata?.title || 'YouTube Video'}\n\n`;
        if (extracted.metadata) {
          response += `**Author:** ${extracted.metadata.author}\n`;
          response += `**Duration:** ${Math.floor((extracted.metadata.duration || 0) / 60)} minutes\n`;
          response += `**URL:** ${extracted.metadata.url}\n\n`;
        }
        response += `**Preview** (first ~1500 tokens):\n\n${extracted.content}\n\n`;
        response += `---\n\n${extracted.instructions}`;

        return {
          success: true,
          stage: 'extraction',
          contentType: extracted.type,
          content: [{ type: 'text' as const, text: response }]
        };
      }

      // Small transcript or article - return inline with metadata if available
      let response = '';
      if (extracted.metadata?.title) {
        response = `# ${extracted.metadata.title}\n\n`;
        if (extracted.metadata.author) {
          response += `**Author:** ${extracted.metadata.author}\n`;
        }
        if (extracted.metadata.duration) {
          response += `**Duration:** ${Math.floor(extracted.metadata.duration / 60)} minutes\n`;
        }
        if (extracted.metadata.url) {
          response += `**URL:** ${extracted.metadata.url}\n\n`;
        }
        response += `**Transcript:**\n\n${extracted.content}\n\n`;
      } else {
        response = extracted.content + '\n\n';
      }
      response += `Ask clarifying questions, then call synthesize_content again with synthesis parameter.`;

      return {
        success: true,
        stage: 'extraction',
        contentType: extracted.type,
        content: [{ type: 'text' as const, text: response }]
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
    // Re-extract content to get metadata (cached/fast if recently extracted)
    const extracted = await extractContent(url);

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

    // Add source metadata if available
    if (extracted.metadata) {
      if (extracted.metadata.title && !frontmatter.source_title) {
        frontmatter.source_title = extracted.metadata.title;
      }
      if (extracted.metadata.author && !frontmatter.source_author) {
        frontmatter.source_author = extracted.metadata.author;
      }
      if (extracted.metadata.duration && !frontmatter.source_duration_minutes) {
        frontmatter.source_duration_minutes = Math.floor(extracted.metadata.duration / 60);
      }
    }

    // Generate slug from source URL for filename
    // Use video ID or metadata title for better slugs
    let slug: string;
    if (extracted.metadata?.videoId) {
      slug = `youtube-${extracted.metadata.videoId}`;
    } else if (extracted.metadata?.title) {
      // Sanitize title for filename
      slug = extracted.metadata.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50);
    } else {
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
