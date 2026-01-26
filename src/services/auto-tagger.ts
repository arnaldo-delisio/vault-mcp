/**
 * AutoTagger Service - Hybrid taxonomy-based auto-tagging
 *
 * Provides:
 * - AI-powered tag suggestions from controlled taxonomy
 * - New tag discovery and user approval workflow
 * - Re-tag candidate counting for impact assessment
 * - Taxonomy management with persistence
 */

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import type { SupabaseClient } from '@supabase/supabase-js';

interface TaxonomyFile {
  version: string;
  tags: string[];
  last_updated: string;
}

export interface TagSuggestions {
  existingTags: string[];
  newTags: string[];
}

export class AutoTagger {
  private taxonomy: string[];
  private taxonomyPath: string;
  private openai: OpenAI | null;

  constructor() {
    this.taxonomyPath = path.join(__dirname, '../../.vault/taxonomy.json');
    this.taxonomy = this.loadTaxonomy();

    // Lazy OpenAI initialization (same pattern as embeddings.ts)
    this.openai = null;
  }

  private loadTaxonomy(): string[] {
    try {
      const data = fs.readFileSync(this.taxonomyPath, 'utf-8');
      const taxonomy: TaxonomyFile = JSON.parse(data);
      return taxonomy.tags;
    } catch (error) {
      console.error('Failed to load taxonomy, using empty array:', error);
      return [];
    }
  }

  private getOpenAI(): OpenAI {
    if (!this.openai) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY not configured');
      }
      this.openai = new OpenAI({ apiKey });
    }
    return this.openai;
  }

  /**
   * Suggest 2-5 relevant tags for content
   * Separates into existing taxonomy tags vs new tag suggestions
   */
  async suggestTags(content: string, title: string): Promise<TagSuggestions> {
    try {
      const openai = this.getOpenAI();

      // Build prompt with taxonomy context
      const prompt = `Given this learning content, suggest 2-5 relevant tags.

Available tags: ${this.taxonomy.join(', ')}

If the content covers topics not in the available tags, suggest new tags (lowercase, kebab-case).

Content:
Title: ${title}
${content.substring(0, 2000)}

Return JSON: { "tags": ["tag1", "tag2", ...] }`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3
      });

      const result = JSON.parse(response.choices[0].message.content || '{"tags":[]}');
      const suggested = result.tags || [];

      // Separate into existing vs new
      const existingTags = suggested.filter((t: string) => this.taxonomy.includes(t));
      const newTags = suggested.filter((t: string) => !this.taxonomy.includes(t));

      return { existingTags, newTags };

    } catch (error) {
      console.error('Tag suggestion failed, returning empty:', error);
      return { existingTags: [], newTags: [] };
    }
  }

  /**
   * Add approved tags to taxonomy and persist to disk
   */
  async approveTags(newTags: string[]): Promise<void> {
    // Add to in-memory taxonomy
    this.taxonomy.push(...newTags);
    this.taxonomy.sort();

    // Persist to disk
    const taxonomyFile: TaxonomyFile = {
      version: '1.0',
      tags: this.taxonomy,
      last_updated: new Date().toISOString().split('T')[0]
    };

    fs.writeFileSync(
      this.taxonomyPath,
      JSON.stringify(taxonomyFile, null, 2),
      'utf-8'
    );
  }

  /**
   * Count learnings that would benefit from new tags
   * Uses simple keyword matching in body and title
   */
  async countRetagCandidates(
    newTags: string[],
    supabase: SupabaseClient,
    userId: string
  ): Promise<number> {
    let totalCount = 0;

    for (const tag of newTags) {
      try {
        // Search for tag keyword in learnings
        const { count } = await supabase
          .from('files')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .like('path', 'learnings/%')
          .or(`body.ilike.%${tag}%,frontmatter->>title.ilike.%${tag}%`);

        totalCount += count || 0;
      } catch (error) {
        console.error(`Failed to count retag candidates for ${tag}:`, error);
      }
    }

    return totalCount;
  }

  /**
   * Check if OpenAI API is available for tag suggestions
   */
  isAvailable(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }
}
