/**
 * MOCGenerator Service - Threshold-based Map of Content generation
 *
 * Generates MOCs (Maps of Content) for topics when they reach threshold (5+ learnings).
 * Enables topic organization, content generation input, and knowledge discovery.
 */

import { SupabaseClient } from '@supabase/supabase-js';

interface LearningRef {
  path: string;
  frontmatter: any;
  body: string;
  created_at: string;
}

interface ThresholdResult {
  shouldGenerate: string[];
  counts: Record<string, number>;
}

interface MOCResult {
  path: string;
  content: string;
  learningCount: number;
}

export class MOCGenerator {
  private readonly THRESHOLD = 5; // Generate MOC at 5+ learnings

  constructor(
    private supabase: SupabaseClient,
    private userId: string
  ) {}

  /**
   * Check which tags have reached the threshold for MOC generation
   */
  async checkThreshold(tags: string[]): Promise<ThresholdResult> {
    const shouldGenerate: string[] = [];
    const counts: Record<string, number> = {};

    for (const tag of tags) {
      // Count learnings with this tag
      const { count } = await this.supabase
        .from('files')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', this.userId)
        .like('path', 'learnings/%')
        .contains('frontmatter', { tags: [tag] });

      counts[tag] = count || 0;

      // Check if MOC already exists
      const { data: existingMoc } = await this.supabase
        .from('files')
        .select('path')
        .eq('user_id', this.userId)
        .eq('path', `mocs/${tag}.md`)
        .maybeSingle();

      // Generate if >= threshold and no MOC exists
      if (counts[tag] >= this.THRESHOLD && !existingMoc) {
        shouldGenerate.push(tag);
      }
    }

    return { shouldGenerate, counts };
  }

  /**
   * Generate MOC for a topic
   */
  async generateMOC(topic: string): Promise<MOCResult> {
    // Fetch all learnings with this tag
    const { data: learnings, error } = await this.supabase
      .from('files')
      .select('path, frontmatter, body, created_at')
      .eq('user_id', this.userId)
      .like('path', 'learnings/%')
      .contains('frontmatter', { tags: [topic] })
      .order('created_at', { ascending: false });

    if (error || !learnings || learnings.length === 0) {
      throw new Error(`No learnings found for topic: ${topic}`);
    }

    // Generate MOC content
    const mocPath = `mocs/${topic}.md`;
    const mocContent = this.buildMOCContent(topic, learnings);

    // Prepare frontmatter
    const frontmatter = {
      title: `${this.capitalize(topic)} - Map of Content`,
      topic,
      learning_count: learnings.length,
      generated_at: new Date().toISOString().split('T')[0],
      type: 'moc'
    };

    // Save to database
    const { error: upsertError } = await this.supabase
      .from('files')
      .upsert({
        user_id: this.userId,
        path: mocPath,
        body: mocContent,
        frontmatter,
        content_hash: '', // Will be updated by daemon on sync
        updated_at: new Date().toISOString()
      });

    if (upsertError) {
      throw new Error(`Failed to save MOC: ${upsertError.message}`);
    }

    return {
      path: mocPath,
      content: mocContent,
      learningCount: learnings.length
    };
  }

  /**
   * Build MOC markdown content
   */
  private buildMOCContent(topic: string, learnings: LearningRef[]): string {
    const title = this.capitalize(topic);
    let content = `# ${title} - Map of Content\n\n`;
    content += `${learnings.length} learnings on ${topic}\n\n`;
    content += `---\n\n`;

    for (const learning of learnings) {
      const learningTitle = learning.frontmatter?.title || 'Untitled';
      const learningPath = learning.path;

      // Extract first meaningful line as snippet
      const firstLine = learning.body
        .split('\n')
        .find(l => l.trim().length > 0) || '';
      const snippet = firstLine.length > 100
        ? firstLine.substring(0, 100) + '...'
        : firstLine;

      // Use wiki-style links: [[path|title]]
      content += `## [[${learningPath}|${learningTitle}]]\n`;
      content += `${snippet}\n\n`;
    }

    return content;
  }

  /**
   * Capitalize first letter of topic
   */
  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
