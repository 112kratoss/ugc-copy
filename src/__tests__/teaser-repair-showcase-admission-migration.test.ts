import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20260909131000_teaser_repair_admits_showcase_renditions.sql', 'utf8');

it('admits a rendition under the linked generation without loosening the post-owned rule', () => {
  expect(sql).toContain("starts_with(pm.rendition_storage_path, 'posts/' || pm.post_id::text || '/')");
  expect(sql).toContain("starts_with(pm.rendition_storage_path, 'showcase/' || p.generation_id::text || '/')");
  // Ownership is the linked generation's, never any showcase/ prefix.
  expect(sql).toContain('p.generation_id is not null');
  expect(sql).toContain('join public.posts p on p.id = pm.post_id');
});

it('returns the generation id so the worker can repeat the ownership check', () => {
  expect(sql).toMatch(/RETURNS TABLE\(id uuid, post_id uuid, generation_id uuid, rendition_storage_path text, source_bytes bigint\)/);
  expect(sql).toContain('returning pm.id, pm.post_id, c.generation_id, pm.rendition_storage_path, c.bytes');
});

it('drops before recreating, because a changed result type cannot be replaced in place', () => {
  expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.claim_post_media_teaser_repair\(text, bigint\)/);
  expect(sql).toMatch(/CREATE FUNCTION public\.claim_post_media_teaser_repair\(p_locked_by text, p_max_bytes bigint DEFAULT 33554432\)/);
});

it('keeps every bound the original claim carried and stays service-only', () => {
  expect(sql).toMatch(/for update of pm skip locked/i);
  expect(sql).toContain('teaser_attempt_count = pm.teaser_attempt_count + 1');
  expect(sql).toContain('33554432');
  expect(sql).toContain("interval '5 minutes'");
  expect(sql).toMatch(/revoke all on function .* from public, anon, authenticated/i);
  expect(sql).toMatch(/grant execute on function .* to service_role/i);
  expect(sql).not.toMatch(/security definer|set rendition_status/i);
});
