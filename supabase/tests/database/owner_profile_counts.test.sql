-- owner_profile_counts must agree with the profile library lists: the same
-- rows the Creations, Posts and Saved tabs draw, counted once. The fixtures
-- mirror ugc-mobile/__tests__/creation-library.test.ts and the Saved list's
-- visibility and block rules, so a change to either list shows up here.
-- Studio's filters are counted too (creationsByKind, postsByVisibility): a
-- library built one case at a time pins the filter the owner lists file each
-- creation and post under.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(62);

-- People (each id has its own first octet: handle_new_user builds a fallback
-- username from the first eight characters, and usernames are unique): the owner, a guest profile merged into the owner, a creator the
-- owner blocked, a creator who blocked the owner, a friendly creator, a
-- person with only legacy showcase saves, a stranger, and a creator whose
-- library is built case by case for Studio's filters, with a merged guest of
-- their own.
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values
  ('c0100001-0000-4000-8000-000000000001'::uuid, 'counts-owner@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100002-0000-4000-8000-000000000002'::uuid, 'counts-guest@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100003-0000-4000-8000-000000000003'::uuid, 'counts-blocked@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100004-0000-4000-8000-000000000004'::uuid, 'counts-blocker@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100005-0000-4000-8000-000000000005'::uuid, 'counts-friend@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100006-0000-4000-8000-000000000006'::uuid, 'counts-legacy@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100007-0000-4000-8000-000000000007'::uuid, 'counts-stranger@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100008-0000-4000-8000-000000000008'::uuid, 'counts-kinds@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now())),
  ('c0100009-0000-4000-8000-000000000009'::uuid, 'counts-kinds-guest@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, timezone('utc'::text, now()));

-- handle_new_user gave each of them a profile. Each guest's is merged into
-- their account, the way a sign-up links a guest's library.
update public.profiles
set merged_into_user_id = 'c0100001-0000-4000-8000-000000000001'::uuid,
    merged_at = timezone('utc'::text, now()),
    identity_state = 'merged'
where id = 'c0100002-0000-4000-8000-000000000002'::uuid;
update public.profiles
set merged_into_user_id = 'c0100008-0000-4000-8000-000000000008'::uuid,
    merged_at = timezone('utc'::text, now()),
    identity_state = 'merged'
where id = 'c0100009-0000-4000-8000-000000000009'::uuid;
select is(
  (select count(*)::int from public.profiles where merged_into_user_id = 'c0100001-0000-4000-8000-000000000001'::uuid),
  1,
  'fixture: the guest profile is merged into the owner'
);
select is(
  (select count(*)::int from public.profiles where merged_into_user_id = 'c0100008-0000-4000-8000-000000000008'::uuid),
  1,
  'fixture: the kinds creator''s guest profile is merged into them'
);

-- A template run each, so the studio-visibility rule for run steps can be exercised.
insert into public.templates (id, name)
values ('c0200000-0000-4000-8000-000000000001'::uuid, 'Counts fixture template');
insert into public.template_runs (
  id, template_id, user_id, graph_snapshot, graph_hash, output_node_id, output_kind,
  estimated_total_credits, estimated_remaining_credits
) values
  (
    'c0300000-0000-4000-8000-000000000001'::uuid, 'c0200000-0000-4000-8000-000000000001'::uuid,
    'c0100001-0000-4000-8000-000000000001'::uuid, '{}'::jsonb, 'counts-fixture', 'output', 'image', 0, 0
  ),
  (
    'c0300000-0000-4000-8000-000000000002'::uuid, 'c0200000-0000-4000-8000-000000000001'::uuid,
    'c0100008-0000-4000-8000-000000000008'::uuid, '{}'::jsonb, 'counts-kinds-fixture', 'output', 'video', 0, 0
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
  ('c0400000-0000-4000-8000-000000000014'::uuid, 'c0100005-0000-4000-8000-000000000005'::uuid, 'succeeded', 'image', 'generated_images/counts/14.png', null, null, null, true),
  -- The Failed and Archived scopes. Row 6 above is a failed run and row 5 an
  -- archived creation; these are the cases either side of them.
  -- failed: made as the merged guest
  ('c0400000-0000-4000-8000-000000000015'::uuid, 'c0100002-0000-4000-8000-000000000002'::uuid, 'failed', 'video', null, null, null, null, true),
  -- neither: a failed run that was archived
  ('c0400000-0000-4000-8000-000000000016'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'failed', 'image', null, timezone('utc'::text, now()), null, null, true),
  -- neither: a failed template-run step, which the Studio never lists
  ('c0400000-0000-4000-8000-000000000017'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'failed', 'image', null, null, null, 'c0300000-0000-4000-8000-000000000001'::uuid, true),
  -- neither: an archived finished run with nothing to draw
  ('c0400000-0000-4000-8000-000000000018'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'succeeded', 'image', null, timezone('utc'::text, now()), null, null, true),
  -- archived: its source is gone, and the plate is still a tile there too
  ('c0400000-0000-4000-8000-000000000019'::uuid, 'c0100001-0000-4000-8000-000000000001'::uuid, 'succeeded', 'image', null, timezone('utc'::text, now()), timezone('utc'::text, now()), null, true);

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
  public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) -> 'creationsByKind',
  '{"images": 5, "videos": 0, "audio": 0}'::jsonb,
  'creations by kind: the five are pictures; the processing clip and the merged guest''s failed one are under no filter'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'failedCreations')::int,
  2,
  'failed creations: the owner''s and the merged guest''s; never archived, a template step, pending or processing'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'archivedCreations')::int,
  2,
  'archived creations: the library rule with archived_at set; never a failed run or one with nothing to draw'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'posts')::int,
  3,
  'posts: public, private and hidden all count for their owner'
);
select is(
  public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) -> 'postsByVisibility',
  '{"public": 2, "unlisted": 0, "private": 1}'::jsonb,
  'posts by visibility: the public and the hidden public one, and the private one; the archived one under none'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'archivedPosts')::int,
  1,
  'archived posts are counted under their own key'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'saved')::int,
  2,
  'saved: the friend''s public post and the owner''s own (an unlisted one is stored private); never private, archived, hidden or blocked either way'
);
select is(
  (public.owner_profile_counts('c0100006-0000-4000-8000-000000000006'::uuid) ->> 'saved')::int,
  1,
  'a person with only legacy showcase saves is counted through the posts behind them'
);
select is(
  public.owner_profile_counts('c0100006-0000-4000-8000-000000000006'::uuid) - 'saved',
  '{"creations": 0, "creationsByKind": {"images": 0, "videos": 0, "audio": 0}, "failedCreations": 0, "archivedCreations": 0, "posts": 0, "postsByVisibility": {"public": 0, "unlisted": 0, "private": 0}, "archivedPosts": 0}'::jsonb,
  'a person with nothing else has zeros, not nulls'
);
select is(
  public.owner_profile_counts('c0100007-0000-4000-8000-000000000007'::uuid),
  '{"creations": 1, "creationsByKind": {"images": 1, "videos": 0, "audio": 0}, "failedCreations": 0, "archivedCreations": 0, "posts": 0, "postsByVisibility": {"public": 0, "unlisted": 0, "private": 0}, "archivedPosts": 0, "saved": 0}'::jsonb,
  'a stranger sees only their own creation'
);
select is(
  public.owner_profile_counts('c0900000-0000-4000-8000-000000000000'::uuid),
  '{"creations": 0, "creationsByKind": {"images": 0, "videos": 0, "audio": 0}, "failedCreations": 0, "archivedCreations": 0, "posts": 0, "postsByVisibility": {"public": 0, "unlisted": 0, "private": 0}, "archivedPosts": 0, "saved": 0}'::jsonb,
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
  public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) -> 'postsByVisibility',
  '{"public": 1, "unlisted": 0, "private": 1}'::jsonb,
  'and out of its visibility''s count'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'archivedPosts')::int,
  2,
  'and adds it to the archived count'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'saved')::int,
  1,
  'a save of a post that was since archived stops counting'
);
delete from public.user_blocks
where blocker_user_id = 'c0100001-0000-4000-8000-000000000001'::uuid;
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'saved')::int,
  2,
  'unblocking a creator brings their saved post back'
);
update public.generations set archived_at = timezone('utc'::text, now())
where id = 'c0400000-0000-4000-8000-000000000012'::uuid;
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'creations')::int,
  4,
  'archiving the merged guest''s creation takes it out of the owner''s count'
);
select is(
  public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) -> 'creationsByKind',
  '{"images": 4, "videos": 0, "audio": 0}'::jsonb,
  'and out of its kind''s count'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'archivedCreations')::int,
  3,
  'and adds it to the archived creations'
);
update public.generations set archived_at = timezone('utc'::text, now())
where id = 'c0400000-0000-4000-8000-000000000006'::uuid;
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'failedCreations')::int,
  1,
  'archiving a failed run takes it out of the failed count'
);
select is(
  (public.owner_profile_counts('c0100001-0000-4000-8000-000000000001'::uuid) ->> 'archivedCreations')::int,
  3,
  'without counting it as an archived creation'
);

-- Studio's media filters. The kinds creator's library is built one case at a
-- time, each followed by the counts, so every case pins the filter it is
-- filed under: the owner list's reading of a creation (its file by extension
-- or storage folder, then its category: a sound first, then a video, and a
-- picture for anything else), which Studio's filters read.
create function pg_temp.kinds() returns jsonb language sql as $$
  select public.owner_profile_counts('c0100008-0000-4000-8000-000000000008'::uuid) -> 'creationsByKind'
$$;

-- A picture.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000001'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'image', 'generated_images/kinds/1.png', null, null, null, true);
select is(pg_temp.kinds(), '{"images": 1, "videos": 0, "audio": 0}'::jsonb, 'a picture is under Images');

-- No category: a picture's extension, in any case, files it.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000002'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', null, 'https://cdn.example.invalid/kinds/2.WEBP', null, null, null, true);
select is(pg_temp.kinds(), '{"images": 2, "videos": 0, "audio": 0}'::jsonb, 'a creation with no category and a picture''s address is under Images');

-- The source is gone: the category files it.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000003'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'image', null, null, timezone('utc'::text, now()), null, true);
select is(pg_temp.kinds(), '{"images": 3, "videos": 0, "audio": 0}'::jsonb, 'a picture whose source is gone is under Images');

-- Nothing to read a kind from: the list reads a picture.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000004'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', null, null, null, timezone('utc'::text, now()), null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 0, "audio": 0}'::jsonb, 'a creation with no category and no file is under Images');

-- A clip.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000005'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'video', 'generated_videos/kinds/5.mp4', null, null, null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 1, "audio": 0}'::jsonb, 'a clip is under Videos');

-- No category: a clip's address files it (a legacy video).
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000006'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', null, 'https://cdn.example.invalid/kinds/6.MOV?token=abc', null, null, null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 2, "audio": 0}'::jsonb, 'a creation with no category and a clip''s address is under Videos');

-- A clip's storage folder under an image category: the file files it.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000007'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'image', 'generated_videos/kinds/7', null, null, null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 3, "audio": 0}'::jsonb, 'a clip''s file under an image category is under Videos');

-- A video category over a picture's address: the category files it.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000008'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'video', 'generated_images/kinds/8.png', null, null, null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 4, "audio": 0}'::jsonb, 'a video category over a picture''s file is under Videos');

-- The source is gone: the category files it.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000009'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'video', null, null, timezone('utc'::text, now()), null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 5, "audio": 0}'::jsonb, 'a clip whose source is gone is under Videos');

-- A sound.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000010'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'audio', 'generated_audio/kinds/10.mp3', null, null, null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 5, "audio": 1}'::jsonb, 'a sound is under Audio');

-- No category: a sound's extension files it.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000011'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', null, 'https://cdn.example.invalid/kinds/11.wav', null, null, null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 5, "audio": 2}'::jsonb, 'a creation with no category and a sound''s address is under Audio');

-- A sound file under a video category: the sound files it.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000012'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'video', 'https://cdn.example.invalid/kinds/12.m4a', null, null, null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 5, "audio": 3}'::jsonb, 'a sound''s file under a video category is under Audio');

-- An audio category over a clip's storage folder: the category files it.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values ('c0600000-0000-4000-8000-000000000013'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'audio', 'generated_videos/kinds/13.mp4', null, null, null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 5, "audio": 4}'::jsonb, 'an audio category over a clip''s file is under Audio');

-- Archived, of each kind: under no filter.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values
  ('c0600000-0000-4000-8000-000000000014'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'image', 'generated_images/kinds/14.png', timezone('utc'::text, now()), null, null, true),
  ('c0600000-0000-4000-8000-000000000015'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'video', 'generated_videos/kinds/15.mp4', timezone('utc'::text, now()), null, null, true),
  ('c0600000-0000-4000-8000-000000000016'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'audio', 'generated_audio/kinds/16.mp3', timezone('utc'::text, now()), null, null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 5, "audio": 4}'::jsonb, 'an archived creation of any kind is under no filter');

-- A failed run, one still rendering, and a finished one with nothing to draw:
-- under no filter.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values
  ('c0600000-0000-4000-8000-000000000017'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'failed', 'video', null, null, null, null, true),
  ('c0600000-0000-4000-8000-000000000018'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'processing', 'audio', null, null, null, null, true),
  ('c0600000-0000-4000-8000-000000000019'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'video', null, null, null, null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 5, "audio": 4}'::jsonb, 'a failed or unfinished run, or one with nothing to draw, is under no filter');

-- Two steps of a template run: one kept out of the studio, one shown there.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values
  ('c0600000-0000-4000-8000-000000000020'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'video', 'generated_videos/kinds/20.mp4', null, null, 'c0300000-0000-4000-8000-000000000002'::uuid, false),
  ('c0600000-0000-4000-8000-000000000021'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'succeeded', 'video', 'generated_videos/kinds/21.mp4', null, null, 'c0300000-0000-4000-8000-000000000002'::uuid, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 6, "audio": 4}'::jsonb, 'a template-run step is under its filter only while the studio shows it');

-- Made as the guest who merged into the kinds creator: a sound, and an
-- archived clip.
insert into public.generations (id, user_id, status, category, output_url, archived_at, source_unavailable_at, template_run_id, studio_visible)
values
  ('c0600000-0000-4000-8000-000000000022'::uuid, 'c0100009-0000-4000-8000-000000000009'::uuid, 'succeeded', 'audio', 'generated_audio/kinds/22.mp3', null, null, null, true),
  ('c0600000-0000-4000-8000-000000000023'::uuid, 'c0100009-0000-4000-8000-000000000009'::uuid, 'succeeded', 'video', 'generated_videos/kinds/23.mp4', timezone('utc'::text, now()), null, null, true);
select is(pg_temp.kinds(), '{"images": 4, "videos": 6, "audio": 5}'::jsonb, 'the merged guest''s creation is under its filter, and their archived one under none');

select is(
  (
    select (counts.value -> 'creationsByKind' ->> 'images')::int
      + (counts.value -> 'creationsByKind' ->> 'videos')::int
      + (counts.value -> 'creationsByKind' ->> 'audio')::int
    from (select public.owner_profile_counts('c0100008-0000-4000-8000-000000000008'::uuid) as value) as counts
  ),
  (public.owner_profile_counts('c0100008-0000-4000-8000-000000000008'::uuid) ->> 'creations')::int,
  'the media filters add up to the Active creations'
);
select is(
  (public.owner_profile_counts('c0100008-0000-4000-8000-000000000008'::uuid) ->> 'creations')::int,
  15,
  'which are fifteen'
);

-- The Post Library's visibility filters, built the same way.
create function pg_temp.visibilities() returns jsonb language sql as $$
  select public.owner_profile_counts('c0100008-0000-4000-8000-000000000008'::uuid) -> 'postsByVisibility'
$$;

insert into public.posts (id, user_id, visibility, review_status, archived_at, generation_id, category, source_kind, post_format, body, title)
values ('c0700000-0000-4000-8000-000000000001'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'public', 'visible', null, null, 'text', 'external', 'text', 'kinds public', 'Kinds public');
select is(pg_temp.visibilities(), '{"public": 1, "unlisted": 0, "private": 0}'::jsonb, 'a public post is under Public');

insert into public.posts (id, user_id, visibility, review_status, archived_at, generation_id, category, source_kind, post_format, body, title)
values ('c0700000-0000-4000-8000-000000000002'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'public', 'hidden', null, null, 'text', 'external', 'text', 'kinds hidden', 'Kinds hidden');
select is(pg_temp.visibilities(), '{"public": 2, "unlisted": 0, "private": 0}'::jsonb, 'a public post hidden by review is under Public for its owner');

insert into public.posts (id, user_id, visibility, review_status, archived_at, generation_id, category, source_kind, post_format, body, title)
values ('c0700000-0000-4000-8000-000000000003'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'private', 'visible', null, null, 'text', 'external', 'text', 'kinds private', 'Kinds private');
select is(pg_temp.visibilities(), '{"public": 2, "unlisted": 0, "private": 1}'::jsonb, 'a private post is under Private');

-- One more live post and three archived ones. A post is stored public or
-- private since 20261017144307; two are stored unlisted all the same, with the
-- trigger that relabels a request set aside, as a row written past it would be.
insert into public.posts (id, user_id, visibility, review_status, archived_at, generation_id, category, source_kind, post_format, body, title)
values
  ('c0700000-0000-4000-8000-000000000004'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'private', 'visible', null, null, 'text', 'external', 'text', 'kinds unlisted', 'Kinds unlisted'),
  ('c0700000-0000-4000-8000-000000000005'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'public', 'visible', timezone('utc'::text, now()), null, 'text', 'external', 'text', 'kinds archived public', 'Kinds archived public'),
  ('c0700000-0000-4000-8000-000000000006'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'private', 'visible', timezone('utc'::text, now()), null, 'text', 'external', 'text', 'kinds archived private', 'Kinds archived private'),
  ('c0700000-0000-4000-8000-000000000007'::uuid, 'c0100008-0000-4000-8000-000000000008'::uuid, 'private', 'visible', timezone('utc'::text, now()), null, 'text', 'external', 'text', 'kinds archived unlisted', 'Kinds archived unlisted');
set local session_replication_role = replica;
update public.posts set visibility = 'unlisted'
where id in ('c0700000-0000-4000-8000-000000000004'::uuid, 'c0700000-0000-4000-8000-000000000007'::uuid);
set local session_replication_role = origin;
select is(
  (select count(*)::int from public.posts
   where id in ('c0700000-0000-4000-8000-000000000004'::uuid, 'c0700000-0000-4000-8000-000000000007'::uuid)
     and visibility = 'unlisted'),
  2,
  'fixture: two of the kinds creator''s posts are stored unlisted'
);
select is(
  pg_temp.visibilities(),
  '{"public": 2, "unlisted": 1, "private": 1}'::jsonb,
  'a post stored unlisted is under Unlisted, and an archived post under none, whatever its visibility'
);
select is(
  (
    select (counts.value -> 'postsByVisibility' ->> 'public')::int
      + (counts.value -> 'postsByVisibility' ->> 'unlisted')::int
      + (counts.value -> 'postsByVisibility' ->> 'private')::int
    from (select public.owner_profile_counts('c0100008-0000-4000-8000-000000000008'::uuid) as value) as counts
  ),
  (public.owner_profile_counts('c0100008-0000-4000-8000-000000000008'::uuid) ->> 'posts')::int,
  'the visibility filters add up to the live posts'
);
select is(
  (public.owner_profile_counts('c0100008-0000-4000-8000-000000000008'::uuid) ->> 'archivedPosts')::int,
  3,
  'the archived posts are counted under their own key'
);

-- The filters follow the rows.
update public.posts set visibility = 'private'
where id = 'c0700000-0000-4000-8000-000000000001'::uuid;
select is(pg_temp.visibilities(), '{"public": 1, "unlisted": 1, "private": 2}'::jsonb, 'a post made private moves from Public to Private');
update public.posts set visibility = 'unlisted'
where id = 'c0700000-0000-4000-8000-000000000002'::uuid;
select is(pg_temp.visibilities(), '{"public": 0, "unlisted": 1, "private": 3}'::jsonb, 'a post asked to go unlisted is stored private, and counted there');
update public.posts set archived_at = timezone('utc'::text, now())
where id = 'c0700000-0000-4000-8000-000000000004'::uuid;
select is(pg_temp.visibilities(), '{"public": 0, "unlisted": 0, "private": 3}'::jsonb, 'archiving a post takes it out of its visibility''s count');
update public.posts set archived_at = null
where id = 'c0700000-0000-4000-8000-000000000005'::uuid;
select is(pg_temp.visibilities(), '{"public": 1, "unlisted": 0, "private": 3}'::jsonb, 'restoring one puts it back under its visibility');
update public.generations set source_unavailable_at = timezone('utc'::text, now())
where id = 'c0600000-0000-4000-8000-000000000019'::uuid;
select is(pg_temp.kinds(), '{"images": 4, "videos": 7, "audio": 5}'::jsonb, 'a finished clip with nothing to draw is under Videos once the plate that says its source is gone is a tile');
update public.generations set archived_at = timezone('utc'::text, now())
where id = 'c0600000-0000-4000-8000-000000000010'::uuid;
select is(pg_temp.kinds(), '{"images": 4, "videos": 7, "audio": 4}'::jsonb, 'archiving a sound takes it out of Audio');

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
