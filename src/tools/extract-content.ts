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
import { YouTubeExtractor } from '../services/extractors/youtube-extractor.js';
import { generateEmbedding, isEmbeddingAvailable } from '../services/embeddings.js';
import { supabase } from '../services/vault-client.js';

interface ExtractResult {
  success: boolean;
  stage: 'cached' | 'extracted' | 'delegate';
  path?: string;
  preview?: string;
  metadata?: Record<string, unknown>;
  tokenCount?: number;
  message: string;
  error?: string;
}

/**
 * Extract content from a URL and save to library
 */
export async function extractContentTool(args: { url: string }): Promise<ExtractResult> {
  const { url } = args;

  if (!url || typeof url !== 'string') {
    return {
      success: false,
      stage: 'delegate',
      message: 'Invalid URL parameter',
      error: 'URL must be a non-empty string'
    };
  }

  // Check if YouTube URL
  const youtubeMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);

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

      // Generate embedding for semantic search
      let embedding: number[] | null = null;
      if (isEmbeddingAvailable()) {
        embedding = await generateEmbedding(transcript.fullText);
      }

      // Build content hash
      const contentHash = createHash('sha256')
        .update(transcript.fullText)
        .digest('hex');

      // Save to database with upsert (handles race conditions)
      const { error: upsertError } = await supabase.from('files').upsert({
        path: libraryPath,
        body: transcript.fullText,
        frontmatter,
        embedding,
        content_hash: contentHash,
        user_id: 'authenticated-user' // TODO: Get from OAuth session
      }, { onConflict: 'user_id,path' });

      if (upsertError) {
        return {
          success: false,
          stage: 'extracted',
          message: 'Extraction succeeded but save failed',
          error: upsertError.message
        };
      }

      // Generate preview - smart sampling for long transcripts
      const preview = generatePreview(transcript.fullText);

      return {
        success: true,
        stage: 'extracted',
        path: libraryPath,
        preview,
        metadata: frontmatter,
        message: 'Content extracted and saved to library. Review and save synthesis.'
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
  description: 'Extract content from a URL (YouTube video) and save to library. Returns preview and path. For non-YouTube URLs, use WebFetch tool directly then save_learning.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to extract content from (YouTube video URL)'
      }
    },
    required: ['url']
  }
};
