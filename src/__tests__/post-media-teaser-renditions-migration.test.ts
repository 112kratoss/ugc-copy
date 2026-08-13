import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20260813120000_post_media_teaser_renditions.sql'),
  'utf8',
);

describe('post media teaser renditions migration', () => {
  it('adds the teaser columns to post_media', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS teaser_storage_path text');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS teaser_bytes bigint');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS teaser_generated_at timestamptz');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS teaser_error text');
  });

  it('guards the teaser path against traversal like the rendition path', () => {
    expect(migration).toContain('post_media_teaser_storage_path_safe_check');
    expect(migration).toContain("teaser_storage_path NOT LIKE '%..%'");
    expect(migration).toContain("teaser_storage_path !~ '^/'");
  });

  it('couples a recorded teaser path to its generation time', () => {
    // Path presence is the ready signal — there is no teaser_status column —
    // so the timestamp coupling is the only integrity the schema can enforce.
    expect(migration).toContain('post_media_teaser_path_requires_generated_at_check');
    expect(migration).toContain('teaser_storage_path IS NULL OR teaser_generated_at IS NOT NULL');
  });

  it('carries the teaser fields through replace_post_media', () => {
    // The function deletes and re-inserts every row on edit; omitting these
    // keys would silently strip teasers from every edited post.
    expect(migration).toContain("v_item->>'teaserStoragePath'");
    expect(migration).toContain("v_item->>'teaserBytes'");
    expect(migration).toContain("v_item->>'teaserGeneratedAt'");
    expect(migration).toContain("v_item->>'teaserError'");
    expect(migration).toContain('teaser_storage_path, teaser_bytes, teaser_generated_at, teaser_error');
  });

  it('recreates the claim RPC returning the existing teaser and probed duration', () => {
    // RETURNS TABLE is part of the function type, so widening it requires a
    // drop + recreate; the returned teaser path is what stops a worker from
    // regenerating a teaser that already exists.
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.claim_media_rendition_repairs(integer, bigint, text, integer, integer);',
    );
    expect(migration).toContain('teaser_storage_path text,');
    expect(migration).toContain('duration_seconds numeric');
    expect(migration).toContain('pm.teaser_storage_path, pm.duration_seconds');
  });

  it('keeps the claim predicate rendition-status-based', () => {
    // Teaser work rides the claimed rendition attempt; a teaser-specific
    // predicate would need its own budget, lock, and attempt machinery.
    expect(migration).not.toMatch(/WHERE[^;]*teaser_storage_path IS NULL/i);
  });

  it('keeps both functions restricted to the service role', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) FROM PUBLIC',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) TO service_role',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.claim_media_rendition_repairs(integer, bigint, text, integer, integer) FROM PUBLIC, anon, authenticated',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.claim_media_rendition_repairs(integer, bigint, text, integer, integer) TO service_role',
    );
  });
});
