import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps reveal grants private, revision-bound and protected from direct Data API reads', () => {
  const sql = readFileSync('supabase/migrations/20260929120000_manual_nsfw_content.sql', 'utf8');
  expect(sql).toContain('p.nsfw_revision=r.revision');
  expect(sql).toContain('r.expires_at>now()');
  expect(sql).toContain('revoke all on public.content_preferences, public.nsfw_post_reveals from public, anon, authenticated');
  expect(sql).toContain('as restrictive for select to anon,authenticated');
  expect(sql).toContain('NSFW_PRIVATE_MEDIA_REQUIRED');
  expect(sql).toContain("new.is_public:=false");
});
