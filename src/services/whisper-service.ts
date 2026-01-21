// Whisper Transcription Service
import OpenAI from 'openai';
import { createWriteStream, createReadStream, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import type { TranscriptSegment } from '../types/youtube';

// Max file size for Whisper API (25MB)
const MAX_FILE_SIZE = 25 * 1024 * 1024;

export interface WhisperResult {
  segments: TranscriptSegment[];
  fullText: string;
  language: string;
}

export class WhisperService {
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is required for Whisper transcription');
      }
      this.client = new OpenAI({ apiKey });
    }
    return this.client;
  }

  /**
   * Transcribe audio from a readable stream
   */
  async transcribe(
    audioStream: NodeJS.ReadableStream,
    options: { language?: string } = {}
  ): Promise<WhisperResult> {
    const tempPath = join(tmpdir(), `whisper-${Date.now()}.mp3`);

    try {
      // Write stream to temp file
      const writeStream = createWriteStream(tempPath);
      await pipeline(audioStream, writeStream);

      // Transcribe the file
      return await this.transcribeFile(tempPath, options);
    } finally {
      // Clean up temp file
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Transcribe an audio file
   */
  async transcribeFile(
    filePath: string,
    options: { language?: string } = {}
  ): Promise<WhisperResult> {
    const client = this.getClient();

    const transcription = await client.audio.transcriptions.create({
      file: createReadStream(filePath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
      language: options.language,
    });

    // Extract segments from response
    const segments: TranscriptSegment[] = (transcription.segments || []).map((seg: any) => ({
      text: seg.text.trim(),
      start: seg.start,
      duration: seg.end - seg.start,
    }));

    return {
      segments,
      fullText: transcription.text,
      language: transcription.language || options.language || 'en',
    };
  }

  /**
   * Check if Whisper is available (API key configured)
   */
  isAvailable(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }
}
