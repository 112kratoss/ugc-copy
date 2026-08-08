import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_RENDITION_ATTEMPTS, RENDITION_REPAIR_BYTE_BUDGET } from '@/lib/media-preview-repair';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260809110000_media_rendition_byte_admission.sql',
), 'utf8');

describe('media rendition byte admission migration', () => {
  it('takes the source size from storage rather than a column on post_media', () => {
    // post_media records rendition_bytes -- the *output* size, written after
    // transcoding -- and nothing for the source, so a count-only claim could
    // not tell twelve short clips from twelve 30MB ones. Joining keeps Storage
    // authoritative instead of adding a copy that can drift.
    expect(migration).toContain('LEFT JOIN storage.objects o');
    expect(migration).toContain("ON o.bucket_id = 'showcase_media'");
    expect(migration).toContain('AND o.name = pm.storage_path');
    expect(migration).toContain("(o.metadata->>'size')::bigint");
    expect(migration).not.toMatch(/ADD COLUMN[^;]*source_bytes/i);
  });

  it('admits on a running total in queue order, not a best-fit pack', () => {
    // Reordering to fill the budget would starve the oldest rows, and the
    // sweep depends on oldest-first to drain.
    expect(migration).toContain('ROWS UNBOUNDED PRECEDING');
    expect(migration).toContain('running_bytes');
    expect(migration).toMatch(/ORDER BY pm\.created_at ASC, pm\.id ASC/);
  });

  it('always admits the queue head so one huge object cannot wedge the sweep', () => {
    // Rows are taken oldest-first, so an object larger than the whole budget
    // would never be selected and would block everything behind it forever.
    expect(migration).toContain('WHERE candidates.rn = 1');
    expect(migration).toContain('OR candidates.running_bytes <=');
  });

  it('treats a missing storage object as free rather than unknown-and-expensive', () => {
    // Those rows fail on download without reaching ffmpeg, so they cost no
    // transcode budget; charging them would block the queue on a phantom cost.
    expect(migration).toContain("coalesce((o.metadata->>'size')::bigint, 0)");
  });

  it('mirrors the app-side status vocabulary and attempt cap', () => {
    // Drift here silently changes which rows the sweep can ever see.
    expect(migration).toContain("pm.rendition_status IN ('pending', 'processing', 'failed')");
    expect(migration).toContain('coalesce(pm.rendition_attempt_count, 0) < greatest(coalesce(p_max_attempts, 3), 1)');
    expect(MAX_RENDITION_ATTEMPTS).toBe(3);
  });

  it('defaults the byte budget to the value the sweep passes', () => {
    // The default only applies to callers that omit it, but a mismatch would
    // make the migration and the app disagree about the admission ceiling.
    expect(migration).toContain('p_byte_budget bigint DEFAULT 268435456');
    expect(RENDITION_REPAIR_BYTE_BUDGET).toBe(268435456);
  });

  it('bounds the scan before the byte filter runs', () => {
    // The byte predicate is evaluated over the candidate set, so without an
    // inner LIMIT a large backlog would be fully materialised every sweep.
    expect(migration).toContain('LIMIT least(greatest(coalesce(p_limit, 12), 1), 50)');
  });

  it('stays service-role only', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.list_media_rendition_repair_candidates(integer, bigint, integer) FROM anon, authenticated',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.list_media_rendition_repair_candidates(integer, bigint, integer) TO service_role',
    );
  });
});
