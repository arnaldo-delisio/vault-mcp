# Smart Chunk Sampling for read_note Search

## Problem

Current implementation returns top 5 matching chunks when searching large files.
- 242k char video = 45 chunks
- 5 chunks = only 11% of content
- Insufficient for full conversation about video

## Solution: Smart Sampling + Multi-turn

Combine:
1. **Smart Sampling**: Top matches + context chunks (beginning/middle/end)
2. **More Chunks**: Increase from 5 to 10 default
3. **Multi-turn Awareness**: Show chunk indices for follow-up queries

## Implementation

### Enhanced searchInChunks Function

```typescript
async function searchInChunks(
  filePath: string,
  searchQuery: string,
  limit: number = 10  // Increased from 5
): Promise<string> {
  // Get total chunk count for this file
  const { count: totalChunks } = await supabase
    .from('file_chunks')
    .select('*', { count: 'exact', head: true })
    .eq('file_id', fileData.id);

  // 1. Get top matching chunks (keyword + semantic)
  const topMatches = await getTopMatchingChunks(fileData.id, searchQuery, limit - 3);

  // 2. Add context chunks for coverage
  const contextChunks = await getContextChunks(fileData.id, totalChunks, topMatches);

  // 3. Merge and deduplicate
  const allChunks = mergeChunks(topMatches, contextChunks);

  // 4. Format with chunk context
  return formatChunksWithContext(allChunks, totalChunks, searchQuery, filePath);
}
```

### Context Chunk Selection

```typescript
async function getContextChunks(fileId: string, totalChunks: number, topMatches: any[]) {
  const matchedIndices = new Set(topMatches.map(c => c.chunk_index));
  const contextIndices = [];

  // Beginning: chunk 0-2 (if not already matched)
  if (!matchedIndices.has(0)) contextIndices.push(0);

  // Middle: chunk around totalChunks/2 (if not already matched)
  const middleIdx = Math.floor(totalChunks / 2);
  if (!matchedIndices.has(middleIdx)) contextIndices.push(middleIdx);

  // End: last chunk (if not already matched)
  const endIdx = totalChunks - 1;
  if (!matchedIndices.has(endIdx)) contextIndices.push(endIdx);

  // Fetch context chunks
  return await supabase
    .from('file_chunks')
    .select('chunk_index, chunk_text')
    .eq('file_id', fileId)
    .in('chunk_index', contextIndices);
}
```

### Output Format

```
Found 10 relevant sections for "thumbnail workflow" in library/youtube/video.md:

Showing chunks: 0 (intro), 12, 15, 23 (middle), 28, 35, 38, 42, 45 (end)
Total: 45 chunks in file (~270k chars)

--- Section 1: Introduction (chunk 0/45) ---
[First chunk with video intro and overview]

--- Section 2: Relevant Match (chunk 12/45) ---
[Matching chunk about thumbnails]

--- Section 3: Relevant Match (chunk 15/45) ---
[Another matching chunk]

... [more sections] ...

💡 Multi-turn tips:
- Ask follow-up questions to explore specific topics
- Request "chunks around 23" for more context near a specific section
- Search for different keywords to find other relevant sections
```

## Benefits

✅ **Better coverage**: 22% of content instead of 11% (10 chunks vs 5)
✅ **Context awareness**: Beginning/middle/end chunks provide narrative structure
✅ **Multi-turn friendly**: Shows chunk positions for targeted follow-ups
✅ **Scalable**: Works for any file size (3 chunks to 100+ chunks)

## File Locations

- Implementation: `src/tools/read.ts` (searchInChunks function)
- Helper functions: Add getContextChunks, mergeChunks, formatChunksWithContext
- Tests: Add test for 45-chunk file showing smart sampling

## Future Enhancements

1. **Configurable limit**: Add optional `limit` parameter to read_note
2. **Chunk range requests**: `read_note(path, chunks: "20-25")` for specific ranges
3. **Connected chunks**: If chunk 23 matches, include 22+24 for continuity
4. **Summary generation**: Use Claude to summarize full file, then provide chunks

## Status

- [x] Implementation document created
- [ ] Code implementation
- [ ] Testing with large files
- [ ] Documentation update
- [ ] Deployment

---

Created: 2026-01-31
Author: Arnaldo + Claude Sonnet 4.5
Context: Phase 3.2 post-completion enhancement
