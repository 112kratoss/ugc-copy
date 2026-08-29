import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260827110000_public_search.sql'),
  'utf8',
);

describe('public search migration', () => {
  it('creates backend-owned creator and post documents with GIN indexes', () => {
    expect(migration).toContain('CREATE TABLE public.post_search_documents');
    expect(migration).toContain('CREATE TABLE public.creator_search_documents');
    expect(migration).toContain('USING gin (search_vector)');
    expect(migration).toContain('extensions.gin_trgm_ops');
    expect(migration).toContain('REVOKE ALL ON TABLE public.post_search_documents FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('REVOKE ALL ON TABLE public.creator_search_documents FROM PUBLIC, anon, authenticated');
  });

  it('keeps search eligibility synchronized with safety state', () => {
    expect(migration).toContain("posts.visibility = 'public'");
    expect(migration).toContain('posts.archived_at IS NULL');
    expect(migration).toContain("posts.review_status = 'visible'");
    expect(migration).toContain('posts_refresh_public_search_document');
    expect(migration).toContain('posts_refresh_creator_search_document');
  });

  it('matches LIKE metacharacters literally instead of concatenating raw input', () => {
    expect(migration).toContain(
      String.raw`v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');`,
    );
    expect(migration).not.toContain("LIKE v_query");
    expect(migration).not.toContain("ILIKE ('%' || v_query || '%')");
  });

  it('exposes only backend search RPCs with bounded inputs', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.search_public_creators');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.search_public_posts');
    expect(migration).toContain('Creator search limit must be between 1 and 25');
    expect(migration).toContain('Post search limit must be between 1 and 25');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
  });
});
