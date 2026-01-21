/**
 * Workflow Instructions Resource
 *
 * Provides Claude Mobile with guidance on the two-stage content capture workflow:
 * 1. extract_content - Extract and save to library
 * 2. save_learning - Save user synthesis
 */

export const workflowInstructionsResource = {
  uri: 'vault://workflow/content-capture',
  name: 'Content Capture Workflow',
  mimeType: 'text/plain',
  description: 'Instructions for the two-stage content capture workflow using extract_content and save_learning tools'
};

export function getWorkflowInstructions(): string {
  return `# Content Capture Workflow

When a user shares a URL (especially YouTube videos), follow this two-stage workflow:

## Stage 1: Extract Content
1. Call extract_content(url) with the user's URL
2. Review the returned preview and metadata
3. If extraction successful, the content is saved to library/ for future reference
4. If already cached (deduplication), you'll receive the existing content

## Stage 2: Synthesize and Save Learning
After reviewing the extracted content with the user:
1. Discuss the content - ask what interests them, what they want to capture
2. Help them synthesize key insights
3. Create a markdown document with YAML frontmatter:

\`\`\`yaml
---
title: <descriptive title>
tags: [<relevant>, <tags>]
source: [[library/youtube/<videoId>]]
---

<synthesis content here>
\`\`\`

4. Call save_learning(synthesis) with the complete markdown
5. The learning is saved to learnings/ with embedding for semantic search

## Key Points
- extract_content handles deduplication - same URL returns cached content
- save_learning validates frontmatter - title, tags, and source are required
- Both files (library content + learning) sync to laptop automatically
- Use search_notes to find related content across library and learnings

## Example Flow
User: "Check out this video: https://youtube.com/watch?v=abc123"
1. extract_content({ url: "https://youtube.com/watch?v=abc123" })
2. Discuss insights with user
3. save_learning({ synthesis: "---\\ntitle: ...\\ntags: [...]\\nsource: [[library/youtube/abc123]]\\n---\\n..." })
`;
}
