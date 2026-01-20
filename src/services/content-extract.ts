import { getSubtitles } from 'youtube-caption-extractor';

export interface ExtractedContent {
  content: string;
  type: 'video' | 'article';
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

      return {
        content: transcript,
        type: 'video'
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
