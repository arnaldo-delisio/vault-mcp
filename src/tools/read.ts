/**
 * Read Note - Retrieve full file contents by path
 *
 * Provides exact path lookup for viewing vault files from mobile.
 */

import { supabase } from '../services/vault-client.js';
import yaml from 'js-yaml';

interface FileData {
  path: string;
  content: string;
  frontmatter: Record<string, any> | null;
  updated_at: string;
}

/**
 * Read a single vault file by exact path match
 */
async function readNote(path: string): Promise<FileData | null> {
  if (!path || typeof path !== 'string') {
    throw new Error('Invalid path parameter: must be a non-empty string');
  }

  try {
    // Query vault_files for exact path match
    const { data, error } = await supabase
      .from('files')
      .select('path, content, frontmatter, updated_at')
      .eq('path', path)
      .single();

    if (error) {
      // Handle not found vs other errors
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Database query failed: ${error.message}`);
    }

    return data;
  } catch (error) {
    throw new Error(`Read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Format frontmatter as YAML string
 */
function formatFrontmatter(frontmatter: Record<string, any> | null): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return '';
  }

  try {
    return yaml.dump(frontmatter, {
      indent: 2,
      lineWidth: -1, // Don't wrap lines
      noRefs: true
    }).trim();
  } catch (error) {
    return JSON.stringify(frontmatter, null, 2);
  }
}

/**
 * MCP tool handler for read_note
 */
export async function readNoteTool(args: { path: string }): Promise<string> {
  const { path } = args;

  const fileData = await readNote(path);

  if (!fileData) {
    return `File not found: ${path}`;
  }

  // Format output with frontmatter, separator, content
  let output = '';

  if (fileData.frontmatter && Object.keys(fileData.frontmatter).length > 0) {
    output += '---\n';
    output += formatFrontmatter(fileData.frontmatter);
    output += '\n---\n\n';
  }

  output += fileData.content || '';

  // Add metadata footer
  const updatedDate = new Date(fileData.updated_at).toLocaleString();
  output += `\n\n---\nPath: ${fileData.path}\nLast updated: ${updatedDate}`;

  return output;
}
