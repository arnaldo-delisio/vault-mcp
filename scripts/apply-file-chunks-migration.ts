#!/usr/bin/env node
/**
 * Apply file_chunks migration directly via SQL execution
 *
 * This is a workaround for IPv6 connectivity issues with psql
 */

import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  console.error('Error: DATABASE_URL not set');
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

const migration = `
-- Create file_chunks table
create table if not exists file_chunks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  chunk_index integer not null,
  chunk_text text not null,
  embedding extensions.vector(1536),
  created_at timestamptz default now(),
  unique(file_id, chunk_index)
);

-- Create indexes
create index if not exists file_chunks_embedding_idx
on file_chunks
using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists file_chunks_file_id_idx
on file_chunks(file_id);
`;

const rpcFunction = `
create or replace function hybrid_search_chunked(
  query_text text,
  query_embedding extensions.vector(1536),
  p_user_id uuid,
  match_count int default 20,
  content_type text default null
)
returns table (
  file_id uuid,
  path text,
  score float,
  snippet text
)
language sql
stable
security invoker
as $$
with keyword_results as (
  select
    f.id, f.path,
    row_number() over(order by f.updated_at desc) as rank_ix
  from files f
  where
    f.user_id = p_user_id
    and f.body ilike '%' || query_text || '%'
    and (content_type is null or f.frontmatter->>'type' = content_type)
  limit match_count * 2
),
chunk_semantic_results as (
  select
    fc.file_id,
    fc.chunk_text,
    fc.embedding <=> query_embedding as distance,
    row_number() over(order by fc.embedding <=> query_embedding) as rank_ix
  from file_chunks fc
  join files f on fc.file_id = f.id
  where
    f.user_id = p_user_id
    and fc.embedding is not null
    and query_embedding is not null
    and (content_type is null or f.frontmatter->>'type' = content_type)
  limit match_count * 2
),
semantic_results as (
  select
    file_id,
    min(distance) as best_distance,
    min(rank_ix) as rank_ix,
    (array_agg(chunk_text order by distance asc))[1] as best_chunk_text
  from chunk_semantic_results
  group by file_id
)
select
  coalesce(k.id, s.file_id) as file_id,
  coalesce(k.path, (select path from files where id = s.file_id)) as path,
  (coalesce(1.0 / (60 + k.rank_ix), 0.0) +
   coalesce(1.0 / (60 + s.rank_ix), 0.0))::float as score,
  case
    when s.best_chunk_text is not null then substring(s.best_chunk_text, 1, 150)
    else substring((select body from files where id = k.id), 1, 150)
  end as snippet
from keyword_results k
full outer join semantic_results s on k.id = s.file_id
order by
  (coalesce(1.0 / (60 + k.rank_ix), 0.0) +
   coalesce(1.0 / (60 + s.rank_ix), 0.0)) desc
limit match_count
$$;
`;

async function applyMigration() {
  console.log('Applying file_chunks migration...\n');

  try {
    await client.connect();
    console.log('Connected to database');

    // Apply table and indexes
    console.log('Creating file_chunks table and indexes...');
    await client.query(migration);
    console.log('✓ Table and indexes created');

    // Apply RPC function
    console.log('Creating hybrid_search_chunked function...');
    await client.query(rpcFunction);
    console.log('✓ Function created');

    // Verify
    const { rows } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'file_chunks'
    `);

    if (rows.length > 0) {
      console.log('\n✓ Migration applied successfully');
      console.log('  - file_chunks table exists');

      const { rows: rpcRows } = await client.query(`
        SELECT routine_name FROM information_schema.routines
        WHERE routine_name = 'hybrid_search_chunked'
      `);

      if (rpcRows.length > 0) {
        console.log('  - hybrid_search_chunked RPC exists');
      }
    } else {
      console.error('✗ Migration failed - table not found');
      process.exit(1);
    }

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

applyMigration();
