import { getSubtitles } from 'youtube-caption-extractor';
import { encode } from 'gpt-tokenizer';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TOKEN_THRESHOLD = 10000;
const TRANSCRIPTS_DIR = join(tmpdir(), 'youtube-transcripts');

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

    try {
      // Fetch English subtitles
      const subtitles = await getSubtitles({ videoID, lang: 'en' });

      if (!subtitles || subtitles.length === 0) {
        throw new Error('No English captions available for this video');
      }

      // Join subtitle text into transcript
      const transcript = subtitles.map(s => s.text).join(' ');

      // Count tokens to decide output method
      const tokenCount = encode(transcript).length;

      if (tokenCount <= TOKEN_THRESHOLD) {
        // Small enough - return inline
        return {
          content: transcript,
          type: 'video' as const
        };
      }

      // Too large - write to file with sparse timestamps
      await mkdir(TRANSCRIPTS_DIR, { recursive: true });
      const filePath = join(TRANSCRIPTS_DIR, `${videoID}.txt`);

      // Format with timestamps every 60 seconds
      let fileContent = '';
      let lastTimestamp = -60;
      for (const subtitle of subtitles) {
        const currentTime = Math.floor(parseFloat(subtitle.start));
        if (currentTime - lastTimestamp >= 60) {
          const minutes = Math.floor(currentTime / 60);
          const seconds = currentTime % 60;
          fileContent += `\n[${minutes}:${seconds.toString().padStart(2, '0')}]\n`;
          lastTimestamp = currentTime;
        }
        fileContent += subtitle.text + ' ';
      }

      await writeFile(filePath, fileContent, 'utf-8');

      // Generate preview (first ~1500 tokens)
      const previewLength = Math.min(transcript.length, 8000); // Approximate 1500 tokens
      const preview = transcript.slice(0, previewLength) + '...';

      return {
        content: preview,
        type: 'video' as const,
        filePath,
        tokenCount,
        instructions: `Transcript too large (${tokenCount} tokens). Full transcript saved to: ${filePath}\n\nTo search: Use Grep tool with pattern\nTo read sections: Use Read tool with offset/limit\nTo navigate: File has timestamps every 60s ([MM:SS] format)`
      };

    } catch (error: any) {
      // Provide descriptive error messages
      if (error.message?.includes('404') || error.message?.includes('not found')) {
        throw new Error(`YouTube video not found: ${videoID}`);
      }
      if (error.message?.includes('caption') || error.message?.includes('subtitle')) {
        throw new Error(`No English captions available for this video. Try a video with captions enabled.`);
      }
      if (error.message?.includes('network') || error.message?.includes('ENOTFOUND')) {
        throw new Error(`Network error while fetching YouTube transcript. Check your internet connection.`);
      }

      // Re-throw with original message if no specific match
      throw new Error(`Failed to extract YouTube transcript: ${error.message}`);
    }

  } else {
    // Non-YouTube URL - delegate to Claude's WebFetch
    return {
      content: '[Delegate to WebFetch] - Use your built-in WebFetch tool to extract content from this URL, then provide it back to synthesize_content for synthesis.',
      type: 'article'
    };
  }
}
