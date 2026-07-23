import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260723120000_post_resource_media_scope.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');

describe('post resource media scope migration', () => {
  it('adds and preserves stable proof-media keys', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS media_key text/i);
    expect(sql).toMatch(/SET media_key = 'media-' \|\| \(sort_order \+ 1\)::text/i);
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS post_media_post_media_key_idx/i);
    expect(sql).toMatch(/v_item->>'mediaKey'/);
    expect(sql).toMatch(/INSERT INTO public\.post_media \([\s\S]*post_id, media_key/i);
  });

  it('backfills resource IDs and defaults missing scopes to all outputs', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.normalize_post_resource_items/i);
    expect(sql).toContain("jsonb_build_object('kind', 'all')");
    expect(sql).toContain("jsonb_build_object('id', v_item_id, 'scope', v_scope)");
    expect(sql).toMatch(/UPDATE public\.post_resource_bundles[\s\S]*normalize_post_resource_items\(resource_items\)/i);
  });

  it('enforces the 10-token paid-package increment and recognizes new resource types', () => {
    expect(sql).toMatch(/price_usd_cents >= 10 AND price_usd_cents % 10 = 0/i);
    expect(sql).toContain("'reference_video'");
    expect(sql).toContain("'reference_audio'");
    expect(sql).toContain("'remix_link'");
  });
});
