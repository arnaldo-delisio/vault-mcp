import { getSubtitles, getVideoDetails } from 'youtube-caption-extractor';
import { encode } from 'gpt-tokenizer';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WhisperService } from './whisper-service.js';
import ytdl from 'ytdl-core';

const TOKEN_THRESHOLD = 10000;
const TRANSCRIPTS_DIR = join(tmpdir(), 'youtube-transcripts');

const whisperService = new WhisperService();

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
    const videoUrl = `https://www.youtube.com/watch?v=${videoID}`;

    // Fetch video metadata - use youtube-caption-extractor (more reliable than ytdl)
    let metadata: ExtractedContent['metadata'] = {
      videoId: videoID,
      url: videoUrl,
      language: 'en'
    };

    try {
      const details = await getVideoDetails({ videoID, lang: 'en' });
      metadata = {
        title: details.title,
        description: details.description || undefined,
        videoId: videoID,
        url: videoUrl,
        language: 'en'
      };

      // Try ytdl for additional metadata (author, duration) if available
      try {
        const info = await ytdl.getInfo(videoUrl);
        metadata.author = info.videoDetails.author.name;
        metadata.duration = parseInt(info.videoDetails.lengthSeconds, 10);
      } catch {
        // ytdl failed, continue with basic metadata from getVideoDetails
      }
    } catch (metaError) {
      // Both methods failed - continue without metadata (not critical)
    }

    // Try captions first, then Whisper fallback
    let transcript: string;
    let subtitles: any[] | null = null;

    try {
      // Fetch English subtitles
      subtitles = await getSubtitles({ videoID, lang: 'en' });

      if (!subtitles || subtitles.length === 0) {
        throw new Error('No English captions available for this video');
      }

      // Join subtitle text into transcript
      transcript = subtitles.map(s => s.text).join(' ');

    } catch (captionError: any) {
      // Try Whisper fallback if available
      if (whisperService.isAvailable()) {
        console.log(`No captions for ${videoID}, trying Whisper fallback...`);
        try {
          transcript = await whisperService.transcribe(videoID);
        } catch (whisperError: any) {
          throw new Error(`Both captions and Whisper failed: ${captionError.message}`);
        }
      } else {
        // No fallback available
        throw new Error(`No English captions available and Whisper fallback not configured (OPENAI_API_KEY missing). Try a video with captions enabled.`);
      }
    }

    // Count tokens to decide output method
    const tokenCount = encode(transcript).length;

    if (tokenCount <= TOKEN_THRESHOLD) {
      // Small enough - return inline
      return {
        content: transcript,
        type: 'video' as const,
        metadata
      };
    }

    // Too large - write to file with sparse timestamps
    await mkdir(TRANSCRIPTS_DIR, { recursive: true });
    const filePath = join(TRANSCRIPTS_DIR, `${videoID}.txt`);

    // Format with timestamps every 60 seconds (if we have subtitle timing)
    let fileContent = '';
    if (subtitles && subtitles.length > 0) {
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
    } else {
      // Whisper transcript without timing - just write plain text
      fileContent = transcript;
    }

    await writeFile(filePath, fileContent, 'utf-8');

    // Generate preview (first ~1500 tokens)
    const previewLength = Math.min(transcript.length, 8000); // Approximate 1500 tokens
    const preview = transcript.slice(0, previewLength) + '...';

    return {
      content: preview,
      type: 'video' as const,
      metadata,
      filePath,
      tokenCount,
      instructions: `Transcript too large (${tokenCount} tokens). Full transcript saved to: ${filePath}\n\nTo search: Use Grep tool with pattern\nTo read sections: Use Read tool with offset/limit${subtitles ? '\nTo navigate: File has timestamps every 60s ([MM:SS] format)' : ''}`
    };

  } else {
    // Non-YouTube URL - delegate to Claude's WebFetch
    return {
      content: '[Delegate to WebFetch] - Use your built-in WebFetch tool to extract content from this URL, then provide it back to synthesize_content for synthesis.',
      type: 'article'
    };
  }
}
