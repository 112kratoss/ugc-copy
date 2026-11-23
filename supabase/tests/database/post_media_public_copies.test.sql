-- Public copies of a post's own uploaded media (20261123153250): who may be
-- served one, how one is made, and every write that takes them back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(73);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at) values
  ('ac100000-0000-4000-8000-000000000001', 'copies-owner@example.invalid', 'authenticated', 'authenticated', '{}', '{}', now()),
  ('ac100000-0000-4000-8000-000000000002', 'copies-leaver@example.invalid', 'authenticated', 'authenticated', '{}', '{}', now());

-- A public post made from uploads, its gallery row and both buckets' objects,
-- its copies made and recorded the way publish makes them.
create function pg_temp.copied_post(p_post uuid, p_owner uuid default 'ac100000-0000-4000-8000-000000000001')
returns void language plpgsql as $$
begin
  insert into public.posts (id, user_id, visibility, category, source_kind, post_format, showcase_asset_path)
  values (p_post, p_owner, 'private', 'image', 'manual', 'media', 'private-posts/' || p_post || '/0/photo.jpg');
  insert into public.post_media (post_id, storage_path, preview_storage_path, media_kind, sort_order)
  values (p_post, 'private-posts/' || p_post || '/0/photo.jpg', 'private-posts/' || p_post || '/0/photo.preview.webp', 'image', 0);
  update public.posts set visibility = 'public' where id = p_post;
  insert into storage.objects (bucket_id, name, metadata) values
    ('post_media', 'private-posts/' || p_post || '/0/photo.jpg', '{"size":100}'),
    ('post_media', 'private-posts/' || p_post || '/0/photo.preview.webp', '{"size":10}'),
    ('showcase_media', 'public-posts/' || p_post || '/0/photo.jpg', '{"size":100}'),
    ('showcase_media', 'public-posts/' || p_post || '/0/photo.preview.webp', '{"size":10}');
  perform * from public.begin_post_media_public_copies(p_post);
  perform public.commit_post_media_public_copies(p_post, array[
    'public-posts/' || p_post || '/0/photo.jpg', 'public-posts/' || p_post || '/0/photo.preview.webp']);
end;
$$;

create function pg_temp.recorded(p_post uuid) returns integer language sql as $$
  select coalesce(sum(cardinality(public_copy_paths)), 0)::integer from public.post_media where post_id = p_post;
$$;

create function pg_temp.queued(p_post uuid, p_reason text) returns integer language sql as $$
  select count(*)::integer from public.post_media_public_copy_queue
  where post_id = p_post and reason = p_reason and next_attempt_at <= now();
$$;

-- Nobody but the backend may call any of it.
select ok(not has_function_privilege('anon', 'public.begin_post_media_public_copies(uuid)', 'execute'), 'anon cannot begin copies');
select ok(not has_function_privilege('authenticated', 'public.commit_post_media_public_copies(uuid,text[])', 'execute'), 'a signed-in user cannot record copies');
select ok(not has_function_privilege('authenticated', 'public.claim_post_media_public_copy_removal(text)', 'execute'), 'a signed-in user cannot claim removals');
select ok(has_function_privilege('service_role', 'public.begin_post_media_public_copies(uuid)', 'execute'), 'the backend begins copies');
select ok(not has_table_privilege('authenticated', 'public.post_media_public_copy_queue', 'select'), 'the queue is not on the Data API');
select ok(not has_table_privilege('service_role', 'public.post_media_public_copy_queue', 'insert'), 'the backend changes the queue only through the functions');

-- Begin queues a copy before any object exists, for a post anyone may read only.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, showcase_asset_path)
values ('bc100000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000001', 'private', 'image', 'manual', 'media',
  'private-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg');
insert into public.post_media (post_id, storage_path, media_kind, sort_order)
values ('bc100000-0000-4000-8000-000000000001', 'private-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg', 'image', 0);
insert into storage.objects (bucket_id, name, metadata) values
  ('post_media', 'private-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg', '{"size":100}');
select is((select count(*)::integer from public.begin_post_media_public_copies('bc100000-0000-4000-8000-000000000001')), 0,
  'a private post gets no copy');
update public.posts set visibility = 'public' where id = 'bc100000-0000-4000-8000-000000000001';
select results_eq(
  $$select source_path, copy_path from public.begin_post_media_public_copies('bc100000-0000-4000-8000-000000000001')$$,
  $$values ('private-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg'::text, 'public-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg'::text)$$,
  'a public post names its own private object and the copy it gets');
select ok(exists(select 1 from public.post_media_public_copy_queue
  where public_path = 'public-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg' and reason = 'copying'
    and next_attempt_at > now() and copy_began_at = now()),
  'the copy is queued, stamped with when it began and a grace for it, before any object exists');

-- Commit records only a copy Storage holds at its source's size.
select is(public.commit_post_media_public_copies('bc100000-0000-4000-8000-000000000001',
  array['public-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg']), '{}'::text[], 'no object: nothing recorded');
select is(pg_temp.queued('bc100000-0000-4000-8000-000000000001', 'copy_refused'), 1, 'a refused copy stays queued, due now');
insert into storage.objects (bucket_id, name, metadata) values
  ('showcase_media', 'public-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg', '{"size":99}');
do $$ begin perform * from public.begin_post_media_public_copies('bc100000-0000-4000-8000-000000000001'); end $$;
select is(public.commit_post_media_public_copies('bc100000-0000-4000-8000-000000000001',
  array['public-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg']), '{}'::text[], 'a copy of another size is not recorded');
update storage.objects set metadata = '{"size":100}'
where bucket_id = 'showcase_media' and name = 'public-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg';
do $$ begin perform * from public.begin_post_media_public_copies('bc100000-0000-4000-8000-000000000001'); end $$;
select is(public.commit_post_media_public_copies('bc100000-0000-4000-8000-000000000001',
  array['public-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg']),
  array['public-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg'], 'a verified copy is recorded');
select is((select public_copy_paths from public.post_media where post_id = 'bc100000-0000-4000-8000-000000000001'),
  array['public-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg'], 'on the row that names its source');
select is((select reason from public.post_media_public_copy_queue where post_id = 'bc100000-0000-4000-8000-000000000001'), 'copying',
  'its queue row stays while a copy begun under 15 minutes ago may still land');
select is(public.claim_post_media_public_copy_removal('public-posts/bc100000-0000-4000-8000-000000000001/0/photo.jpg')->>'outcome',
  'served', 'a claim on it answers served and takes nothing');
select is((select count(*)::integer from public.begin_post_media_public_copies('bc100000-0000-4000-8000-000000000001')), 0,
  'a recorded copy is not begun again');
select throws_ok($$select public.commit_post_media_public_copies('bc100000-0000-4000-8000-000000000001',
  array['public-posts/bc100000-0000-4000-8000-000000000009/0/photo.jpg'])$$, '22023', 'Invalid public copy path',
  'a copy outside the post''s own folder is refused');

-- Two syncs of one post at once: both begin, the first commits, and the
-- second's commit takes the copy as recorded rather than queueing it.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, showcase_asset_path)
values ('bd100000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000001', 'private', 'image', 'manual', 'media',
  'private-posts/bd100000-0000-4000-8000-000000000001/0/photo.jpg');
insert into public.post_media (post_id, storage_path, media_kind, sort_order)
values ('bd100000-0000-4000-8000-000000000001', 'private-posts/bd100000-0000-4000-8000-000000000001/0/photo.jpg', 'image', 0);
update public.posts set visibility = 'public' where id = 'bd100000-0000-4000-8000-000000000001';
insert into storage.objects (bucket_id, name, metadata) values
  ('post_media', 'private-posts/bd100000-0000-4000-8000-000000000001/0/photo.jpg', '{"size":100}'),
  ('showcase_media', 'public-posts/bd100000-0000-4000-8000-000000000001/0/photo.jpg', '{"size":100}');
select is((select count(*)::integer from public.begin_post_media_public_copies('bd100000-0000-4000-8000-000000000001')), 1, 'sync A begins');
select is((select count(*)::integer from public.begin_post_media_public_copies('bd100000-0000-4000-8000-000000000001')), 1, 'sync B begins');
select is(public.commit_post_media_public_copies('bd100000-0000-4000-8000-000000000001',
  array['public-posts/bd100000-0000-4000-8000-000000000001/0/photo.jpg']),
  array['public-posts/bd100000-0000-4000-8000-000000000001/0/photo.jpg'], 'sync A records the copy');
select is(public.commit_post_media_public_copies('bd100000-0000-4000-8000-000000000001',
  array['public-posts/bd100000-0000-4000-8000-000000000001/0/photo.jpg']),
  array['public-posts/bd100000-0000-4000-8000-000000000001/0/photo.jpg'], 'sync B commits the copy A recorded');
select is(public.claim_post_media_public_copy_removal('public-posts/bd100000-0000-4000-8000-000000000001/0/photo.jpg')->>'outcome',
  'served', 'and leaves nothing a removal could take');
select is(pg_temp.recorded('bd100000-0000-4000-8000-000000000001'), 1, 'the copy stays recorded');

-- Only objects Storage holds are copy sources, and a feed rendition only once it is ready.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, showcase_asset_path)
values ('be100000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000001', 'private', 'video', 'manual', 'media',
  'private-posts/be100000-0000-4000-8000-000000000001/0/clip.mp4');
insert into public.post_media (post_id, storage_path, rendition_storage_path, rendition_status, media_kind, sort_order)
values ('be100000-0000-4000-8000-000000000001', 'private-posts/be100000-0000-4000-8000-000000000001/0/clip.mp4',
  'private-posts/be100000-0000-4000-8000-000000000001/0/clip.feed.mp4', 'processing', 'video', 0);
update public.posts set visibility = 'public' where id = 'be100000-0000-4000-8000-000000000001';
insert into storage.objects (bucket_id, name, metadata) values
  ('post_media', 'private-posts/be100000-0000-4000-8000-000000000001/0/clip.feed.mp4', '{"size":50}');
select is((select count(*)::integer from public.post_media_public_copy_sources('be100000-0000-4000-8000-000000000001')), 0,
  'a missing original and an unready rendition are not copy sources');
update public.post_media set rendition_status = 'ready' where post_id = 'be100000-0000-4000-8000-000000000001';
select results_eq(
  $$select private_object, object_bytes from public.post_media_public_copy_sources('be100000-0000-4000-8000-000000000001')$$,
  $$values ('private-posts/be100000-0000-4000-8000-000000000001/0/clip.feed.mp4'::text, 50::bigint)$$,
  'a ready rendition Storage holds is one, with its size');

-- The row thumb (20261123152813) lives only in a creation's public folder:
-- never a copy source, and a write that names it leaves the row's copies be.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, showcase_asset_path)
values ('bf300000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000001', 'private', 'image', 'manual', 'media',
  'private-posts/bf300000-0000-4000-8000-000000000001/0/photo.jpg');
insert into public.post_media (post_id, storage_path, preview_storage_path, thumb_storage_path, media_kind, sort_order)
values ('bf300000-0000-4000-8000-000000000001', 'private-posts/bf300000-0000-4000-8000-000000000001/0/photo.jpg',
  'showcase/cf300000-0000-4000-8000-000000000001/photo.preview.webp',
  'showcase/cf300000-0000-4000-8000-000000000001/photo.thumb.webp', 'image', 0);
update public.posts set visibility = 'public' where id = 'bf300000-0000-4000-8000-000000000001';
insert into storage.objects (bucket_id, name, metadata) values
  ('post_media', 'private-posts/bf300000-0000-4000-8000-000000000001/0/photo.jpg', '{"size":100}'),
  ('showcase_media', 'public-posts/bf300000-0000-4000-8000-000000000001/0/photo.jpg', '{"size":100}');
select results_eq(
  $$select private_object from public.post_media_public_copy_sources('bf300000-0000-4000-8000-000000000001')$$,
  $$values ('private-posts/bf300000-0000-4000-8000-000000000001/0/photo.jpg'::text)$$,
  'a row thumb in a creation''s public folder is no copy source');
do $$ begin perform * from public.begin_post_media_public_copies('bf300000-0000-4000-8000-000000000001'); end $$;
do $$ begin perform public.commit_post_media_public_copies('bf300000-0000-4000-8000-000000000001',
  array['public-posts/bf300000-0000-4000-8000-000000000001/0/photo.jpg']); end $$;
update public.post_media set thumb_storage_path = thumb_storage_path
where post_id = 'bf300000-0000-4000-8000-000000000001';
select is(pg_temp.recorded('bf300000-0000-4000-8000-000000000001'), 1, 'a write naming the thumb keeps the row''s copies');

-- A removal that verifies a path gone while a copy of it began minutes ago
-- keeps the row until that copy could no longer land.
do $$ begin perform * from public.begin_post_media_public_copies('be100000-0000-4000-8000-000000000001'); end $$;
update public.posts set visibility = 'private' where id = 'be100000-0000-4000-8000-000000000001';
select is(public.finish_post_media_public_copy_removal('public-posts/be100000-0000-4000-8000-000000000001/0/clip.feed.mp4',
  ((public.claim_post_media_public_copy_removal('public-posts/be100000-0000-4000-8000-000000000001/0/clip.feed.mp4'))->>'token')::uuid),
  'held', 'a copy begun under 15 minutes ago holds its row after the object is verified gone');
select ok((select next_attempt_at = copy_began_at + interval '15 minutes' and claim_token is null
  from public.post_media_public_copy_queue where public_path = 'public-posts/be100000-0000-4000-8000-000000000001/0/clip.feed.mp4'),
  'due again once the copy could no longer land, its claim let go');
update public.post_media_public_copy_queue set copy_began_at = now() - interval '16 minutes'
where public_path = 'public-posts/be100000-0000-4000-8000-000000000001/0/clip.feed.mp4';
select is(public.finish_post_media_public_copy_removal('public-posts/be100000-0000-4000-8000-000000000001/0/clip.feed.mp4',
  ((public.claim_post_media_public_copy_removal('public-posts/be100000-0000-4000-8000-000000000001/0/clip.feed.mp4'))->>'token')::uuid),
  'removed', 'once that window has passed the row leaves');

-- A failed removal is tried again within the hour, however many times it failed.
insert into public.post_media_public_copy_queue (public_path, post_id, reason, attempt_count)
values ('public-posts/be100000-0000-4000-8000-000000000001/0/retry.mp4', 'be100000-0000-4000-8000-000000000001', 'unexposed', 7);
do $$ begin perform public.reschedule_post_media_public_copy_removal('public-posts/be100000-0000-4000-8000-000000000001/0/retry.mp4',
  ((public.claim_post_media_public_copy_removal('public-posts/be100000-0000-4000-8000-000000000001/0/retry.mp4'))->>'token')::uuid,
  'storage unavailable'); end $$;
select ok((select next_attempt_at <= now() + interval '1 hour' and attempt_count = 8
  from public.post_media_public_copy_queue where public_path = 'public-posts/be100000-0000-4000-8000-000000000001/0/retry.mp4'),
  'the backoff stops at an hour');

-- A row records only the public twin of one of its own private paths.
select throws_ok($$update public.post_media set public_copy_paths = array['public-posts/bc100000-0000-4000-8000-000000000001/0/other.jpg']
  where post_id = 'bc100000-0000-4000-8000-000000000001'$$, '23514', null, 'a path that is not a twin is refused');
select throws_ok($$update public.post_media set public_copy_paths = array[null::text]
  where post_id = 'bc100000-0000-4000-8000-000000000001'$$, '23514', null, 'a null path is refused');

-- Every write that ends public reading takes the copies back in its own transaction.
do $$ begin perform pg_temp.copied_post('bc200000-0000-4000-8000-000000000001'); end $$;
select is(pg_temp.recorded('bc200000-0000-4000-8000-000000000001'), 2, 'fixture: both copies recorded');
update public.posts set visibility = 'private' where id = 'bc200000-0000-4000-8000-000000000001';
select is(pg_temp.recorded('bc200000-0000-4000-8000-000000000001'), 0, 'made private: nothing recorded');
select is(pg_temp.queued('bc200000-0000-4000-8000-000000000001', 'unexposed'), 2, 'made private: both copies queued, due now');

do $$ begin perform pg_temp.copied_post('bc300000-0000-4000-8000-000000000001'); end $$;
update public.posts set archived_at = now() where id = 'bc300000-0000-4000-8000-000000000001';
select is(pg_temp.recorded('bc300000-0000-4000-8000-000000000001'), 0, 'archived: nothing recorded');
select is(pg_temp.queued('bc300000-0000-4000-8000-000000000001', 'unexposed'), 2, 'archived: both queued');

do $$ begin perform pg_temp.copied_post('bc400000-0000-4000-8000-000000000001'); end $$;
update public.posts set review_status = 'hidden' where id = 'bc400000-0000-4000-8000-000000000001';
select is(pg_temp.recorded('bc400000-0000-4000-8000-000000000001'), 0, 'hidden by moderation: nothing recorded');
select is(pg_temp.queued('bc400000-0000-4000-8000-000000000001', 'unexposed'), 2, 'hidden by moderation: both queued');

do $$ begin perform pg_temp.copied_post('bc500000-0000-4000-8000-000000000001'); end $$;
update public.posts set review_status = 'flagged' where id = 'bc500000-0000-4000-8000-000000000001';
select is(pg_temp.recorded('bc500000-0000-4000-8000-000000000001'), 0, 'flagged (held for review): nothing recorded');

do $$ begin perform pg_temp.copied_post('bc600000-0000-4000-8000-000000000001'); end $$;
update public.posts set is_nsfw = true where id = 'bc600000-0000-4000-8000-000000000001';
select is(pg_temp.recorded('bc600000-0000-4000-8000-000000000001'), 0, 'marked NSFW: nothing recorded');
select is(pg_temp.queued('bc600000-0000-4000-8000-000000000001', 'unexposed'), 2, 'marked NSFW: both queued');

do $$ begin perform pg_temp.copied_post('bc700000-0000-4000-8000-000000000001'); end $$;
update public.posts set tombstoned_at = now(), archived_at = now(), visibility = 'private'
where id = 'bc700000-0000-4000-8000-000000000001';
select is(pg_temp.recorded('bc700000-0000-4000-8000-000000000001'), 0, 'tombstoned for its buyers: nothing recorded');
select ok(exists(select 1 from public.post_media where post_id = 'bc700000-0000-4000-8000-000000000001'
  and storage_path = 'private-posts/bc700000-0000-4000-8000-000000000001/0/photo.jpg'),
  'tombstoned: the private media buyers read stays named');

do $$ begin perform pg_temp.copied_post('bc800000-0000-4000-8000-000000000001'); end $$;
delete from public.posts where id = 'bc800000-0000-4000-8000-000000000001';
select is(pg_temp.queued('bc800000-0000-4000-8000-000000000001', 'post_deleted'), 2, 'deleted: both copies queued under the gone post');

do $$ begin perform pg_temp.copied_post('bc900000-0000-4000-8000-000000000001'); end $$;
delete from public.post_media where post_id = 'bc900000-0000-4000-8000-000000000001';
select is(pg_temp.queued('bc900000-0000-4000-8000-000000000001', 'media_removed'), 2, 'a gallery save that drops the row queues its copies');

do $$ begin perform pg_temp.copied_post('bca00000-0000-4000-8000-000000000001'); end $$;
update public.post_media set preview_storage_path = 'private-posts/bca00000-0000-4000-8000-000000000001/0/photo.preview.v2.webp'
where post_id = 'bca00000-0000-4000-8000-000000000001';
select is((select public_copy_paths from public.post_media where post_id = 'bca00000-0000-4000-8000-000000000001'),
  array['public-posts/bca00000-0000-4000-8000-000000000001/0/photo.jpg'], 'a replaced derivative stops being recorded, the rest stays');
select is(pg_temp.queued('bca00000-0000-4000-8000-000000000001', 'media_removed'), 1, 'and its old copy is queued');
update public.post_media set rendition_storage_path = 'private-posts/bca00000-0000-4000-8000-000000000001/0/photo.feed.mp4'
where post_id = 'bca00000-0000-4000-8000-000000000001';
select is(pg_temp.recorded('bca00000-0000-4000-8000-000000000001'), 1, 'a sweep recording a new derivative keeps the copies there are');

do $$ begin perform pg_temp.copied_post('bcb00000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000002'); end $$;
update public.profiles set identity_state = 'deleting' where id = 'ac100000-0000-4000-8000-000000000002';
select is(pg_temp.recorded('bcb00000-0000-4000-8000-000000000001'), 0, 'an owner deleting their account: nothing recorded');
select is(pg_temp.queued('bcb00000-0000-4000-8000-000000000001', 'owner_inactive'), 2, 'an owner deleting their account: both queued');

-- No transaction may end with a copy recorded on a post nobody signed out may read.
set constraints z_post_media_public_copies_allowed immediate;
select throws_ok($$update public.post_media set public_copy_paths = array['public-posts/bc200000-0000-4000-8000-000000000001/0/photo.jpg']
  where post_id = 'bc200000-0000-4000-8000-000000000001'$$, '23514', 'POST_MEDIA_PUBLIC_COPY_NOT_ALLOWED',
  'recording a copy on a private post is refused');
set constraints z_post_media_public_copies_allowed deferred;
set constraints z_posts_media_public_copies_allowed immediate;
do $$ begin perform pg_temp.copied_post('bcc00000-0000-4000-8000-000000000001'); end $$;
select lives_ok($$update public.posts set visibility = 'private' where id = 'bcc00000-0000-4000-8000-000000000001'$$,
  'a post made private passes the check at once: its copies were taken back first');
set constraints z_posts_media_public_copies_allowed deferred;

-- The worker's claim: a recorded copy is served; any other is claimed with a token.
select is(public.claim_post_media_public_copy_removal('public-posts/bc200000-0000-4000-8000-000000000001/0/photo.jpg')->>'outcome',
  'claimed', 'an unrecorded queued copy is claimed for removal');
select is(public.finish_post_media_public_copy_removal('public-posts/bc200000-0000-4000-8000-000000000001/0/photo.jpg',
  'ac000000-0000-4000-8000-000000000000'), 'released', 'a finish without the claim''s token removes nothing');
update public.post_media_public_copy_queue set copy_began_at = now() - interval '16 minutes'
where public_path = 'public-posts/bc200000-0000-4000-8000-000000000001/0/photo.jpg';
select is(public.finish_post_media_public_copy_removal('public-posts/bc200000-0000-4000-8000-000000000001/0/photo.jpg',
  (select claim_token from public.post_media_public_copy_queue where public_path = 'public-posts/bc200000-0000-4000-8000-000000000001/0/photo.jpg')),
  'removed', 'the claim''s own finish settles the row once no copy of it may still land');

-- A second sync's stamp survives the first sync's commit, so the post leaving
-- public view while that copy is still landing holds the removal through it.
do $$ begin perform pg_temp.copied_post('bf100000-0000-4000-8000-000000000001'); end $$;
select ok(exists(select 1 from public.post_media_public_copy_queue
  where public_path = 'public-posts/bf100000-0000-4000-8000-000000000001/0/photo.jpg' and copy_began_at = now()),
  'a commit keeps the row of a copy begun under 15 minutes ago');
update public.posts set visibility = 'private' where id = 'bf100000-0000-4000-8000-000000000001';
select ok((select copy_began_at = now() and reason = 'unexposed' from public.post_media_public_copy_queue
  where public_path = 'public-posts/bf100000-0000-4000-8000-000000000001/0/photo.jpg'),
  'the post leaving public view re-queues it with that stamp');
select is(public.finish_post_media_public_copy_removal('public-posts/bf100000-0000-4000-8000-000000000001/0/photo.jpg',
  ((public.claim_post_media_public_copy_removal('public-posts/bf100000-0000-4000-8000-000000000001/0/photo.jpg'))->>'token')::uuid),
  'held', 'so the removal holds the row through the copy still landing');

-- A refused commit keeps when the copy began, and its removal holds too.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, showcase_asset_path)
values ('bf200000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000001', 'private', 'image', 'manual', 'media',
  'private-posts/bf200000-0000-4000-8000-000000000001/0/photo.jpg');
insert into public.post_media (post_id, storage_path, media_kind, sort_order)
values ('bf200000-0000-4000-8000-000000000001', 'private-posts/bf200000-0000-4000-8000-000000000001/0/photo.jpg', 'image', 0);
update public.posts set visibility = 'public' where id = 'bf200000-0000-4000-8000-000000000001';
insert into storage.objects (bucket_id, name, metadata) values
  ('post_media', 'private-posts/bf200000-0000-4000-8000-000000000001/0/photo.jpg', '{"size":100}'),
  ('showcase_media', 'public-posts/bf200000-0000-4000-8000-000000000001/0/photo.jpg', '{"size":100}');
do $$ begin perform * from public.begin_post_media_public_copies('bf200000-0000-4000-8000-000000000001'); end $$;
update public.posts set visibility = 'private' where id = 'bf200000-0000-4000-8000-000000000001';
select is(public.commit_post_media_public_copies('bf200000-0000-4000-8000-000000000001',
  array['public-posts/bf200000-0000-4000-8000-000000000001/0/photo.jpg']), '{}'::text[], 'a commit after the post left public view is refused');
select ok((select reason = 'copy_refused' and copy_began_at = now() from public.post_media_public_copy_queue
  where public_path = 'public-posts/bf200000-0000-4000-8000-000000000001/0/photo.jpg'),
  'and keeps when the copy began');
select is(public.finish_post_media_public_copy_removal('public-posts/bf200000-0000-4000-8000-000000000001/0/photo.jpg',
  ((public.claim_post_media_public_copy_removal('public-posts/bf200000-0000-4000-8000-000000000001/0/photo.jpg'))->>'token')::uuid),
  'held', 'so its removal holds through it too');

do $$ begin perform pg_temp.copied_post('bcd00000-0000-4000-8000-000000000001'); end $$;
update public.posts set visibility = 'private' where id = 'bcd00000-0000-4000-8000-000000000001';
do $$ begin perform public.claim_post_media_public_copy_removal('public-posts/bcd00000-0000-4000-8000-000000000001/0/photo.jpg'); end $$;
update public.posts set visibility = 'public' where id = 'bcd00000-0000-4000-8000-000000000001';
select is((select count(*)::integer from public.begin_post_media_public_copies('bcd00000-0000-4000-8000-000000000001')), 1,
  'a copy whose removal is under way is not begun again; the other is');
select is(public.commit_post_media_public_copies('bcd00000-0000-4000-8000-000000000001',
  array['public-posts/bcd00000-0000-4000-8000-000000000001/0/photo.jpg']), '{}'::text[],
  'nor recorded while its removal is claimed');
select ok((select claim_token is null from public.post_media_public_copy_queue
  where public_path = 'public-posts/bcd00000-0000-4000-8000-000000000001/0/photo.jpg'),
  'the refused commit lets the claim go, so the removal''s finish cannot drop the row');

-- The job copies only what posts already served are missing; the backfill copies the rest.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, showcase_asset_path)
values ('bcf00000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000001', 'private', 'image', 'manual', 'media',
  'private-posts/bcf00000-0000-4000-8000-000000000001/0/photo.jpg');
insert into public.post_media (post_id, storage_path, media_kind, sort_order)
values ('bcf00000-0000-4000-8000-000000000001', 'private-posts/bcf00000-0000-4000-8000-000000000001/0/photo.jpg', 'image', 0);
update public.posts set visibility = 'public' where id = 'bcf00000-0000-4000-8000-000000000001';
insert into storage.objects (bucket_id, name, metadata) values
  ('post_media', 'private-posts/bcf00000-0000-4000-8000-000000000001/0/photo.jpg', '{"size":100}'),
  ('post_media', 'private-posts/bca00000-0000-4000-8000-000000000001/0/photo.preview.v2.webp', '{"size":12}');
select ok(not exists(select 1 from public.list_post_media_public_copy_candidates(500, false)
  where post_id = 'bcf00000-0000-4000-8000-000000000001'), 'a post never copied waits for the backfill');
select ok(exists(select 1 from public.list_post_media_public_copy_candidates(500, true)
  where post_id = 'bcf00000-0000-4000-8000-000000000001' and missing_objects = 1 and missing_bytes = 100),
  'the backfill lists it, with what it would add');
select ok(exists(select 1 from public.list_post_media_public_copy_candidates(500, false)
  where post_id = 'bca00000-0000-4000-8000-000000000001'), 'a served post missing a derivative''s copy is the job''s');
select is((select count(*)::integer from public.list_post_media_public_copy_candidates(1, true)), 1, 'a page holds as many as asked');
select ok(not exists(
  select 1 from public.list_post_media_public_copy_candidates(500, true,
    (select post_created_at from public.list_post_media_public_copy_candidates(1, true)),
    (select post_id from public.list_post_media_public_copy_candidates(1, true)))
  where post_id = (select post_id from public.list_post_media_public_copy_candidates(1, true))),
  'the next page starts after the last post of the one before, so a post that keeps failing holds none back');
select ok(not exists(select 1 from public.list_post_media_public_copy_candidates(500, true)
  where post_id in ('bc200000-0000-4000-8000-000000000001', 'bc600000-0000-4000-8000-000000000001')),
  'no post nobody signed out may read is ever listed');

select * from finish();
rollback;
