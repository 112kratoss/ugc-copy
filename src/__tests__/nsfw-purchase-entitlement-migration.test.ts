import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261015013717_nsfw_purchase_entitlement.sql', 'utf8');

it('lets a buyer past the mature gate for the post they unlocked, and no one else', () => {
  // The purchase clause sits beside the owner and reveal clauses of the 2026-09-29 gate.
  expect(sql).toContain('create or replace function public.can_read_nsfw_post(p_post_id uuid,p_viewer_id uuid)');
  expect(sql).toContain('not p.is_nsfw or p.user_id=p_viewer_id or public.has_nsfw_reveal(p.id,p_viewer_id)');
  expect(sql).toContain('where bundle.post_id=p.id and purchase.buyer_user_id=p_viewer_id');
  expect(sql).toContain('and purchase.moderation_retracted_at is null');
});

it('keeps both functions backend-only after the replace', () => {
  expect(sql).toContain('revoke all on function public.can_read_nsfw_post(uuid,uuid) from public,anon,authenticated');
  expect(sql).toContain('grant execute on function public.can_read_nsfw_post(uuid,uuid) to service_role');
  expect(sql).toContain('revoke all on function public.can_read_private_post_media(text,uuid) from public,anon,authenticated');
  expect(sql).toContain('grant execute on function public.can_read_private_post_media(text,uuid) to service_role');
});

it('routes the live-post media read through the shared gate and keeps the block and lifecycle checks', () => {
  expect(sql).toContain('create or replace function public.can_read_private_post_media(p_path text,p_viewer_id uuid)');
  expect(sql).toContain('and public.can_read_nsfw_post(p.id,p_viewer_id)');
  expect(sql).not.toContain('not p.is_nsfw or public.has_nsfw_reveal(p.id,p_viewer_id)');
  expect(sql).toContain("p.visibility in ('public','unlisted') and p.archived_at is null");
  expect(sql).toContain("p.review_status='visible' and p.tombstoned_at is null");
  expect(sql).toContain('b.blocker_user_id=p_viewer_id and b.blocked_user_id=p.user_id');
  expect(sql).toContain("owner.identity_state not in ('deleting','deleted','merged')");
});

it('reads the purchase snapshot for the buyer named on the purchase, detached or not', () => {
  expect(sql).toContain('where purchase.buyer_user_id=p_viewer_id and purchase.moderation_retracted_at is null');
  expect(sql).toContain('and (bundle.post_id is null or public.can_read_nsfw_post(bundle.post_id,p_viewer_id))');
  expect(sql).toContain('p_path=any(array[m.storage_path,m.preview_storage_path,m.rendition_storage_path])');
});
