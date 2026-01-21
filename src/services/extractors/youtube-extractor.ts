// YouTube Transcript Extractor
import { YoutubeTranscript } from 'youtube-transcript-plus';
import type {
  YouTubeTranscript,
  TranscriptSegment,
  TranscriptOptions
} from '../../types/youtube';
import { extractVideoId, getVideoInfo, scrapeVideoInfo, formatTimestamp, downloadAudio } from '../../utils/youtube';
import { WhisperService } from '../whisper-service';

const DEFAULT_LANGUAGES = ['en', 'en-US', 'en-GB'];

export class YouTubeExtractor {
  private whisperService = new WhisperService();

  /**
   * Get transcript for a YouTube video
   */
  async getTranscript(
    videoIdOrUrl: string,
    options: TranscriptOptions = {}
  ): Promise<YouTubeTranscript> {
    const videoId = extractVideoId(videoIdOrUrl);
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Get video info - try ytdl-core first, then scraping fallback
    let videoInfo;
    try {
      videoInfo = await getVideoInfo(videoId);
    } catch (error: any) {
      // ytdl-core failed, try scraping fallback
      try {
        videoInfo = await scrapeVideoInfo(videoId);
      } catch (scrapeError: any) {
        // Both methods failed, continue without video info
        videoInfo = null;
      }
    }

    // Try fetching transcript from captions first
    let transcript;
    let captionError: Error | null = null;

    try {
      transcript = await this.fetchFromCaptions(videoId, options);
    } catch (error: any) {
      captionError = error;
    }

    // If captions failed and Whisper fallback is enabled, try Whisper
    if (!transcript && options.useWhisperFallback) {
      if (!this.whisperService.isAvailable()) {
        throw new Error(
          'No captions available and Whisper fallback requested, but OPENAI_API_KEY is not set. ' +
          `Original error: ${captionError?.message}`
        );
      }

      transcript = await this.fetchWithWhisper(videoId, options);
    }

    // If we still don't have a transcript, throw the original error
    if (!transcript) {
      throw captionError || new Error('No captions available for this video');
    }

    return {
      videoId,
      videoUrl,
      title: videoInfo?.title,
      author: videoInfo?.author,
      description: videoInfo?.description || undefined,
      duration: videoInfo?.duration,
      ...transcript,
    };
  }

  /**
   * Fetch transcript using Whisper API
   */
  private async fetchWithWhisper(
    videoId: string,
    options: TranscriptOptions
  ): Promise<Pick<YouTubeTranscript, 'segments' | 'fullText' | 'language'>> {
    // Download audio from YouTube
    const audioStream = await downloadAudio(videoId);

    // Transcribe with Whisper
    const result = await this.whisperService.transcribe(audioStream, {
      language: options.language,
    });

    // Format the full text according to options
    const fullText = this.formatFullText(result.segments, options);

    return {
      segments: result.segments,
      fullText,
      language: `${result.language} (whisper)`,
    };
  }

  /**
   * Fetch transcript from YouTube captions
   */
  private async fetchFromCaptions(
    videoId: string,
    options: TranscriptOptions
  ): Promise<Pick<YouTubeTranscript, 'segments' | 'fullText' | 'language'>> {
    const languages = options.language
      ? [options.language, ...DEFAULT_LANGUAGES]
      : DEFAULT_LANGUAGES;

    // Try each language
    let lastError: Error | null = null;
    for (const lang of languages) {
      try {
        const transcriptData = await YoutubeTranscript.fetchTranscript(videoId, {
          lang,
        });

        // Convert to our format
        const segments: TranscriptSegment[] = transcriptData.map((item: any) => ({
          text: item.text,
          start: item.offset,  // Already in seconds
          duration: item.duration,  // Already in seconds
        }));

        const fullText = this.formatFullText(segments, options);

        return {
          segments,
          fullText,
          language: lang,
        };
      } catch (error: any) {
        lastError = error;
        continue;  // Try next language
      }
    }

    throw lastError || new Error('No captions available for this video');
  }

  /**
   * Format segments into full text
   */
  private formatFullText(segments: TranscriptSegment[], options: TranscriptOptions): string {
    if (options.includeTimestamps) {
      return segments
        .map(seg => `[${formatTimestamp(seg.start)}] ${seg.text}`)
        .join('\n');
    }

    if (options.preserveFormatting) {
      return segments.map(seg => seg.text).join('\n');
    }

    // Default: combine into paragraphs
    return segments.map(seg => seg.text).join(' ');
  }
}
