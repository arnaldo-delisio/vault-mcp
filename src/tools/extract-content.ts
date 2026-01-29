/**
 * extract_content Tool - Extract content from URLs and save to library
 *
 * Replaces synthesize_content's extraction stage with:
 * - Deduplication (returns cached result if exists)
 * - Library storage (library/youtube/, library/articles/, library/pdf/)
 * - Embedding generation for semantic search
 *
 * Supports YouTube videos, web articles, and PDFs.
 */

import { createHash } from 'crypto';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';
import { YouTubeExtractor } from '../services/extractors/youtube-extractor.js';
import { SupadataExtractor } from '../services/extractors/supadata-extractor.js';
import { ArticleExtractor } from '../services/extractors/article-extractor.js';
import { GeminiExtractor } from '../services/extractors/gemini-extractor.js';
import { isEmbeddingAvailable } from '../services/embeddings.js';
import { processInlineIfSmall } from '../services/background-embeddings.js';
import { supabase } from '../services/vault-client.js';

interface ExtractResult {
  success: boolean;
  stage: 'cached' | 'extracted' | 'delegate' | 'choice_required' | 'queued';
  path?: string;
  preview?: string;
  metadata?: Record<string, unknown>;
  tokenCount?: number;
  chunks_status?: string;
  message: string;
  error?: string;
  choices?: {
    fast?: string;
    queue?: string;
  };
}

/**
 * Extract with Supadata API (fast path)
 */
async function extractWithSupadata(
  videoId: string,
  videoInfo: any,
  libraryPath: string
): Promise<ExtractResult> {
  console.log('[Supadata] Starting extraction for video:', videoId);
  const supadata = new SupadataExtractor();

  if (!supadata.isAvailable()) {
    console.log('[Supadata] API key not available');
    return {
      success: false,
      stage: 'choice_required',
      message: "Fast extraction not available. Please choose 'Save for later' instead.",
      choices: {
        queue: "Save for later - Queue for processing when laptop is online (~3-4 min)"
      }
    };
  }

  const transcript = await supadata.getTranscript(videoId);

  // Build frontmatter
  const frontmatter = {
    type: 'transcript',
    source_url: `https://www.youtube.com/watch?v=${videoId}`,
    source_title: videoInfo?.title,
    source_author: videoInfo?.author,
    video_id: videoId,
    extracted_at: new Date().toISOString(),
    extraction_method: 'supadata',
    tags: ['transcript', 'youtube']
  };

  // Build content hash
  const contentHash = createHash('sha256')
    .update(transcript.fullText)
    .digest('hex');

  const userId = '00000000-0000-0000-0000-000000000001';

  // Save to Supabase
  const { data: fileData, error: upsertError } = await supabase
    .from('files')
    .upsert({
      path: libraryPath,
      body: transcript.fullText,
      frontmatter,
      embedding: null,
      content_hash: contentHash,
      user_id: userId,
      chunks_status: 'pending'
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

  const preview = generatePreview(transcript.fullText);

  return {
    success: true,
    stage: 'extracted',
    path: libraryPath,
    preview,
    metadata: frontmatter,
    chunks_status: 'pending',
    message: 'Content extracted. Semantic search processing in background.'
  };
}

/**
 * Create a queue file for local laptop processing
 */
async function createQueueFile(
  videoId: string,
  videoInfo: { title?: string; author?: string } | null
): Promise<string> {
  const queuePath = `queue/whisper/${videoId}.md`;

  const frontmatter = {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: videoInfo?.title || 'Unknown',
    author: videoInfo?.author || 'Unknown',
    queued_at: new Date().toISOString(),
    status: 'pending'
  };

  const body = `# Queued for Processing

**Video:** ${videoInfo?.title || videoId}
**Queued:** ${new Date().toISOString()}

This video will be processed automatically when your laptop is online.
`;

  const content = matter.stringify(body, frontmatter);
  const contentHash = createHash('sha256').update(content).digest('hex');
  const userId = '00000000-0000-0000-0000-000000000001';

  await supabase.from('files').insert({
    path: queuePath,
    body: content,
    frontmatter,
    content_hash: contentHash,
    user_id: userId
  });

  return queuePath;
}

/**
 * Extract content from a URL or PDF file and save to library
 */
export async function extractContentTool(args: {
  url?: string;
  file?: string;
  fileName?: string;
  extraction_mode?: 'fast' | 'queue';
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

    // Try captions first (free, works when available)
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

      // Level 2: DISABLED - Inline processing causes OOM crashes on Railway
      // Always use Level 3 (Edge Function) for background processing
      // This prevents tool timeouts and memory issues
      let chunksStatus = 'pending';
      // Skip inline processing - embeddings will be ready in ~30s via Edge Function

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

    } catch (error: any) {
      // Captions failed - check if it's the special CAPTIONS_UNAVAILABLE error
      if (error.code === 'CAPTIONS_UNAVAILABLE') {
        const videoInfo = error.videoInfo;

        // No mode specified? Ask user to choose
        if (!args.extraction_mode) {
          return {
            success: false,
            stage: 'choice_required',
            message: "This video's captions aren't directly available. How would you like to proceed?",
            metadata: {
              videoId,
              title: videoInfo?.title,
              author: videoInfo?.author
            },
            choices: {
              fast: "Extract now - Get transcript immediately (uses cloud processing)",
              queue: "Save for later - Queue for processing when laptop is online (~3-4 min)"
            }
          };
        }

        // Mode specified: execute chosen path
        if (args.extraction_mode === 'fast') {
          console.log('[Extract] Using fast mode (Supadata)');
          return await extractWithSupadata(videoId, videoInfo, libraryPath);
        } else if (args.extraction_mode === 'queue') {
          console.log('[Extract] Using queue mode');

          const queuePath = await createQueueFile(videoId, videoInfo);
          return {
            success: true,
            stage: 'queued',
            path: queuePath,
            message: "Video queued for processing. The transcript will be ready in 3-4 minutes when your laptop is online."
          };
        }
      }

      // Other errors: throw
      return {
        success: false,
        stage: 'extracted',
        message: 'YouTube extraction failed',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // Non-YouTube URLs: extract as article
  try {
    const extractor = new ArticleExtractor();
    const article = await extractor.extractFromUrl(url);

    // Generate slug for library path
    const slug = extractor.generateSlug(url);
    const libraryPath = `library/articles/${slug}.md`;

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
        message: 'Article already extracted. Use save_learning to save synthesis.'
      };
    }

    // Build frontmatter per CONTEXT.md spec
    const frontmatter = {
      type: 'article',
      title: article.title,
      source_url: article.originalUrl,
      source_author: article.author,
      source_site: article.siteName,
      published_date: article.publishedDate,
      word_count: article.wordCount,
      excerpt: article.excerpt,
      extracted_at: new Date().toISOString(),
      tags: ['article', 'web']
    };

    // Build content hash
    const contentHash = createHash('sha256')
      .update(article.content)
      .digest('hex');

    const userId = '00000000-0000-0000-0000-000000000001'; // Single-user system

    // Level 1: Save file immediately with pending status (always instant return)
    const { data: fileData, error: upsertError } = await supabase
      .from('files')
      .upsert({
        path: libraryPath,
        body: article.content,
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

    // Level 2: DISABLED - Inline processing causes OOM crashes on Railway
    // Always use Level 3 (Edge Function) for background processing
    let chunksStatus = 'pending';
    // Skip inline processing - embeddings will be ready in ~30s via Edge Function

    // Generate preview
    const preview = generatePreview(article.content);

    return {
      success: true,
      stage: 'extracted',
      path: libraryPath,
      preview,
      metadata: frontmatter,
      chunks_status: chunksStatus,
      message: chunksStatus === 'complete'
        ? 'Article extracted with instant semantic search.'
        : 'Article extracted. Semantic search processing in background.'
    };

  } catch (error) {
    return {
      success: false,
      stage: 'extracted',
      message: 'Article extraction failed',
      error: error instanceof Error ? error.message : String(error)
    };
  }
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

    // Level 2: DISABLED - Inline processing causes OOM crashes on Railway
    // Always use Level 3 (Edge Function) for background processing
    let chunksStatus = 'pending';
    // Skip inline processing - embeddings will be ready in ~30s via Edge Function

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
  description: 'Extract content from a URL (YouTube video, web article) or PDF file and save to library. Returns preview and path. Handles deduplication automatically. Provide either "url" OR both "file" and "fileName" parameters.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to extract content from (YouTube video or web article URL). Use this parameter OR the file+fileName parameters.'
      },
      file: {
        type: 'string',
        description: 'Base64-encoded PDF file content (alternative to url). Must be used with fileName parameter.'
      },
      fileName: {
        type: 'string',
        description: 'Original filename (required when file parameter is provided)'
      },
      extraction_mode: {
        type: 'string',
        enum: ['fast', 'queue'],
        description: 'For videos without direct captions: "fast" extracts immediately using cloud service, "queue" saves for processing when laptop is online'
      }
    }
  }
};
