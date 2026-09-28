-- owner_profile_counts must agree with the profile library lists: the same
-- rows the Creations, Posts and Saved tabs draw, counted once. The fixtures
-- mirror ugc-mobile/__tests__/creation-library.test.ts and the Saved list's
-- visibility and block rules, so a change to either list shows up here.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(20);

-- People (each id has its own first octet: handle_new_user builds a fallback
-- username from the first eight characters, and usernames are unique): the owner, a guest profile merged into the owner, a creator the
-- owner blocked, a creator who blocked the owner, a friendly creator, a
-- person with only legacy showcase saves, and a stranger.
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values
  ('c0100001-0000-4000-8000-000000000001'::uuid, 'counts-owner@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100002-0000-4000-8000-000000000002'::uuid, 'counts-guest@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100003-0000-4000-8000-000000000003'::uuid, 'counts-blocked@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100004-0000-4000-8000-000000000004'::uuid, 'counts-blocker@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100005-0000-4000-8000-000000000005'::uuid, 'counts-friend@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100006-0000-4000-8000-000000000006'::uuid, 'counts-legacy@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100007-0000-4000-8000-000000000007'::uuid, 'counts-stranger@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now()));

-- handle_new_user gave each of them a profile. The guest's is merged into the
-- owner, the way a sign-up links a guest's library.
update public.profiles
set merged_into_user_id = 'c0100001-0000-4000-8000-000000000001'::uuid,
    merged_at = timezone('utc'::text, now()),
    identity_state = 'merged'
where id = 'c0100002-0000-4000-8000-000000000002'::uuid;
select is(
  (select count(*)::int from public.profiles where merged_into_user_id = 'c0100001-0000-4000-8000-000000000001'::uuid),
  1,
  'fixture: the guest profile is merged into the owner'
);

-- A template run, so the studio-visibility rule for run steps can be exercised.
insert into public.templates (id, name)
values ('c0200000-0000-4000-8000-000000000001'::uuid, 'Counts fixture template');
insert into public.template_runs (
  id, template_id, user_id, graph_snapshot, graph_hash, output_node_id, output_kind,
  estimated_total_credits, estimated_remaining_credits
) values (
  'c0300000-0000-4000-8000-000000000001'::uuid, 'c0200000-0000-4000-8000-000000000001'::uuid,
  'c0100001-0000-4000-8000-000000000001'::uuid, '{}'::jsonb, 'counts-fixture', 'output', 'image', 0, 0
);

-- Creations. Each row is one case from creation-library.test.ts.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values
  -- counted: finished image with an output
  ('c0400000-0000-4000-8000-000000000001'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'succeeded', 'image', 'generated_images/counts/1.png', null, null, null, true),
  -- not counted: a legacy 'completed' status is not the finished state the app draws
  ('c0400000-0000-4000-8000-000000000002'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'completed', 'image', 'generated_images/counts/2.png', null, null, null, true),
  -- not counted: finished image with nothing to draw
  ('c0400000-0000-4000-8000-000000000003'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'succeeded', 'image', null, null, null, null, true),
  -- counted: the source is gone, and the plate that says so is still a tile
  ('c0400000-0000-4000-8000-000000000004'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'succeeded', 'image', null, null, timezone('utc'::text, now()), null, true),
  -- not counted: archived, whatever else is true of it
  ('c0400000-0000-4000-8000-000000000005'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'succeeded', 'image', 'generated_images/counts/5.png', timezone('utc'::text, now()), null, null, true),
  -- not counted: failed, pending, processing
  ('c0400000-0000-4000-8000-000000000006'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'failed', 'image', null, null, null, null, true),
  ('c0400000-0000-4000-8000-000000000007'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'pending', 'image', null, null, null, null, true),
  ('c0400000-0000-4000-8000-000000000008'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'processing', 'video', null, null, null, null, true),
  -- not counted: a template-run step kept out of the studio
  ('c0400000-0000-4000-8000-000000000009'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'succeeded', 'image', 'generated_images/counts/9.png', null, null, 'c0300000-0000-4000-8000-000000000001'::uuid, false),
  -- counted: a template-run step shown in the studio
  ('c0400000-0000-4000-8000-000000000010'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'succeeded', 'image', 'generated_images/counts/10.png', null, null, 'c0300000-0000-4000-8000-000000000001'::uuid, true),
  -- counted: a plain run's studio flag is not consulted
  ('c0400000-0000-4000-8000-000000000011'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'succeeded', 'image', 'generated_images/counts/11.png', null, null, null, false),
  -- counted: made as the guest who later merged into the owner
  ('c0400000-0000-4000-8000-000000000012'::uuid, 'c0100002-0000-4000-8000-000000000002'::uuid, 'succeeded', 'image', 'generated_images/counts/12.png', null, null, null, true),
  -- not counted: someone else's
  ('c0400000-0000-4000-8000-000000000013'::uuid, 'c0100007-0000-4000-8000-000000000007'::uuid, 'succeeded', 'image', 'generated_images/counts/13.png', null, null, null, true),
  -- the friend's creation behind their public post, for the legacy saves below
  ('c0400000-0000-4000-8000-000000000014'::uuid, 'c0100005-0000-4000-8000-000000000005'::uuid, 'succeeded', 'image', 'generated_images/counts/14.png', null, null, null, true);

-- Posts. The owner's four: every visibility and review status counts for its
-- owner; only archiving moves one to the other scope.
insert into public.posts (id, user_id, visibility, review_status, archived_at, generation_id, category, source_kind, post_format, body, title)
values
  ('c0500000-0000-4000-8000-000000000001'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'public', 'visible', null, null, 'text', 'external', 'text', 'owner public', 'Owner public'),
  ('c0500000-0000-4000-8000-000000000002'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'private', 'visible', null, null, 'text', 'external', 'text', 'owner private', 'Owner private'),
  ('c0500000-0000-4000-8000-000000000003'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'public', 'hidden', null, null, 'text', 'external', 'text', 'owner hidden', 'Owner hidden'),
  ('c0500000-0000-4000-8000-000000000004'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'public', 'visible', timezone('utc'::text, now()), null, 'text', 'external', 'text', 'owner archived', 'Owner archived'),
  -- the friend's: one of each state a saved post can be in
  ('c0500000-0000-4000-8000-000000000011'::uuid, 'c0100005-0000-4000-8000-000000000005'::uuid, 'public', 'visible', null, 'c0400000-0000-4000-8000-000000000014'::uuid, 'text', 'external', 'text', 'friend public', 'Friend public'),
  ('c0500000-0000-4000-8000-000000000012'::uuid, 'c0100005-0000-4000-8000-000000000005'::uuid, 'private', 'visible', null, null, 'text', 'external', 'text', 'friend private', 'Friend private'),
  ('c0500000-0000-4000-8000-000000000013'::uuid, 'c0100005-0000-4000-8000-000000000005'::uuid, 'public', 'visible', timezone('utc'::text, now()), null, 'text', 'external', 'text', 'friend archived', 'Friend archived'),
  ('c0500000-0000-4000-8000-000000000014'::uuid, 'c0100005-0000-4000-8000-000000000005'::uuid, 'public', 'hidden', null, null, 'text', 'external', 'text', 'friend hidden', 'Friend hidden'),
  ('c0500000-0000-4000-8000-000000000015'::uuid, 'c0100005-0000-4000-8000-000000000005'::uuid, 'unlisted', 'visible', null, null, 'text', 'external', 'text', 'friend unlisted', 'Friend unlisted'),
  -- a public post by each creator on the wrong side of a block
  ('c0500000-0000-4000-8000-000000000021'::uuid, 'c0100003-0000-4000-8000-000000000003'::uuid, 'public', 'visible', null, null, 'text', 'external', 'text', 'blocked public', 'Blocked public'),
  ('c0500000-0000-4000-8000-000000000031'::uuid, 'c0100004-0000-4000-8000-000000000004'::uuid, 'public', 'visible', null, null, 'text', 'external', 'text', 'blocker public', 'Blocker public');

insert into public.user_blocks (blocker_user_id, blocked_user_id)
values
  ('c0100001-0000-4000-8000-000000000001'::uuid, 'c0100003-0000-4000-8000-000000000003'::uuid),
  ('c0100004-0000-4000-8000-000000000004'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid);

-- The owner saved all of them, plus their own public post.
insert into public.post_saves (user_id, post_id)
select 'c0100001-0000-4000-8000-000000000001'::uuid, id
from public.posts
where id in (
  'c0500000-0000-4000-8000-000000000001'::uuid,
  'c0500000-0000-4000-8000-000000000011'::uuid,
  'c0500000-0000-4000-8000-000000000012'::uuid,
  'c0500000-0000-4000-8000-000000000013'::uuid,
  'c0500000-0000-4000-8000-000000000014'::uuid,
  'c0500000-0000-4000-8000-000000000015'::uuid,
  'c0500000-0000-4000-8000-000000000021'::uuid,
  'c0500000-0000-4000-8000-000000000031'::uuid
);
-- A legacy save the owner also holds is ignored while post_saves exist.
insert into public.showcase_saves (user_id, generation_id)
values ('c0100001-0000-4000-8000-000000000001'::uuid, 'c0400000-0000-4000-8000-000000000014'::uuid);

-- The legacy person only ever saved through showcase_saves: one creation with
-- a public post behind it, one with none.
insert into public.showcase_saves (user_id, generation_id)
values
  ('c0100006-0000-4000-8000-000000000006'::uuid, 'c0400000-0000-4000-8000-000000000014'::uuid),
  ('c0100006-0000-4000-8000-000000000006'::uuid, 'c0400000-0000-4000-8000-000000000001'::uuid);

select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'creations')::int,
  5,
  'creations: finished with an output, source-gone, studio-visible step, plain run, and the merged guest''s'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'posts')::int,
  3,
  'posts: public, private and hidden all count for their owner'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'archivedPosts')::int,
  1,
  'archived posts are counted under their own key'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'saved')::int,
  3,
  'saved: the friend''s public and unlisted posts and the owner''s own; never private, archived, hidden or blocked either way'
);
select is(
  (public.owner_profile_counts('c0100006-0000-4000-8000-000000000006'::uuid) ->> 'saved')::int,
  1,
  'a person with only legacy showcase saves is counted through the posts behind them'
);
select is(
  public.owner_profile_counts('c0100006-0000-4000-8000-000000000006'::uuid) - 'saved',
  '{"creations": 0, "posts": 0, "archivedPosts": 0}'::jsonb,
  'a person with nothing else has zeros, not nulls'
);
select is(
  public.owner_profile_counts('c0100007-0000-4000-8000-000000000007'::uuid),
  '{"creations": 1, "posts": 0, "archivedPosts": 0, "saved": 0}'::jsonb,
  'a stranger sees only their own creation'
);
select is(
  public.owner_profile_counts('c0900000-0000-4000-8000-000000000000'::uuid),
  '{"creations": 0, "posts": 0, "archivedPosts": 0, "saved": 0}'::jsonb,
  'an unknown id is all zeros'
);

-- The numbers follow the rows.
update public.posts set archived_at = timezone('utc'::text, now())
where id = 'c0500000-0000-4000-8000-000000000001'::uuid;
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'posts')::int,
  2,
  'archiving a post takes it out of the active count'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'archivedPosts')::int,
  2,
  'and adds it to the archived count'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'saved')::int,
  2,
  'a save of a post that was since archived stops counting'
);
delete from public.user_blocks
where blocker_user_id = 'c0100001-0000-4000-8000-000000000001'::uuid;
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'saved')::int,
  3,
  'unblocking a creator brings their saved post back'
);
update public.generations set archived_at = timezone('utc'::text, now())
where id = 'c0400000-0000-4000-8000-000000000012'::uuid;
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'creations')::int,
  4,
  'archiving the merged guest''s creation takes it out of the owner''s count'
);

-- Only the server may ask.
select ok(
  not has_function_privilege('anon', 'public.owner_profile_counts(uuid)', 'execute'),
  'anon cannot count another person''s libraries'
);
select ok(
  not has_function_privilege('authenticated', 'public.owner_profile_counts(uuid)', 'execute'),
  'authenticated cannot count another person''s libraries'
);
select ok(
  has_function_privilege('service_role', 'public.owner_profile_counts(uuid)', 'execute'),
  'the service role counts for the profile route'
);
select ok(
  (select prosecdef from pg_proc where oid = 'public.owner_profile_counts(uuid)'::regprocedure),
  'runs as its definer, so RLS on the counted tables does not apply to the count'
);
select ok(
  exists (
    select 1
    from pg_proc, unnest(pg_proc.proconfig) as setting
    where pg_proc.oid = 'public.owner_profile_counts(uuid)'::regprocedure
      and setting in ('search_path=', 'search_path=""')
  ),
  'pins an empty search_path like the other service-role readers'
);
select is(
  (select provolatile from pg_proc where oid = 'public.owner_profile_counts(uuid)'::regprocedure),
  's',
  'is stable, so one request can call it beside the profile select'
);

select * from finish();

rollback;
