import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20260909060000_reserve_media_repair_attempts_on_claim.sql'),
  'utf8'
);

describe('reserve media repair attempts on claim migration', () => {
  it('reserves the attempt in all three claim functions', () => {
    // A worker killed before its own write used to leave the counter
    // untouched, so the same source was downloaded again every sweep.
    expect(migration).toContain('preview_attempt_count = generation_rows.preview_attempt_count + 1');
    expect(migration).toContain('preview_attempt_count = media_rows.preview_attempt_count + 1');
    expect(migration).toContain('rendition_attempt_count = pm.rendition_attempt_count + 1');
  });

  it('keeps the budget filter that bounds the reservation', () => {
    expect(migration).toContain('preview_attempt_count < greatest(p_max_attempts, 1)');
    expect(migration).toContain('rendition_attempt_count < greatest(p_max_attempts, 1)');
  });

  it('returns the reserved ordinal so the worker writes it rather than adding to it', () => {
    expect(migration).toContain('RETURNING generation_rows.id, generation_rows.output_url, generation_rows.category,\n            generation_rows.preview_attempt_count');
    expect(migration).toContain('media_rows.content_type, media_rows.preview_attempt_count');
    expect(migration).toContain('RETURNING pm.id, pm.storage_path, pm.content_type, pm.rendition_attempt_count');
  });

  it('keeps the lease and the skip-locked selection intact', () => {
    expect(migration).toContain("preview_status = 'processing'");
    expect(migration).toContain("rendition_status = 'processing'");
    expect(migration).toContain('FOR UPDATE SKIP LOCKED');
    expect(migration).toContain('FOR UPDATE OF pm SKIP LOCKED');
  });

  it('re-issues the service-role grants these functions are restricted to', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.claim_generation_preview_repairs(integer, text, integer, integer) FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.claim_media_rendition_repairs(integer, bigint, text, integer, integer) TO service_role');
  });
});
