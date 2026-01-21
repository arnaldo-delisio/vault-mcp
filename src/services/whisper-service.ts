import OpenAI from 'openai';
import ytdl from 'ytdl-core';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';

export class WhisperService {
  private openai: OpenAI | null = null;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
  }

  async transcribe(videoId: string): Promise<string> {
    if (!this.openai) {
      throw new Error('Whisper fallback requires OPENAI_API_KEY environment variable');
    }

    // Download audio to temp file
    const audioPath = join(tmpdir(), `${videoId}.mp3`);
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    try {
      // Download audio-only stream
      const audioStream = ytdl(videoUrl, {
        quality: 'lowestaudio',
        filter: 'audioonly'
      });

      const chunks: Buffer[] = [];
      for await (const chunk of audioStream) {
        chunks.push(Buffer.from(chunk));
      }
      await writeFile(audioPath, Buffer.concat(chunks));

      // Transcribe via Whisper API
      const transcription = await this.openai.audio.transcriptions.create({
        file: createReadStream(audioPath) as any,
        model: 'whisper-1',
        language: 'en'
      });

      return transcription.text;

    } finally {
      // Cleanup temp audio file
      try {
        await unlink(audioPath);
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  }

  isAvailable(): boolean {
    return this.openai !== null;
  }
}
