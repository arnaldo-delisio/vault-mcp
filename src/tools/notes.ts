import { supabase } from '../services/vault-client.js';
import { createDailyFrontmatter, appendToDaily } from '../utils/frontmatter.js';
import matter from 'gray-matter';
import { createHash } from 'crypto';

/**
 * add_note tool implementation
 *
 * Append timestamped notes to today's daily journal file.
 * Creates daily file automatically if it doesn't exist.
 */

export interface AddNoteArgs {
  content: string;
}

export async function addNoteTool(args: AddNoteArgs) {
  const { content } = args;

  try {
    // Get today's date in YYYY-MM-DD format
    const today = new Date().toISOString().split('T')[0];
    const path = `daily/${today}.md`;

    // Query for existing daily file
    const { data: existingFile, error: queryError} = await supabase
      .from('files')
      .select('body, frontmatter')
      .eq('path', path)
      .single();

    if (queryError && queryError.code !== 'PGRST116') {
      // PGRST116 = not found, which is expected for new daily files
      throw queryError;
    }

    const formattedContent = appendToDaily(content);
    const timestamp = formattedContent.match(/## (\d{2}:\d{2})/)?.[1];

    if (existingFile) {
      // File exists - append to existing body
      const newBody = existingFile.body + formattedContent;

      // Reconstruct full file with frontmatter for hash calculation
      const fullContent = matter.stringify(newBody, existingFile.frontmatter);
      const content_hash = createHash('sha256')
        .update(fullContent)
        .digest('hex');

      // Update existing row
      const { error: updateError } = await supabase
        .from('files')
        .update({
          body: newBody,
          content_hash,
          updated_at: new Date().toISOString()
        })
        .eq('path', path);

      if (updateError) {
        throw updateError;
      }

      return {
        success: true,
        action: 'appended',
        path,
        timestamp,
        message: `Note appended to ${path} at ${timestamp}`
      };

    } else {
      // File doesn't exist - create new daily file
      const frontmatter = createDailyFrontmatter();
      const body = formattedContent;

      // Reconstruct full content for hash calculation
      const fullContent = matter.stringify(body, frontmatter);
      const content_hash = createHash('sha256')
        .update(fullContent)
        .digest('hex');

      // Insert new row
      const { error: insertError } = await supabase
        .from('files')
        .insert({
          path,
          body,
          frontmatter, // JSONB column
          content_hash,
          updated_at: new Date().toISOString(),
          user_id: 'authenticated-user' // TODO: Get from OAuth session in future enhancement
        });

      if (insertError) {
        throw insertError;
      }

      return {
        success: true,
        action: 'created',
        path,
        timestamp,
        message: `Daily journal created at ${path} with note at ${timestamp}`
      };
    }

  } catch (error: any) {
    return {
      success: false,
      error: `Failed to add note: ${error.message}`
    };
  }
}

/**
 * Tool definition for MCP server registration
 */
export const addNoteToolDef = {
  name: 'add_note',
  description: 'Append a timestamped note to today\'s daily journal file.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      content: {
        type: 'string' as const,
        description: 'Note content to append'
      }
    },
    required: ['content']
  }
};
