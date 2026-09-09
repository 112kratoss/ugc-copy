import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20260909130000_generation_display_renditions.sql'),
  'utf8'
);

describe('generation display renditions migration', () => {
  it('adds a nullable display path beside preview_url', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS display_url text');
    // Null is the normal "not worth storing" answer; nothing may require it.
    expect(migration).not.toMatch(/display_url text NOT NULL/i);
  });

  it('carries the same traversal guard post_media.display_storage_path has', () => {
    expect(migration).toContain('generations_display_url_safe_check');
    expect(migration).toContain("display_url NOT LIKE '%..%'");
    expect(migration).toContain("display_url !~ '^/'");
    expect(migration).toContain('VALIDATE CONSTRAINT generations_display_url_safe_check');
  });

  it('leaves the settlement RPC alone', () => {
    // The display rendition is a cache with a fallback; the credit decision
    // stays single-effect and its pgTAP proof stays untouched.
    // The comment may name the RPC; the DDL must not touch any function.
    expect(migration).not.toMatch(/(CREATE|ALTER|DROP)\s+(OR REPLACE\s+)?FUNCTION/i);
    expect(migration).toMatch(/^ALTER TABLE public\.generations/m);
  });
});
