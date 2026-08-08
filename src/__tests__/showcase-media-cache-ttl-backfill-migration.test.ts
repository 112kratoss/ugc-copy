import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS } from '@/lib/showcase-media-cache';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260808120000_showcase_media_cache_ttl_backfill.sql',
), 'utf8');

describe('showcase media cache ttl backfill migration', () => {
  it('rewrites stored objects to the same TTL the application now writes', () => {
    // cacheControl is metadata fixed at upload time, so the constant alone only
    // governs new objects. If these two ever drift, freshly written media and
    // backfilled media disagree and neither is obviously wrong on inspection.
    expect(migration).toContain(`to_jsonb('max-age=${SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS}'::text)`);
  });

  it('edits only the cacheControl key, preserving the rest of the metadata', () => {
    // The same jsonb column carries mimetype, size and eTag. Replacing the
    // document instead of setting one key would strip them.
    expect(migration).toContain("jsonb_set(");
    expect(migration).toContain("'{cacheControl}'");
    expect(migration).not.toMatch(/set\s+metadata\s*=\s*'\{/i);
  });

  it('is scoped to the public showcase bucket', () => {
    // Private generation inputs and paid recipe files have their own policies,
    // and uploads is a staging bucket -- none of them should be swept up here.
    expect(migration).toContain("where bucket_id = 'showcase_media'");
  });

  it('is idempotent, so a replay touches nothing', () => {
    // Migrations replay from clean on every `db reset --local` and in CI.
    expect(migration).toContain("is distinct from 'max-age=86400'");
  });
});
