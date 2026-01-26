// PDF Content Extractor using Gemini Flash
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync, statSync } from 'fs';

export interface GeminiExtractionResult {
  title: string;
  content: string;
  author?: string;
  publishedDate?: string;
  pageCount: number;
  fileSize: number;
  wordCount: number;
  sourceType: 'pdf';
  originalFileName: string;
}

export class GeminiExtractor {
  private genAI: GoogleGenerativeAI | null = null;

  /**
   * Check if Gemini API is available
   */
  isAvailable(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }

  /**
   * Initialize Gemini client (lazy initialization)
   */
  private getClient(): GoogleGenerativeAI {
    if (!this.genAI) {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error(
          'PDF extraction requires GEMINI_API_KEY. ' +
          'Get from: https://aistudio.google.com -> Get API key. ' +
          'Free tier: 1M tokens/day (~50 PDFs/month), Paid: $0.30/1M input tokens'
        );
      }
      this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }
    return this.genAI;
  }

  /**
   * Extract content from PDF file
   */
  async extractFromFile(
    filePath: string,
    fileName: string
  ): Promise<GeminiExtractionResult> {
    // Verify API availability
    const genAI = this.getClient();

    // Read file and get metadata
    const fileStats = statSync(filePath);
    const fileSize = fileStats.size;
    const pdfBytes = readFileSync(filePath);

    // Estimate page count (avg 50KB per page)
    const estimatedPages = Math.max(1, Math.round(fileSize / 51200));

    // Initialize Gemini model
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    // Extract content with Gemini
    try {
      const result = await model.generateContent([
        {
          inlineData: {
            data: Buffer.from(pdfBytes).toString('base64'),
            mimeType: 'application/pdf'
          }
        },
        'Extract all text from this PDF and format as clean markdown. ' +
        'Preserve structure with headings, lists, and paragraphs. ' +
        'Include any tables as markdown tables. ' +
        'If metadata is visible (author, publication date, title), note it at the start.'
      ]);

      const response = await result.response;
      const content = response.text();

      // Calculate word count
      const wordCount = content.split(/\s+/).filter(word => word.length > 0).length;

      // Extract title from content or filename
      const title = this.extractTitle(content, fileName);

      // Try to extract metadata from content
      const metadata = this.extractMetadata(content);

      return {
        title,
        content,
        author: metadata.author,
        publishedDate: metadata.publishedDate,
        pageCount: estimatedPages,
        fileSize,
        wordCount,
        sourceType: 'pdf',
        originalFileName: fileName
      };

    } catch (error: any) {
      throw new Error(
        `Failed to extract PDF with Gemini: ${error.message || String(error)}`
      );
    }
  }

  /**
   * Extract title from content or filename
   */
  private extractTitle(content: string, fileName: string): string {
    // Try to find first # heading
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      return headingMatch[1].trim();
    }

    // Try to find bold text that looks like a title in first 500 chars
    const firstPart = content.slice(0, 500);
    const boldMatch = firstPart.match(/\*\*(.+?)\*\*/);
    if (boldMatch && boldMatch[1].length < 100) {
      return boldMatch[1].trim();
    }

    // Fall back to filename without extension
    return fileName.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
  }

  /**
   * Extract metadata from content if present
   */
  private extractMetadata(content: string): {
    author?: string;
    publishedDate?: string;
  } {
    const metadata: { author?: string; publishedDate?: string } = {};

    // Look in first 1000 chars for common metadata patterns
    const firstPart = content.slice(0, 1000);

    // Try to find author
    const authorPatterns = [
      /(?:Author|By|Written by):\s*([^\n]+)/i,
      /\*\*Author\*\*:\s*([^\n]+)/i
    ];
    for (const pattern of authorPatterns) {
      const match = firstPart.match(pattern);
      if (match) {
        metadata.author = match[1].trim();
        break;
      }
    }

    // Try to find date
    const datePatterns = [
      /(?:Date|Published|Publication Date):\s*([^\n]+)/i,
      /\*\*Date\*\*:\s*([^\n]+)/i,
      /(\d{4}-\d{2}-\d{2})/,
      /(\w+ \d{1,2},? \d{4})/
    ];
    for (const pattern of datePatterns) {
      const match = firstPart.match(pattern);
      if (match) {
        metadata.publishedDate = match[1].trim();
        break;
      }
    }

    return metadata;
  }
}
