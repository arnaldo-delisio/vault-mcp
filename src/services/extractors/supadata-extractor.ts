import { TranscriptSegment } from '../../types/youtube.js';

export class SupadataExtractor {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.SUPADATA_API_KEY;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async getTranscript(videoId: string): Promise<{
    segments: TranscriptSegment[];
    fullText: string;
    language: string;
  }> {
    if (!this.apiKey) {
      throw new Error('SUPADATA_API_KEY not configured');
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(
      `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(url)}`,
      {
        headers: { 'x-api-key': this.apiKey }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Supadata] API error:', response.status, errorText);
      throw new Error(`Supadata API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('[Supadata] API response:', JSON.stringify(data).substring(0, 500));

    // Convert to our segment format
    const segments: TranscriptSegment[] = data.segments.map((s: any) => ({
      text: s.text,
      start: s.start,
      duration: s.duration
    }));

    const fullText = segments.map(s => s.text).join(' ');

    return {
      segments,
      fullText,
      language: data.language || 'en'
    };
  }
}
