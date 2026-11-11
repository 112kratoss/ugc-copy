begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(35);

-- 5ea0…01 creates the posts; 5ea0…02 is another creator with nothing posted.
insert into auth.users (id, email, aud, role, created_at, raw_app_meta_data, raw_user_meta_data)
values
  ('5ea00000-0000-4000-8000-000000000001'::uuid, 'search-recall-creator@example.invalid',
   'authenticated', 'authenticated', now(), '{}'::jsonb, '{}'::jsonb),
  ('5ea00000-0000-4000-8000-000000000002'::uuid, 'search-recall-other@example.invalid',
   'authenticated', 'authenticated', now(), '{}'::jsonb, '{}'::jsonb);

update public.profiles
set username = 'mira-okafor', display_name = 'Mira Okafor', bio = 'Editorial lighting studies'
where id = '5ea00000-0000-4000-8000-000000000001'::uuid;

insert into public.generations (id, user_id, model, status, is_public)
values
  ('5ea10000-0000-4000-8000-000000000001'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
   'veo-3.1', 'succeeded', true),
  ('5ea10000-0000-4000-8000-000000000002'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
   'nano-banana-pro', 'succeeded', true),
  ('5ea10000-0000-4000-8000-000000000003'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
   'seedream-4.5', 'succeeded', true),
  ('5ea10000-0000-4000-8000-000000000004'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
   'veo-3.1', 'succeeded', true);

-- …11 and …12 are creations made in the app: their posts name the app as the
-- tool, and only the creation knows the model. …13 was made elsewhere. …14 is
-- a labelled creation on the same model as …11. …15 gets its creation later.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status,
  title, body, source_tool, source_tool_slug, generation_id, showcase_asset_path,
  is_nsfw, created_at, updated_at
) values
  (
    '5ea20000-0000-4000-8000-000000000011'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'video', 'magicbooklet', 'media', 'visible',
    'Rainy street at night', 'Neon reflections on wet asphalt', 'Magicbooklet', 'magicbooklet',
    '5ea10000-0000-4000-8000-000000000001'::uuid, 'showcase/search-recall-11.png',
    false, now(), now()
  ),
  (
    '5ea20000-0000-4000-8000-000000000012'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'magicbooklet', 'media', 'visible',
    'Studio portrait of a dancer', 'Soft key light from the left', 'Magicbooklet', 'magicbooklet',
    '5ea10000-0000-4000-8000-000000000002'::uuid, 'showcase/search-recall-12.png',
    false, now(), now()
  ),
  (
    '5ea20000-0000-4000-8000-000000000013'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'external', 'media', 'visible',
    'Harbor at dawn', 'Boats under fog', 'Midjourney', 'midjourney',
    null, 'showcase/search-recall-13.png',
    false, now(), now()
  ),
  (
    '5ea20000-0000-4000-8000-000000000014'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'video', 'magicbooklet', 'media', 'visible',
    'Labelled frame', 'A labelled clip', 'Magicbooklet', 'magicbooklet',
    '5ea10000-0000-4000-8000-000000000004'::uuid,
    'private-posts/5ea20000-0000-4000-8000-000000000014/original.jpg',
    true, now(), now()
  ),
  (
    '5ea20000-0000-4000-8000-000000000015'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'magicbooklet', 'media', 'visible',
    'Quiet orchard', 'Rows of trees in mist', 'Magicbooklet', 'magicbooklet',
    null, 'showcase/search-recall-15.png',
    false, now(), now()
  );

create function pg_temp.finds(p_query text, p_post_suffix text) returns boolean
language sql as $$
  select exists (
    select 1 from public.search_public_posts(p_query, null, null, null, 25)
    where post_id = ('5ea20000-0000-4000-8000-0000000000' || p_post_suffix)::uuid
  );
$$;

create function pg_temp.finds_creator(p_query text) returns boolean
language sql as $$
  select exists (
    select 1 from public.search_public_creators(p_query, null, null, null, 25)
    where creator_user_id = '5ea00000-0000-4000-8000-000000000001'::uuid
  );
$$;

-- ─── A creation is found by its model ───────────────────────────────────────

select ok(pg_temp.finds('veo', '11'), 'a creation is found by the first word of its model');
select ok(pg_temp.finds('veo 3.1', '11'), 'by its model as its name reads');
select ok(pg_temp.finds('veo-3.1', '11'), 'by its model as its id is written');
select ok(pg_temp.finds('veo3', '11'), 'by its model typed without the space');
select ok(pg_temp.finds('veo 3', '11'), 'by its model while its version is still being typed');
select ok(pg_temp.finds('nano banana', '12'), 'by the words of a hyphenated model id');
select ok(pg_temp.finds('nanobanana', '12'), 'by a hyphenated model id typed as one word');
select ok(pg_temp.finds('nano-ban', '12'), 'by a hyphenated model id while it is still being typed');

select ok(not pg_temp.finds('veo', '14'), 'a labelled creation is not found by its model');
select ok(not pg_temp.finds('veo', '12'), 'a model finds only the posts made with it');
select ok(not pg_temp.finds('veo', '13'), 'and none made elsewhere');

-- ─── Words match as people type them ────────────────────────────────────────

select ok(pg_temp.finds('portr', '12'), 'a word still being typed finds the post');
select ok(pg_temp.finds('studio danc', '12'), 'the last of several words may still be being typed, wherever the words sit');
select ok(pg_temp.finds('portraits', '12'), 'a plural finds the singular');
select ok(pg_temp.finds('dancers', '12'), 'in the title''s later words too');
select ok(pg_temp.finds('portriat', '12'), 'a misspelt word finds the post');
select ok(pg_temp.finds('reflektions', '11'), 'a misspelt word of the caption too');
select ok(pg_temp.finds('studio portriat', '12'), 'one misspelt word among several is read as its nearest known word');
select ok(not pg_temp.finds('portriat', '11'), 'a corrected word finds only the posts that hold it');
select is(
  public.search_corrected_query('studio portriat veo3 danc xqzvk'),
  'studio portrait veo 3 danc xqzvk',
  'a word is corrected only when it is letters, no known word starts with it, and a near one exists'
);
select ok(
  exists (select 1 from public.search_terms where term = 'reflections')
    and not exists (select 1 from public.search_terms where term = 'labelled'),
  'the dictionary holds the words unlabelled posts show, and none a labelled post alone shows'
);
select ok(not pg_temp.finds('portrait', '11'), 'a word finds only the posts that hold it');
select ok(not pg_temp.finds('zebra crossing', '12'), 'and words no post holds find nothing');

select is(
  (select post_id from public.search_public_posts('studio portrait', null, null, null, 25) limit 1),
  '5ea20000-0000-4000-8000-000000000012'::uuid,
  'the post that holds the words as typed comes first'
);

-- ─── Made with: every listed tool and model, kept current ───────────────────

insert into public.post_source_tools (post_id, tool_label, tool_slug, model_label, model_slug, sort_order)
values
  ('5ea20000-0000-4000-8000-000000000013'::uuid, 'Midjourney', 'midjourney', 'Niji 6', 'niji-6', 0),
  ('5ea20000-0000-4000-8000-000000000013'::uuid, 'Topaz Labs', 'topaz-labs', null, null, 1);

select ok(pg_temp.finds('niji', '13'), 'a post is found by the model its Made with lists');
select ok(pg_temp.finds('niji6', '13'), 'typed without the space');
select ok(pg_temp.finds('topaz', '13'), 'and by a tool beyond the first');

update public.post_source_tools
set model_label = 'Niji 7', model_slug = 'niji-7'
where post_id = '5ea20000-0000-4000-8000-000000000013'::uuid and tool_slug = 'midjourney';

select ok(
  (select search_text like '%niji 7%' and search_text not like '%niji 6%'
   from public.post_search_documents
   where post_id = '5ea20000-0000-4000-8000-000000000013'::uuid),
  'a changed Made with re-projects the post''s document'
);

delete from public.post_source_tools
where post_id = '5ea20000-0000-4000-8000-000000000013'::uuid;

select ok(not pg_temp.finds('niji', '13'), 'a removed Made with is no longer searched');
select ok(pg_temp.finds('midjourney', '13'), 'the post''s own tool still is');

update public.posts
set generation_id = '5ea10000-0000-4000-8000-000000000003'::uuid
where id = '5ea20000-0000-4000-8000-000000000015'::uuid;

select ok(pg_temp.finds('seedream 4.5', '15'), 'a post given its creation is found by that creation''s model');

-- ─── Creators ───────────────────────────────────────────────────────────────

select ok(pg_temp.finds_creator('okaf'), 'a creator is found by a later word of their name, still being typed');
select ok(pg_temp.finds_creator('mira oka'), 'by their name with its last word still being typed');
select ok(pg_temp.finds_creator('mirra okafor'), 'by their name misspelt');
select ok(not pg_temp.finds_creator('zebra'), 'and not by a word they do not have');

select * from finish();
rollback;
