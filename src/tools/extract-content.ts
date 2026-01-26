/**
 * extract_content Tool - Extract content from URLs and save to library
 *
 * Replaces synthesize_content's extraction stage with:
 * - Deduplication (returns cached result if exists)
 * - Library storage (library/youtube/{videoId}.md)
 * - Embedding generation for semantic search
 *
 * Non-YouTube URLs delegate to WebFetch tool.
 */

import { createHash } from 'crypto';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { YouTubeExtractor } from '../services/extractors/youtube-extractor.js';
import { ArticleExtractor } from '../services/extractors/article-extractor.js';
import { GeminiExtractor } from '../services/extractors/gemini-extractor.js';
import { isEmbeddingAvailable } from '../services/embeddings.js';
import { processInlineIfSmall } from '../services/background-embeddings.js';
import { supabase } from '../services/vault-client.js';

interface ExtractResult {
  success: boolean;
  stage: 'cached' | 'extracted' | 'delegate';
  path?: string;
  preview?: string;
  metadata?: Record<string, unknown>;
  tokenCount?: number;
  chunks_status?: string;
  message: string;
  error?: string;
}

/**
 * Extract content from a URL or PDF file and save to library
 */
export async function extractContentTool(args: {
  url?: string;
  file?: string;
  fileName?: string;
}): Promise<ExtractResult> {
  const { url, file, fileName } = args;

  // Validate input: must have either url or (file + fileName)
  if (!url && !file) {
    return {
      success: false,
      stage: 'delegate',
      message: 'Invalid parameters',
      error: 'Must provide either url or file parameter'
    };
  }

  if (file && !fileName) {
    return {
      success: false,
      stage: 'delegate',
      message: 'Invalid parameters',
      error: 'fileName is required when providing file'
    };
  }

  // Handle PDF file upload
  if (file && fileName) {
    return await handlePdfFile(file, fileName);
  }

  // Handle URL extraction
  if (!url || typeof url !== 'string') {
    return {
      success: false,
      stage: 'delegate',
      message: 'Invalid URL parameter',
      error: 'URL must be a non-empty string'
    };
  }

  // Check if YouTube URL - capture video ID only (stop at & or ? or whitespace)
  const youtubeMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?\s]+)/);

  if (youtubeMatch) {
    const videoId = youtubeMatch[1];
    const libraryPath = `library/youtube/${videoId}.md`;

    // Check for existing extraction (deduplication)
    const { data: existing } = await supabase
      .from('files')
      .select('path, frontmatter, body')
      .eq('path', libraryPath)
      .single();

    if (existing) {
      return {
        success: true,
        stage: 'cached',
        path: existing.path,
        preview: existing.body?.slice(0, 5000),
        metadata: existing.frontmatter as Record<string, unknown>,
        message: 'Content already extracted. Use save_learning to save synthesis.'
      };
    }

    // Extract with YouTubeExtractor
    try {
      const extractor = new YouTubeExtractor();
      const transcript = await extractor.getTranscript(videoId);

      // Build frontmatter per CONTEXT.md spec
      const frontmatter = {
        type: 'transcript',
        source_url: transcript.videoUrl,
        source_title: transcript.title,
        source_author: transcript.author,
        source_duration_minutes: transcript.duration
          ? Math.floor(transcript.duration / 60)
          : undefined,
        video_id: videoId,
        extracted_at: new Date().toISOString(),
        tags: ['transcript', 'youtube']
      };

      // Build content hash
      const contentHash = createHash('sha256')
        .update(transcript.fullText)
        .digest('hex');

      const userId = '00000000-0000-0000-0000-000000000001'; // Single-user system

      // Level 1: Save file immediately with pending status (always instant return)
      const { data: fileData, error: upsertError } = await supabase
        .from('files')
        .upsert({
          path: libraryPath,
          body: transcript.fullText,
          frontmatter,
          embedding: null, // Deprecated: chunks stored in file_chunks table
          content_hash: contentHash,
          user_id: userId,
          chunks_status: 'pending' // Start as pending
        }, { onConflict: 'user_id,path' })
        .select('id')
        .single();

      if (upsertError || !fileData) {
        return {
          success: false,
          stage: 'extracted',
          message: 'Extraction succeeded but file save failed',
          error: upsertError?.message || 'No file data returned'
        };
      }

      // Level 2: Try inline processing for small files (non-blocking)
      let chunksStatus = 'pending';
      if (isEmbeddingAvailable()) {
        const result = await processInlineIfSmall(fileData.id, transcript.fullText);
        chunksStatus = result.chunks_status;
      }
      // If not processed inline, Level 3 (Edge Function) will pick it up
      // Level 4 (startup processor) is safety net

      // Generate preview - smart sampling for long transcripts
      const preview = generatePreview(transcript.fullText);

      return {
        success: true,
        stage: 'extracted',
        path: libraryPath,
        preview,
        metadata: frontmatter,
        chunks_status: chunksStatus,
        message: chunksStatus === 'complete'
          ? 'Content extracted with instant semantic search.'
          : 'Content extracted. Semantic search processing in background.'
      };

    } catch (error) {
      return {
        success: false,
        stage: 'extracted',
        message: 'YouTube extraction failed',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // Non-YouTube URLs: delegate to WebFetch
  return {
    success: true,
    stage: 'delegate',
    message: 'Use WebFetch to extract content from this URL, then call save_learning with the synthesis.'
  };
}

/**
 * Handle PDF file extraction
 */
async function handlePdfFile(
  base64Content: string,
  fileName: string
): Promise<ExtractResult> {
  // Generate slug from filename for library path
  const slug = fileName
    .replace(/\.pdf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const libraryPath = `library/pdf/${slug}.md`;

  // Check for existing extraction (deduplication)
  const { data: existing } = await supabase
    .from('files')
    .select('path, frontmatter, body')
    .eq('path', libraryPath)
    .single();

  if (existing) {
    return {
      success: true,
      stage: 'cached',
      path: existing.path,
      preview: existing.body?.slice(0, 5000),
      metadata: existing.frontmatter as Record<string, unknown>,
      message: 'PDF already extracted. Use save_learning to save synthesis.'
    };
  }

  // Extract with GeminiExtractor
  let tempPath: string | null = null;
  try {
    // Create temp directory and write PDF
    const tempDir = mkdtempSync(join(tmpdir(), 'pdf-extract-'));
    tempPath = join(tempDir, fileName);
    const pdfBuffer = Buffer.from(base64Content, 'base64');
    writeFileSync(tempPath, pdfBuffer);

    // Extract content
    const extractor = new GeminiExtractor();
    const result = await extractor.extractFromFile(tempPath, fileName);

    // Build frontmatter per CONTEXT.md spec
    const frontmatter = {
      type: 'pdf',
      title: result.title,
      author: result.author,
      published_date: result.publishedDate,
      page_count: result.pageCount,
      file_size_bytes: result.fileSize,
      word_count: result.wordCount,
      original_filename: result.originalFileName,
      extracted_at: new Date().toISOString(),
      tags: ['pdf', 'document']
    };

    // Build content hash
    const contentHash = createHash('sha256')
      .update(result.content)
      .digest('hex');

    const userId = '00000000-0000-0000-0000-000000000001'; // Single-user system

    // Level 1: Save file immediately with pending status (always instant return)
    const { data: fileData, error: upsertError } = await supabase
      .from('files')
      .upsert({
        path: libraryPath,
        body: result.content,
        frontmatter,
        embedding: null, // Deprecated: chunks stored in file_chunks table
        content_hash: contentHash,
        user_id: userId,
        chunks_status: 'pending' // Start as pending
      }, { onConflict: 'user_id,path' })
      .select('id')
      .single();

    if (upsertError || !fileData) {
      return {
        success: false,
        stage: 'extracted',
        message: 'Extraction succeeded but file save failed',
        error: upsertError?.message || 'No file data returned'
      };
    }

    // Level 2: Try inline processing for small files (non-blocking)
    let chunksStatus = 'pending';
    if (isEmbeddingAvailable()) {
      const embeddingResult = await processInlineIfSmall(fileData.id, result.content);
      chunksStatus = embeddingResult.chunks_status;
    }
    // If not processed inline, Level 3 (Edge Function) will pick it up
    // Level 4 (startup processor) is safety net

    // Generate preview
    const preview = generatePreview(result.content);

    return {
      success: true,
      stage: 'extracted',
      path: libraryPath,
      preview,
      metadata: frontmatter,
      chunks_status: chunksStatus,
      message: chunksStatus === 'complete'
        ? 'PDF extracted with instant semantic search.'
        : 'PDF extracted. Semantic search processing in background.'
    };

  } catch (error) {
    return {
      success: false,
      stage: 'extracted',
      message: 'PDF extraction failed',
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    // Clean up temp file
    if (tempPath) {
      try {
        unlinkSync(tempPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Generate smart preview for transcript
 * Samples intro + middle + end for context
 */
function generatePreview(text: string, maxLength: number = 5000): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Sample: first 2000 chars + middle 1500 chars + last 1500 chars
  const intro = text.slice(0, 2000);
  const middleStart = Math.floor(text.length / 2) - 750;
  const middle = text.slice(middleStart, middleStart + 1500);
  const outro = text.slice(-1500);

  return `${intro}\n\n[... content continues ...]\n\n${middle}\n\n[... content continues ...]\n\n${outro}`;
}

/**
 * Tool definition for MCP registration
 */
export const extractContentToolDef = {
  name: 'extract_content',
  description: 'Extract content from a URL (YouTube video) or PDF file and save to library. Returns preview and path. For non-YouTube URLs, use WebFetch tool directly then save_learning.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to extract content from (YouTube video URL)'
      },
      file: {
        type: 'string',
        description: 'Base64-encoded PDF file content (alternative to url)'
      },
      fileName: {
        type: 'string',
        description: 'Original filename (required when file parameter is provided)'
      }
    },
    oneOf: [
      { required: ['url'] },
      { required: ['file', 'fileName'] }
    ]
  }
};
