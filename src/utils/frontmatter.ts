import matter from 'gray-matter';

/**
 * Frontmatter utilities for vault files
 */

/**
 * Create frontmatter for learning files
 */
export function createLearningFrontmatter(
  sourceUrl: string,
  tags: string[],
  metadata?: {
    source_title?: string;
    source_author?: string;
    source_duration?: number;
    source_url?: string;
  }
) {
  return {
    created_at: new Date().toISOString(),
    source_url: sourceUrl,
    tags,
    type: 'learning',
    ...(metadata?.source_title && { source_title: metadata.source_title }),
    ...(metadata?.source_author && { source_author: metadata.source_author }),
    ...(metadata?.source_duration && { source_duration_minutes: Math.floor(metadata.source_duration / 60) }),
  };
}

/**
 * Create frontmatter for daily journal files
 */
export function createDailyFrontmatter() {
  return {
    created_at: new Date().toISOString(),
    type: 'daily'
  };
}

/**
 * Append content to daily journal with timestamp
 * Returns formatted string: ## HH:MM\n[content]\n\n
 */
export function appendToDaily(content: string): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');

  return `## ${hours}:${minutes}\n${content}\n\n`;
}
