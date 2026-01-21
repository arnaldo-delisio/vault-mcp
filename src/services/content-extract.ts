import { encode } from 'gpt-tokenizer';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { YouTubeExtractor } from './extractors/youtube-extractor';
import { formatTimestamp } from '../utils/youtube';

const TOKEN_THRESHOLD = 10000;
const TRANSCRIPTS_DIR = join(tmpdir(), 'youtube-transcripts');

const youtubeExtractor = new YouTubeExtractor();

export interface ExtractedContent {
  content: string;
  type: 'video' | 'article';
  metadata?: {
    title?: string;
    author?: string;
    duration?: number;  // seconds
    description?: string;
    videoId?: string;
    url?: string;
    language?: string;
  };
  filePath?: string;
  tokenCount?: number;
  instructions?: string;
}

/**
 * Extract content from URLs
 *
 * YouTube videos: Extract English subtitles/captions and return transcript
 * Other URLs: Delegate to Claude's built-in WebFetch tool
 */
export async function extractContent(url: string): Promise<ExtractedContent> {
  // Detect YouTube URLs
  const youtubeRegex = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&]+)/;
  const match = url.match(youtubeRegex);

  if (match) {
    // Extract YouTube video ID
    const videoID = match[1];

    // Use YouTubeExtractor for all extraction (metadata + transcript)
    const result = await youtubeExtractor.getTranscript(videoID, {
      language: 'en',
      useWhisperFallback: true,  // Use Whisper if captions unavailable
    });

    const metadata: ExtractedContent['metadata'] = {
      title: result.title,
      author: result.author,
      duration: result.duration,
      description: result.description,
      videoId: result.videoId,
      url: result.videoUrl,
      language: result.language,
    };

    // Count tokens to decide output method
    const tokenCount = encode(result.fullText).length;

    if (tokenCount <= TOKEN_THRESHOLD) {
      // Small enough - return inline
      return {
        content: result.fullText,
        type: 'video' as const,
        metadata
      };
    }

    // Too large - write to file with sparse timestamps
    await mkdir(TRANSCRIPTS_DIR, { recursive: true });
    const filePath = join(TRANSCRIPTS_DIR, `${videoID}.txt`);

    // Format with timestamps every 60 seconds using segments
    let fileContent = '';
    let lastTimestamp = -60;

    for (const segment of result.segments) {
      const currentTime = Math.floor(segment.start);
      if (currentTime - lastTimestamp >= 60) {
        fileContent += `\n[${formatTimestamp(currentTime)}]\n`;
        lastTimestamp = currentTime;
      }
      fileContent += segment.text + ' ';
    }

    await writeFile(filePath, fileContent.trim(), 'utf-8');

    // Generate preview (first ~1500 tokens)
    const previewLength = Math.min(result.fullText.length, 8000); // Approximate 1500 tokens
    const preview = result.fullText.slice(0, previewLength) + '...';

    return {
      content: preview,
      type: 'video' as const,
      metadata,
      filePath,
      tokenCount,
      instructions: `Transcript too large (${tokenCount} tokens). Full transcript saved to: ${filePath}\n\nTo search: Use Grep tool with pattern\nTo read sections: Use Read tool with offset/limit\nTo navigate: File has timestamps every 60s ([HH:MM:SS] format)`
    };

  } else {
    // Non-YouTube URL - delegate to Claude's WebFetch
    return {
      content: '[Delegate to WebFetch] - Use your built-in WebFetch tool to extract content from this URL, then provide it back to synthesize_content for synthesis.',
      type: 'article'
    };
  }
}
