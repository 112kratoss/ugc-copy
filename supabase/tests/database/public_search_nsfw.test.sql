begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(10);

-- 5e1…01 creates the posts; 5e1…02 follows that creator.
insert into auth.users (id, email, aud, role, created_at, raw_app_meta_data, raw_user_meta_data)
values
  ('5e100000-0000-4000-8000-000000000001'::uuid, 'search-nsfw-creator@example.invalid',
   'authenticated', 'authenticated', now(), '{}'::jsonb, '{}'::jsonb),
  ('5e100000-0000-4000-8000-000000000002'::uuid, 'search-nsfw-follower@example.invalid',
   'authenticated', 'authenticated', now(), '{}'::jsonb, '{}'::jsonb);

insert into public.follows (follower_id, following_id)
values ('5e100000-0000-4000-8000-000000000002'::uuid, '5e100000-0000-4000-8000-000000000001'::uuid);

-- Every post matches 'quillwort lantern'. The labelled media post (…12) has the
-- exact title and the most saves, so it would rank first if it were searched.
-- Text posts carry no media; the labelled media post's cover is a private path,
-- as a label requires.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status,
  title, body, showcase_asset_path, save_count, is_nsfw, created_at, updated_at
) values
  (
    '5e200000-0000-4000-8000-000000000011'::uuid, '5e100000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'external', 'media', 'visible',
    'Quillwort lantern study', 'A calm frame of reeds at dusk',
    'showcase/search-nsfw-clean.png', 0, false, now(), now()
  ),
  (
    '5e200000-0000-4000-8000-000000000012'::uuid, '5e100000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'external', 'media', 'visible',
    'Quillwort lantern', 'A labelled frame',
    'private-posts/5e200000-0000-4000-8000-000000000012/original.jpg', 100000, true, now(), now()
  ),
  (
    '5e200000-0000-4000-8000-000000000013'::uuid, '5e100000-0000-4000-8000-000000000001'::uuid,
    'public', 'text', 'external', 'text', 'visible',
    null, 'Field notes on quillwort lantern light',
    null, 0, false, now(), now()
  ),
  (
    '5e200000-0000-4000-8000-000000000014'::uuid, '5e100000-0000-4000-8000-000000000001'::uuid,
    'public', 'text', 'external', 'text', 'visible',
    null, 'Quillwort lantern, a labelled note',
    null, 0, true, now(), now()
  );

select is(
  array(select post_id from public.search_public_posts('quillwort lantern', null, null, null, 20) order by post_id),
  array['5e200000-0000-4000-8000-000000000011', '5e200000-0000-4000-8000-000000000013']::uuid[],
  'a signed-out search finds the unlabelled media and text posts and neither labelled one'
);

select is(
  array(select post_id from public.search_public_posts(
    'quillwort lantern', '5e100000-0000-4000-8000-000000000002'::uuid, null, null, 20
  ) order by post_id),
  array['5e200000-0000-4000-8000-000000000011', '5e200000-0000-4000-8000-000000000013']::uuid[],
  'a follower of the creator gets the same answer'
);

select is(
  array(select post_id from public.search_public_posts(
    'quillwort lantern', '5e100000-0000-4000-8000-000000000001'::uuid, null, null, 20
  ) order by post_id),
  array['5e200000-0000-4000-8000-000000000011', '5e200000-0000-4000-8000-000000000013']::uuid[],
  'the creator gets the same answer: their own labelled posts are left out too'
);

select is(
  array(select post_id from public.search_public_posts('quillwort lantern', null, null, null, 2) order by post_id),
  array['5e200000-0000-4000-8000-000000000011', '5e200000-0000-4000-8000-000000000013']::uuid[],
  'labelled posts are left out before the limit, so a page of two is full'
);

select is(
  array(
    with first_page as (
      select post_id, search_score
      from public.search_public_posts('quillwort lantern', null, null, null, 1)
    )
    select ids.post_id
    from (
      select first_page.post_id from first_page
      union all
      select next_page.post_id
      from first_page
      cross join lateral public.search_public_posts(
        'quillwort lantern', null, first_page.search_score, first_page.post_id, 10
      ) as next_page
    ) as ids
    order by ids.post_id
  ),
  array['5e200000-0000-4000-8000-000000000011', '5e200000-0000-4000-8000-000000000013']::uuid[],
  'a page of one and the keyset page after it hold each unlabelled post once and no labelled one'
);

-- The label is not one of the document trigger's columns, so the post's search
-- document stays as it was: only the query reads the label.
update public.posts
set is_nsfw = true
where id = '5e200000-0000-4000-8000-000000000013'::uuid;

select is(
  array(select post_id from public.search_public_posts('quillwort lantern', null, null, null, 20) order by post_id),
  array['5e200000-0000-4000-8000-000000000011']::uuid[],
  'a post labelled after it was indexed drops out of search at once'
);

update public.posts
set is_nsfw = false
where id = '5e200000-0000-4000-8000-000000000012'::uuid;

select is(
  (select post_id from public.search_public_posts('quillwort lantern', null, null, null, 1)),
  '5e200000-0000-4000-8000-000000000012'::uuid,
  'with its label removed the labelled media post is found and ranks first, so the label alone kept it out'
);

select ok(
  not has_function_privilege('anon', 'public.search_public_posts(text,uuid,double precision,uuid,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_public_posts(text,uuid,double precision,uuid,integer)', 'EXECUTE'),
  'client roles still cannot call post search directly'
);

select ok(
  has_function_privilege('service_role', 'public.search_public_posts(text,uuid,double precision,uuid,integer)', 'EXECUTE'),
  'the service role still calls post search'
);

select ok(
  (select fn.prosecdef
     and exists (
       select 1 from unnest(fn.proconfig) as entry
       where entry like 'search_path=%public%pg_temp%'
     )
   from pg_proc as fn
   where fn.oid = 'public.search_public_posts(text,uuid,double precision,uuid,integer)'::regprocedure),
  'post search keeps definer rights and its pinned search path'
);

select * from finish();
rollback;
