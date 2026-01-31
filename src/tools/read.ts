/**
 * Read Note - Retrieve full file contents by path with optional search
 *
 * Provides exact path lookup for viewing vault files from mobile.
 * Optional search parameter filters to relevant sections in large files.
 */

import { supabase } from '../services/vault-client.js';
import yaml from 'js-yaml';
import { generateEmbedding, isEmbeddingAvailable } from '../services/embeddings.js';

interface FileData {
  path: string;
  body: string;
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
    // Query files for exact path match
    const { data, error } = await supabase
      .from('files')
      .select('path, body, frontmatter, updated_at')
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
 * Search within file content using simple text matching (for small files)
 */
function grepInFile(fileData: FileData, searchQuery: string): string {
  const lines = fileData.body.split('\n');
  const searchLower = searchQuery.toLowerCase();
  const matches: { lineNum: number; line: string; context: string[] }[] = [];

  // Find all matching lines with context
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(searchLower)) {
      const contextBefore = lines.slice(Math.max(0, i - 2), i);
      const contextAfter = lines.slice(i + 1, Math.min(lines.length, i + 3));
      matches.push({
        lineNum: i + 1,
        line: lines[i],
        context: [...contextBefore, lines[i], ...contextAfter]
      });
    }
  }

  if (matches.length === 0) {
    return `No matches found for "${searchQuery}" in ${fileData.path}`;
  }

  // Format output
  let output = `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${searchQuery}" in ${fileData.path}:\n\n`;

  matches.slice(0, 10).forEach((match, idx) => {
    output += `--- Match ${idx + 1} (line ${match.lineNum}) ---\n`;
    output += match.context.join('\n');
    output += '\n\n';
  });

  if (matches.length > 10) {
    output += `... and ${matches.length - 10} more matches\n`;
  }

  return output;
}

/**
 * Search within file chunks using semantic + keyword search (for large files)
 */
async function searchInChunks(filePath: string, searchQuery: string): Promise<string> {
  // Generate query embedding if available
  let queryEmbedding: number[] | null = null;
  if (isEmbeddingAvailable()) {
    try {
      queryEmbedding = await generateEmbedding(searchQuery);
    } catch (err) {
      console.warn('[ReadNote] Failed to generate embedding, using keyword-only:', err);
    }
  }

  // Get file ID
  const { data: fileData, error: fileError } = await supabase
    .from('files')
    .select('id, path')
    .eq('path', filePath)
    .single();

  if (fileError || !fileData) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Search chunks for this specific file
  const searchLower = searchQuery.toLowerCase();

  // Keyword search in chunks
  const { data: keywordChunks, error: kwError } = await supabase
    .from('file_chunks')
    .select('chunk_index, chunk_text')
    .eq('file_id', fileData.id)
    .ilike('chunk_text', `%${searchQuery}%`)
    .limit(5);

  if (kwError) {
    throw new Error(`Keyword search failed: ${kwError.message}`);
  }

  let results = keywordChunks || [];

  // Semantic search in chunks (if embedding available)
  if (queryEmbedding) {
    const { data: semanticChunks, error: semError } = await supabase
      .from('file_chunks')
      .select('chunk_index, chunk_text, embedding')
      .eq('file_id', fileData.id)
      .not('embedding', 'is', null)
      .limit(5);

    if (!semError && semanticChunks) {
      // Calculate cosine similarity for each chunk
      const scoredChunks = semanticChunks.map(chunk => {
        const similarity = cosineSimilarity(queryEmbedding!, chunk.embedding);
        return { ...chunk, score: similarity };
      });

      // Merge with keyword results (deduplicate by chunk_index)
      const keywordIndices = new Set(results.map(r => r.chunk_index));
      scoredChunks
        .filter(c => !keywordIndices.has(c.chunk_index))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .forEach(c => results.push(c));
    }
  }

  if (results.length === 0) {
    return `No matches found for "${searchQuery}" in ${filePath}\n\n💡 Try different keywords or read the full file.`;
  }

  // Format output
  let output = `Found ${results.length} relevant section${results.length === 1 ? '' : 's'} for "${searchQuery}" in ${filePath}:\n\n`;

  results.slice(0, 5).forEach((chunk, idx) => {
    output += `--- Section ${idx + 1} (chunk ${chunk.chunk_index}) ---\n`;
    output += chunk.chunk_text;
    output += '\n\n';
  });

  return output;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * MCP tool handler for read_note
 */
export async function readNoteTool(args: {
  path: string;
  search?: string;
}): Promise<string> {
  const { path, search } = args;

  const fileData = await readNote(path);

  if (!fileData) {
    return `File not found: ${path}`;
  }

  const body = fileData.body || '';
  const bodyLength = body.length;
  const maxBodyLength = 50000; // ~50k chars for mobile context

  // Search mode: filter to relevant sections
  if (search) {
    if (bodyLength < maxBodyLength) {
      // Small file: use simple grep
      return grepInFile(fileData, search);
    } else {
      // Large file: use semantic chunk search
      return await searchInChunks(path, search);
    }
  }

  // Read mode: return full file with smart truncation
  let output = '';

  if (fileData.frontmatter && Object.keys(fileData.frontmatter).length > 0) {
    output += '---\n';
    output += formatFrontmatter(fileData.frontmatter);
    output += '\n---\n\n';
  }

  // Smart truncation for large files
  if (bodyLength > maxBodyLength) {
    output += body.substring(0, maxBodyLength);
    output += `\n\n--- Content Truncated ---\n`;
    output += `Total: ${bodyLength.toLocaleString()} chars, showing first ${maxBodyLength.toLocaleString()} chars\n`;
    output += `💡 Use read_note with search parameter to find specific sections:\n`;
    output += `   read_note(path: "${path}", search: "your keywords")`;
  } else {
    output += body;
  }

  // Add metadata footer
  const updatedDate = new Date(fileData.updated_at).toLocaleString();
  output += `\n\n---\nPath: ${fileData.path}\nLast updated: ${updatedDate}`;

  return output;
}
