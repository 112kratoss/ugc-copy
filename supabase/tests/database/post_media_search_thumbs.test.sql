-- A post media row's search thumb (20261123152813): a WebP made from its
-- preview, beside it in the public bucket, that search_post_picture answers
-- as `thumb_path` for a cover that has one. It lives only beside a public
-- preview; a write that changes the preview without naming a thumb drops it;
-- and a thumb a row stops naming, by any write or by the row's delete, goes to
-- the showcase-media-revocations queue (only a creation's public folder is
-- queued), whose job keeps what a serving post still names.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

create function pg_temp.uid(p_suffix text)
returns uuid
language sql
as $$ select ('00007b70-0000-4000-9000-0000000000' || p_suffix)::uuid; $$;

create function pg_temp.queued(p_path text)
returns bigint
language sql
as $$
  select count(*) from public.showcase_media_revocations
  where showcase_asset_path = p_path and reason = 'sweep_unrecorded'
$$;

insert into auth.users (id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at)
values (
  pg_temp.uid('01'), 'thumb-owner@example.invalid', 'authenticated', 'authenticated', false,
  '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'
);

-- Two creations, each with its public post: …11 whose cover has a thumb, …12
-- whose cover has none yet.
insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, output_url, is_public, showcase_asset_path
)
select
  pg_temp.uid(g), pg_temp.uid('01'), 'thumb-' || g, 'succeeded', 1, 'image', 'test',
  'generated_images/' || pg_temp.uid('01') || '/' || g || '.png', true,
  'showcase/' || pg_temp.uid(g) || '/cover.abc.png'
from unnest(array['51', '52']) as g;

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, title,
  generation_id, showcase_asset_path, output_url
)
select
  pg_temp.uid(fixture.post), pg_temp.uid('01'), 'public', 'image', 'magicbooklet', 'media', 'Thumb cover ' || fixture.post,
  pg_temp.uid(fixture.g), 'showcase/' || pg_temp.uid(fixture.g) || '/cover.abc.png',
  'generated_images/x/' || fixture.g || '.png'
from (values ('11', '51'), ('12', '52')) as fixture(post, g);

insert into public.post_media (
  id, post_id, media_key, storage_path, preview_storage_path, preview_thumbhash, preview_status,
  thumb_storage_path, rendition_status, media_kind, content_type, original_name, width, height, sort_order
)
values
  (
    pg_temp.uid('21'), pg_temp.uid('11'), 'media-0',
    'showcase/' || pg_temp.uid('51') || '/cover.abc.png',
    'showcase/' || pg_temp.uid('51') || '/cover.abc.preview.p1.webp', 'hash-11', 'ready',
    'showcase/' || pg_temp.uid('51') || '/cover.abc.thumb.t1.webp',
    'skipped', 'image', 'image/png', 'cover.png', 864, 1152, 0
  ),
  (
    pg_temp.uid('22'), pg_temp.uid('12'), 'media-0',
    'showcase/' || pg_temp.uid('52') || '/cover.abc.png',
    'showcase/' || pg_temp.uid('52') || '/cover.abc.preview.p1.webp', 'hash-12', 'ready',
    null, 'skipped', 'image', 'image/png', 'cover.png', 864, 1152, 0
  );

set constraints all immediate;

-- ─── What search answers ────────────────────────────────────────────────────

select has_column('public', 'post_media', 'thumb_storage_path', 'post media rows name a row thumb');

select is(
  public.search_post_picture(pg_temp.uid('11')),
  jsonb_build_object(
    'post_id', pg_temp.uid('11'),
    'path', 'showcase/' || pg_temp.uid('51') || '/cover.abc.preview.p1.webp',
    'thumb_path', 'showcase/' || pg_temp.uid('51') || '/cover.abc.thumb.t1.webp',
    'thumbhash', 'hash-11', 'width', 864, 'height', 1152, 'media_kind', 'image'
  ),
  'a cover''s picture names its row thumb beside its preview'
);
select is(
  public.search_post_picture(pg_temp.uid('12')),
  jsonb_build_object(
    'post_id', pg_temp.uid('12'),
    'path', 'showcase/' || pg_temp.uid('52') || '/cover.abc.preview.p1.webp',
    'thumbhash', 'hash-12', 'width', 864, 'height', 1152, 'media_kind', 'image'
  ),
  'and a cover with no thumb answers what it did before thumbs, with no thumb_path key'
);

-- ─── Where a thumb may be ───────────────────────────────────────────────────

select throws_ok(
  format($$update public.post_media set thumb_storage_path = 'private-posts/%s/cover.thumb.t9.webp' where id = %L$$,
         pg_temp.uid('11'), pg_temp.uid('22')),
  '23514', null,
  'a thumb is never in the private bucket'
);
select throws_ok(
  format($$update public.post_media
           set preview_storage_path = 'private-posts/%s/cover.preview.p9.webp',
               thumb_storage_path = 'showcase/%s/cover.abc.thumb.t9.webp'
           where id = %L$$, pg_temp.uid('12'), pg_temp.uid('52'), pg_temp.uid('22')),
  '23514', null,
  'nor beside a private preview'
);
select throws_ok(
  format($$update public.post_media set preview_storage_path = null, thumb_storage_path = 'showcase/%s/t9.webp' where id = %L$$,
         pg_temp.uid('52'), pg_temp.uid('22')),
  '23514', null,
  'nor beside no preview'
);
select throws_ok(
  format($$update public.post_media set thumb_storage_path = 'showcase/%s/../escape.webp' where id = %L$$,
         pg_temp.uid('52'), pg_temp.uid('22')),
  '23514', null,
  'and its path carries the traversal guard every path column does'
);

-- ─── How a thumb follows its preview ────────────────────────────────────────

-- The backfill names a thumb where there was none: nothing to queue.
update public.post_media
set thumb_storage_path = 'showcase/' || pg_temp.uid('52') || '/cover.abc.thumb.t1.webp'
where id = pg_temp.uid('22');
select is(
  (select thumb_storage_path from public.post_media where id = pg_temp.uid('22')),
  'showcase/' || pg_temp.uid('52') || '/cover.abc.thumb.t1.webp',
  'a thumb is recorded beside a public preview'
);
select is(
  (select count(*) from public.showcase_media_revocations where generation_id = pg_temp.uid('52')),
  0::bigint,
  'and recording one where there was none queues nothing'
);

-- A write before thumbs, as labelling's private copy commits: the preview moves, the thumb is not named.
update public.post_media
set preview_storage_path = 'private-posts/' || pg_temp.uid('11') || '/cover.preview.p1.webp'
where id = pg_temp.uid('21');
select is(
  (select thumb_storage_path from public.post_media where id = pg_temp.uid('21')),
  null,
  'a write that moves the preview without naming a thumb drops the thumb'
);
select is(
  pg_temp.queued('showcase/' || pg_temp.uid('51') || '/cover.abc.thumb.t1.webp'), 1::bigint,
  'and queues it for revocation'
);

-- The sweep writes a new preview with the thumb made from it.
update public.post_media
set preview_storage_path = 'showcase/' || pg_temp.uid('52') || '/cover.abc.preview.p2.webp',
    thumb_storage_path = 'showcase/' || pg_temp.uid('52') || '/cover.abc.thumb.t2.webp'
where id = pg_temp.uid('22');
select is(
  (select thumb_storage_path from public.post_media where id = pg_temp.uid('22')),
  'showcase/' || pg_temp.uid('52') || '/cover.abc.thumb.t2.webp',
  'a write that names the thumb with its new preview keeps it'
);
select is(
  pg_temp.queued('showcase/' || pg_temp.uid('52') || '/cover.abc.thumb.t1.webp'), 1::bigint,
  'and queues the thumb it replaced'
);

-- The same preview and thumb written again, as a sweep repeats a content-addressed write.
update public.post_media
set preview_storage_path = preview_storage_path, thumb_storage_path = thumb_storage_path
where id = pg_temp.uid('22');
select is(
  pg_temp.queued('showcase/' || pg_temp.uid('52') || '/cover.abc.thumb.t2.webp'), 0::bigint,
  'writing the same preview and thumb again queues nothing'
);

-- A write of something else leaves the thumb alone.
update public.post_media set width = 1024 where id = pg_temp.uid('22');
select is(
  (select thumb_storage_path from public.post_media where id = pg_temp.uid('22')),
  'showcase/' || pg_temp.uid('52') || '/cover.abc.thumb.t2.webp',
  'a write that leaves the preview alone leaves the thumb'
);

-- The post's delete cascades to the row, whose thumb goes to the queue.
delete from public.posts where id = pg_temp.uid('12');
select is(
  pg_temp.queued('showcase/' || pg_temp.uid('52') || '/cover.abc.thumb.t2.webp'), 1::bigint,
  'deleting the post queues its cover''s thumb'
);
select is(
  (select generation_id from public.showcase_media_revocations
   where showcase_asset_path = 'showcase/' || pg_temp.uid('52') || '/cover.abc.thumb.t2.webp'),
  pg_temp.uid('52'),
  'under the creation whose folder holds it'
);

-- A post's own public folder is refused: account erasure and a media edit list
-- its objects by column, and no queue takes it (review of #906).
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, title, showcase_asset_path)
values (
  pg_temp.uid('13'), pg_temp.uid('01'), 'public', 'image', 'manual', 'media', 'Legacy upload',
  'private-posts/' || pg_temp.uid('13') || '/0/photo.jpg'
);
select throws_ok(
  format($$insert into public.post_media (
      id, post_id, media_key, storage_path, preview_storage_path, preview_status, thumb_storage_path,
      rendition_status, media_kind, content_type, original_name, sort_order
    )
    values (%L, %L, 'media-0', 'posts/%s/0/photo.jpg', 'posts/%s/0/photo.preview.p1.webp', 'ready',
      'posts/%s/0/photo.thumb.t1.webp', 'skipped', 'image', 'image/jpeg', 'photo.jpg', 0)$$,
    pg_temp.uid('23'), pg_temp.uid('13'), pg_temp.uid('13'), pg_temp.uid('13'), pg_temp.uid('13')),
  '23514', 'new row for relation "post_media" violates check constraint "post_media_thumb_beside_public_preview_check"',
  'a thumb in a post''s own public folder is refused'
);
-- Row …21 (its thumb dropped above) given a public preview again, so only the folder refuses.
select throws_ok(
  format($$update public.post_media
           set preview_storage_path = 'showcase/%s/cover.abc.preview.p3.webp',
               thumb_storage_path = 'showcase/not-a-creation/cover.thumb.t9.webp'
           where id = %L$$, pg_temp.uid('51'), pg_temp.uid('21')),
  '23514', 'new row for relation "post_media" violates check constraint "post_media_thumb_beside_public_preview_check"',
  'and so is one in the public bucket outside a creation''s folder'
);

-- ─── Who may call it ────────────────────────────────────────────────────────

select ok(
  not has_function_privilege('anon', 'public.post_media_thumb_follows_its_preview()', 'execute')
  and not has_function_privilege('authenticated', 'public.post_media_thumb_follows_its_preview()', 'execute')
  and not has_function_privilege('service_role', 'public.post_media_thumb_follows_its_preview()', 'execute'),
  'the trigger function is no one''s to call'
);
select ok(
  has_function_privilege('service_role', 'public.search_post_picture(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.search_post_picture(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.search_post_picture(uuid, uuid)', 'execute'),
  'search_post_picture is still the service role''s alone'
);

select * from finish();
rollback;
