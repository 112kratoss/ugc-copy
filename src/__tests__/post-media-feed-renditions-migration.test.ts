import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20260727120000_post_media_feed_renditions.sql'),
  'utf8'
);

describe('post media feed renditions migration', () => {
  it('adds the rendition tracking columns to post_media', () => {
    expect(migration).toContain('ALTER TABLE public.post_media');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS rendition_storage_path text');
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS rendition_status text NOT NULL DEFAULT 'pending'");
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS rendition_attempt_count integer NOT NULL DEFAULT 0');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS rendition_error text');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS rendition_generated_at timestamptz');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS rendition_bytes bigint');
  });

  it('guards the rendition path against traversal like the preview path', () => {
    expect(migration).toContain('post_media_rendition_storage_path_safe_check');
    expect(migration).toContain("rendition_storage_path NOT LIKE '%..%'");
    expect(migration).toContain("rendition_storage_path !~ '^/'");
  });

  it('constrains rendition status and requires a path once ready', () => {
    expect(migration).toContain('post_media_rendition_status_check');
    expect(migration).toContain(
      "rendition_status IN ('pending', 'processing', 'ready', 'failed', 'skipped')"
    );
    expect(migration).toContain('post_media_rendition_ready_requires_path_check');
    expect(migration).toContain(
      "rendition_status <> 'ready' OR rendition_storage_path IS NOT NULL"
    );
  });

  it('retires non-video rows so the repair sweep never revisits them', () => {
    expect(migration).toContain("SET rendition_status = 'skipped'");
    expect(migration).toContain("WHERE media_kind <> 'video'");
  });

  it('indexes only unresolved video rows for the repair sweep', () => {
    expect(migration).toContain('post_media_rendition_pending_idx');
    expect(migration).toContain("WHERE media_kind = 'video'");
    expect(migration).toContain("rendition_status IN ('pending', 'processing', 'failed')");
  });

  it('carries rendition columns through replace_post_media', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.replace_post_media');
    expect(migration).toContain("v_item->>'renditionStoragePath'");
    expect(migration).toContain("v_item->>'renditionStatus'");
    expect(migration).toContain("v_item->>'renditionBytes'");
    // An edit must not silently downgrade a video row to a terminal state.
    expect(migration).toContain(
      "CASE WHEN v_item->>'mediaKind' = 'video' THEN 'pending' ELSE 'skipped' END"
    );
  });

  it('keeps replace_post_media restricted to the service role', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) FROM PUBLIC');
    expect(migration).toContain('FROM anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) TO service_role');
  });
});
