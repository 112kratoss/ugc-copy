-- The rendition sweep always runs the first row a claim hands back and refunds
-- the ones its time budget leaves unstarted, so the claim must hand rows back
-- oldest first. An UPDATE ... RETURNING returns them in whatever order its
-- join reads post_media, which under a hash join is heap order: a newer row
-- stored before the queue head was run in its place.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(2);

insert into auth.users (id, email, aud, role, created_at)
values (
  'cd100000-0000-4000-8000-000000000001'::uuid, 'rendition-claim-order@example.invalid',
  'authenticated', 'authenticated', now() - interval '30 days'
);
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, showcase_asset_path)
values (
  'cd200000-0000-4000-8000-000000000001'::uuid, 'cd100000-0000-4000-8000-000000000001'::uuid,
  'private', 'video', 'manual', 'media', 'posts/cd200000-0000-4000-8000-000000000001/first.mp4'
);

-- The newer row is written first, so it sits before the queue head in the heap.
insert into public.post_media (
  id, post_id, storage_path, media_kind, content_type, sort_order,
  preview_status, rendition_status, rendition_attempt_count, created_at
)
values (
  'cd300000-0000-4000-8000-00000000000b'::uuid, 'cd200000-0000-4000-8000-000000000001'::uuid,
  'posts/cd200000-0000-4000-8000-000000000001/newer.mp4', 'video', 'video/mp4', 1,
  'pending', 'pending', 0, now() + interval '1 second'
);
insert into public.post_media (
  id, post_id, storage_path, media_kind, content_type, sort_order,
  preview_status, rendition_status, rendition_attempt_count, created_at
)
values (
  'cd300000-0000-4000-8000-00000000000a'::uuid, 'cd200000-0000-4000-8000-000000000001'::uuid,
  'posts/cd200000-0000-4000-8000-000000000001/head.mp4', 'video', 'video/mp4', 0,
  'pending', 'pending', 0, now()
);

-- A hash join reads post_media in heap order.
set local enable_nestloop = off;
set local enable_mergejoin = off;
create temp table hash_claim on commit drop as
select claimed.id, claimed.position
from public.claim_media_rendition_repairs(2, 268435456, 'claim-order-hash', 300, 3)
  with ordinality as claimed(id, storage_path, content_type, rendition_attempt_count, source_bytes, teaser_storage_path, duration_seconds, position)
where claimed.id in ('cd300000-0000-4000-8000-00000000000a', 'cd300000-0000-4000-8000-00000000000b');
reset enable_nestloop;
reset enable_mergejoin;

select results_eq(
  $$ select id from hash_claim order by position $$,
  $$ values ('cd300000-0000-4000-8000-00000000000a'::uuid), ('cd300000-0000-4000-8000-00000000000b'::uuid) $$,
  'a claim read in heap order still hands back the queue head first'
);

-- Released, as the sweep releases the rows its budget left unstarted.
update public.post_media
set rendition_status = 'pending', rendition_attempt_count = 0, rendition_locked_at = null, rendition_locked_by = null
where post_id = 'cd200000-0000-4000-8000-000000000001';

create temp table default_claim on commit drop as
select claimed.id, claimed.position
from public.claim_media_rendition_repairs(2, 268435456, 'claim-order-default', 300, 3)
  with ordinality as claimed(id, storage_path, content_type, rendition_attempt_count, source_bytes, teaser_storage_path, duration_seconds, position)
where claimed.id in ('cd300000-0000-4000-8000-00000000000a', 'cd300000-0000-4000-8000-00000000000b');

select results_eq(
  $$ select id from default_claim order by position $$,
  $$ values ('cd300000-0000-4000-8000-00000000000a'::uuid), ('cd300000-0000-4000-8000-00000000000b'::uuid) $$,
  'so does a claim under whatever plan the planner picks'
);

select * from finish();
rollback;
