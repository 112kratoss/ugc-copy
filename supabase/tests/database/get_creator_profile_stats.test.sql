-- get_creator_profile_stats must agree with the creator grid: the posts
-- fetchCreatorPostRows draws (public, unarchived, review_status 'visible'),
-- and a recipe only where the tile carries one (a published bundle). The
-- fixtures cover each way a post or a bundle can fall outside that, including
-- the two the old rules counted: an in-app post with a generation and no
-- bundle, and a flagged post.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

-- People (each id has its own first octet: handle_new_user builds a fallback
-- username from the first eight characters, and usernames are unique): the
-- creator whose page is counted, a creator with no posts, and a stranger.
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values
  ('c2210001-0000-4000-8000-000000000001'::uuid, 'stats-creator@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c2210002-0000-4000-8000-000000000002'::uuid, 'stats-empty@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c2210003-0000-4000-8000-000000000003'::uuid, 'stats-stranger@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now()));

-- The creation behind the in-app post.
insert into public.generations (id, user_id, status, category, output_url)
values ('c2220000-0000-4000-8000-000000000001'::uuid, 'c2210001-0000-4000-8000-000000000001'::uuid, 'succeeded', 'image', 'generated_images/stats/1.png');

insert into public.posts (
  id, user_id, visibility, review_status, archived_at, generation_id, category, source_kind,
  post_format, body, title, showcase_asset_path, source_tool, source_tool_slug, save_count, remix_count
)
values
  -- counted: published from the app, with a generation and no bundle; a post, not a recipe
  ('c2230000-0000-4000-8000-000000000001'::uuid, 'c2210001-0000-4000-8000-000000000001'::uuid, 'public', 'visible', null,
   'c2220000-0000-4000-8000-000000000001'::uuid, 'image', 'magicbooklet', 'media', null, 'In-app post',
   'showcase/stats/1.png', 'Nano Banana', 'nano-banana', 2, 1),
  -- counted: carries the published recipe
  ('c2230000-0000-4000-8000-000000000002'::uuid, 'c2210001-0000-4000-8000-000000000001'::uuid, 'public', 'visible', null,
   null, 'text', 'external', 'text', 'recipe post', 'Recipe post', null, null, null, 5, 2),
  -- counted: its bundle is still a draft, so no tile shows a recipe for it
  ('c2230000-0000-4000-8000-000000000003'::uuid, 'c2210001-0000-4000-8000-000000000001'::uuid, 'public', 'visible', null,
   null, 'text', 'external', 'text', 'draft recipe post', 'Draft recipe post', null, null, null, 1, 0),
  -- not counted once flagged below: a published recipe on a post the grid hides
  ('c2230000-0000-4000-8000-000000000004'::uuid, 'c2210001-0000-4000-8000-000000000001'::uuid, 'public', 'visible', null,
   null, 'text', 'external', 'text', 'flagged post', 'Flagged post', null, 'Runway', 'runway', 100, 100),
  -- not counted: hidden, archived, private, unlisted
  ('c2230000-0000-4000-8000-000000000005'::uuid, 'c2210001-0000-4000-8000-000000000001'::uuid, 'public', 'hidden', null,
   null, 'text', 'external', 'text', 'hidden post', 'Hidden post', null, null, null, 50, 50),
  ('c2230000-0000-4000-8000-000000000006'::uuid, 'c2210001-0000-4000-8000-000000000001'::uuid, 'public', 'visible', timezone('utc'::text, now()),
   null, 'text', 'external', 'text', 'archived post', 'Archived post', null, null, null, 7, 7),
  ('c2230000-0000-4000-8000-000000000007'::uuid, 'c2210001-0000-4000-8000-000000000001'::uuid, 'private', 'visible', null,
   null, 'text', 'external', 'text', 'private post', 'Private post', null, null, null, 9, 9),
  ('c2230000-0000-4000-8000-000000000008'::uuid, 'c2210001-0000-4000-8000-000000000001'::uuid, 'unlisted', 'visible', null,
   null, 'text', 'external', 'text', 'unlisted post', 'Unlisted post', null, null, null, 11, 11),
  -- someone else's
  ('c2230000-0000-4000-8000-000000000009'::uuid, 'c2210003-0000-4000-8000-000000000003'::uuid, 'public', 'visible', null,
   null, 'text', 'external', 'text', 'stranger post', 'Stranger post', null, null, null, 13, 13);

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents
)
values
  ('c2240000-0000-4000-8000-000000000002'::uuid, 'c2230000-0000-4000-8000-000000000002'::uuid, 'c2210001-0000-4000-8000-000000000001'::uuid,
   'free', 'published', 'Published recipe', 'Summary', 'A preview of the published recipe.', 'The prompt.',
   '[]'::jsonb, false, jsonb_build_array(jsonb_build_object('type', 'prompt', 'title', 'Prompt')), '[]'::jsonb, 0, 3, 0),
  ('c2240000-0000-4000-8000-000000000003'::uuid, 'c2230000-0000-4000-8000-000000000003'::uuid, 'c2210001-0000-4000-8000-000000000001'::uuid,
   'free', 'draft', 'Draft recipe', 'Summary', 'A preview of the draft recipe.', 'The prompt.',
   '[]'::jsonb, false, jsonb_build_array(jsonb_build_object('type', 'prompt', 'title', 'Prompt')), '[]'::jsonb, 0, 0, 0),
  ('c2240000-0000-4000-8000-000000000004'::uuid, 'c2230000-0000-4000-8000-000000000004'::uuid, 'c2210001-0000-4000-8000-000000000001'::uuid,
   'free', 'published', 'Flagged recipe', 'Summary', 'A preview of the flagged recipe.', 'The prompt.',
   '[]'::jsonb, false, jsonb_build_array(jsonb_build_object('type', 'prompt', 'title', 'Prompt')), '[]'::jsonb, 0, 4, 0);

-- Moderation flags the fourth post after its recipe went on sale.
update public.posts set review_status = 'flagged'
where id = 'c2230000-0000-4000-8000-000000000004'::uuid;
select is(
  (select status from public.post_resource_bundles where id = 'c2240000-0000-4000-8000-000000000004'::uuid),
  'published',
  'fixture: the flagged post''s recipe is still published'
);

select is(
  (public.get_creator_profile_stats('c2210001-0000-4000-8000-000000000001'::uuid) ->> 'publicCreations')::int,
  3,
  'posts: public, visible and unarchived only; flagged, hidden, archived, private and unlisted posts are not in the grid'
);
select is(
  (public.get_creator_profile_stats('c2210001-0000-4000-8000-000000000001'::uuid) ->> 'totalSaves')::int,
  8,
  'saves are summed over the counted posts only'
);
select is(
  (public.get_creator_profile_stats('c2210001-0000-4000-8000-000000000001'::uuid) ->> 'totalRemixes')::int,
  3,
  'remixes are summed over the counted posts only'
);
select is(
  (public.get_creator_profile_stats('c2210001-0000-4000-8000-000000000001'::uuid) ->> 'unlocks')::int,
  1,
  'recipes: only a published bundle counts; an in-app post with a generation and no bundle does not'
);
select is(
  (public.get_creator_profile_stats('c2210001-0000-4000-8000-000000000001'::uuid) ->> 'totalUnlockSales')::int,
  3,
  'sales are summed over published recipes on counted posts'
);
select is(
  public.get_creator_profile_stats('c2210001-0000-4000-8000-000000000001'::uuid) -> 'toolsUsed',
  '[{"slug": "nano-banana", "label": "Nano Banana", "count": 1}]'::jsonb,
  'tools come from the counted posts; the flagged post''s tool is left out'
);
select is(
  public.get_creator_profile_stats('c2210002-0000-4000-8000-000000000002'::uuid),
  '{"publicCreations": 0, "totalSaves": 0, "totalRemixes": 0, "unlocks": 0, "totalUnlockSales": 0, "toolsUsed": []}'::jsonb,
  'a creator with no posts has zeros and an empty tool list, not nulls'
);
select is(
  public.get_creator_profile_stats('c2290000-0000-4000-8000-000000000000'::uuid),
  '{"publicCreations": 0, "totalSaves": 0, "totalRemixes": 0, "unlocks": 0, "totalUnlockSales": 0, "toolsUsed": []}'::jsonb,
  'an unknown id is all zeros'
);

-- The numbers follow the rows.
update public.post_resource_bundles set status = 'published'
where id = 'c2240000-0000-4000-8000-000000000003'::uuid;
select is(
  (public.get_creator_profile_stats('c2210001-0000-4000-8000-000000000001'::uuid) ->> 'unlocks')::int,
  2,
  'publishing the draft recipe counts it'
);
update public.posts set review_status = 'visible'
where id = 'c2230000-0000-4000-8000-000000000004'::uuid;
select is(
  (public.get_creator_profile_stats('c2210001-0000-4000-8000-000000000001'::uuid) ->> 'publicCreations')::int,
  4,
  'clearing the flag brings the post back'
);
select is(
  (public.get_creator_profile_stats('c2210001-0000-4000-8000-000000000001'::uuid) ->> 'unlocks')::int,
  3,
  'and its recipe'
);
select is(
  (public.get_creator_profile_stats('c2210001-0000-4000-8000-000000000001'::uuid) ->> 'totalUnlockSales')::int,
  7,
  'and its recipe''s sales'
);
update public.posts set review_status = 'flagged'
where id = 'c2230000-0000-4000-8000-000000000001'::uuid;
select is(
  public.get_creator_profile_stats('c2210001-0000-4000-8000-000000000001'::uuid) -> 'toolsUsed',
  '[{"slug": "runway", "label": "Runway", "count": 1}]'::jsonb,
  'flagging a post takes its tool out of the list'
);

-- Only the server may ask, and the shape callers rely on stays.
select ok(
  not has_function_privilege('anon', 'public.get_creator_profile_stats(uuid)', 'execute'),
  'anon cannot call it'
);
select ok(
  not has_function_privilege('authenticated', 'public.get_creator_profile_stats(uuid)', 'execute'),
  'authenticated cannot call it'
);
select ok(
  has_function_privilege('service_role', 'public.get_creator_profile_stats(uuid)', 'execute'),
  'the service role calls it for the creator page'
);
select ok(
  (select prosecdef from pg_proc where oid = 'public.get_creator_profile_stats(uuid)'::regprocedure),
  'runs as its definer, so RLS on the counted tables does not apply to the count'
);
select ok(
  exists (
    select 1
    from pg_proc, unnest(pg_proc.proconfig) as setting
    where pg_proc.oid = 'public.get_creator_profile_stats(uuid)'::regprocedure
      and setting in ('search_path=', 'search_path=""')
  ),
  'pins an empty search_path like the other service-role readers'
);
select is(
  (select provolatile from pg_proc where oid = 'public.get_creator_profile_stats(uuid)'::regprocedure),
  's',
  'is stable, so the creator read can call it beside the page query'
);
select is(
  (select prorettype::regtype::text from pg_proc where oid = 'public.get_creator_profile_stats(uuid)'::regprocedure),
  'jsonb',
  'still answers one jsonb object'
);

select * from finish();

rollback;
