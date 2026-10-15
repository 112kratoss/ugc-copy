-- The guest merge carries what the guest told the feed
-- (20261015054611_merge_carries_guest_feed_preferences.sql, finding 02-5 of
-- the 2026-10-15 auth and pricing comparison).
--
-- A guest that hid a creator and marked a post Not interested signs up, and
-- the account sees both through the predicate every feed read uses (its own
-- user_id, is_active); where the account already had a row of its own, that
-- row is kept; the interest weights it lacked are copied; and a replay carries
-- nothing twice. The same carry gives a guest linked before the migration its
-- preferences back, and moves nothing between accounts that are not linked.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(29);

-- ─── Surface ─────────────────────────────────────────────────────────────────

select is(
  has_function_privilege('anon', 'public.carry_guest_feed_preferences(uuid, uuid)', 'EXECUTE'),
  false,
  'anonymous clients cannot carry preferences'
);
select is(
  has_function_privilege('authenticated', 'public.carry_guest_feed_preferences(uuid, uuid)', 'EXECUTE'),
  false,
  'signed-in clients cannot carry preferences'
);
select is(
  has_function_privilege('service_role', 'public.carry_guest_feed_preferences(uuid, uuid)', 'EXECUTE'),
  false,
  'the service role cannot carry preferences outside a merge'
);
select ok(
  has_function_privilege(
    (select procedures.proowner
     from pg_catalog.pg_proc as procedures
     where procedures.oid = 'public.merge_guest_account(uuid, uuid, text)'::regprocedure),
    'public.carry_guest_feed_preferences(uuid, uuid)',
    'EXECUTE'
  ),
  'the merge, running as its owner, may call the carry'
);
select ok(
  has_function_privilege('service_role', 'public.merge_guest_account(uuid, uuid, text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.merge_guest_account(uuid, uuid, text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.merge_guest_account(uuid, uuid, text)', 'EXECUTE'),
  'the merge stays callable by the service role only'
);
select ok(
  (select procedures.prosecdef
     and procedures.proconfig @> array['search_path=public, pg_temp']
   from pg_catalog.pg_proc as procedures
   where procedures.oid = 'public.merge_guest_account(uuid, uuid, text)'::regprocedure),
  'the merge still runs as its owner with its pinned search path'
);
select ok(
  (select not procedures.prosecdef
     and procedures.proconfig @> array['search_path=""']
   from pg_catalog.pg_proc as procedures
   where procedures.oid = 'public.carry_guest_feed_preferences(uuid, uuid)'::regprocedure),
  'the carry runs with its caller''s rights and an empty search path'
);

-- ─── Fixture ─────────────────────────────────────────────────────────────────
-- G (…01) is the guest and T (…02) the account it signs up as; creators A, B
-- and C (…03-…05) have one post each (P1-P3). G2 and T2 (…06, …07) were
-- linked before the migration; G3 (…08) is a guest linked to no one.

insert into auth.users (
  id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at
) values
  ('c5a00000-0000-4000-8000-000000000001', null,
   'authenticated', 'authenticated', true, '{}', '{}', now()),
  ('c5a00000-0000-4000-8000-000000000002', 'carry-target@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('c5a00000-0000-4000-8000-000000000003', 'carry-creator-a@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('c5a00000-0000-4000-8000-000000000004', 'carry-creator-b@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('c5a00000-0000-4000-8000-000000000005', 'carry-creator-c@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('c5a00000-0000-4000-8000-000000000006', null,
   'authenticated', 'authenticated', true, '{}', '{}', now()),
  ('c5a00000-0000-4000-8000-000000000007', 'carry-target-2@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('c5a00000-0000-4000-8000-000000000008', null,
   'authenticated', 'authenticated', true, '{}', '{}', now());

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, body,
  is_nsfw, created_at, updated_at
) values
  ('c5b00000-0000-4000-8000-000000000001', 'c5a00000-0000-4000-8000-000000000003',
   'public', 'text', 'external', 'text', 'visible', 'P1 by A', false, now(), now()),
  ('c5b00000-0000-4000-8000-000000000002', 'c5a00000-0000-4000-8000-000000000004',
   'public', 'text', 'external', 'text', 'visible', 'P2 by B', false, now(), now()),
  ('c5b00000-0000-4000-8000-000000000003', 'c5a00000-0000-4000-8000-000000000005',
   'public', 'text', 'external', 'text', 'visible', 'P3 by C', false, now(), now());

update public.profiles set credits = 30
where id = 'c5a00000-0000-4000-8000-000000000001';
update public.profiles set credits = 10
where id = 'c5a00000-0000-4000-8000-000000000002';

-- G marked P1 (the exclusion a report writes, reason 'reported') and P2, and
-- withdrew P3. T had already marked P2 itself.
insert into public.feed_user_post_feedback (
  user_id, post_id, feedback_type, is_active, reason, first_recorded_at, updated_at
) values
  ('c5a00000-0000-4000-8000-000000000001', 'c5b00000-0000-4000-8000-000000000001',
   'not_interested', true, 'reported', '2026-10-10T10:00:00Z', '2026-10-10T10:00:00Z'),
  ('c5a00000-0000-4000-8000-000000000001', 'c5b00000-0000-4000-8000-000000000002',
   'not_interested', true, null, '2026-10-11T10:00:00Z', '2026-10-11T10:00:00Z'),
  ('c5a00000-0000-4000-8000-000000000001', 'c5b00000-0000-4000-8000-000000000003',
   'not_interested', false, null, '2026-10-11T11:00:00Z', '2026-10-11T11:00:00Z'),
  ('c5a00000-0000-4000-8000-000000000002', 'c5b00000-0000-4000-8000-000000000002',
   'not_interested', true, null, '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z');

-- G hid A and B, withdrew C, and hid T, the account it is about to become. T
-- had already hidden B itself.
insert into public.feed_user_creator_feedback (
  user_id, creator_user_id, feedback_type, is_active, reason, first_recorded_at, updated_at
) values
  ('c5a00000-0000-4000-8000-000000000001', 'c5a00000-0000-4000-8000-000000000003',
   'hide_creator', true, null, '2026-10-12T08:00:00Z', '2026-10-12T08:00:00Z'),
  ('c5a00000-0000-4000-8000-000000000001', 'c5a00000-0000-4000-8000-000000000004',
   'hide_creator', true, null, '2026-10-12T09:00:00Z', '2026-10-12T09:00:00Z'),
  ('c5a00000-0000-4000-8000-000000000001', 'c5a00000-0000-4000-8000-000000000005',
   'hide_creator', false, null, '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z'),
  ('c5a00000-0000-4000-8000-000000000001', 'c5a00000-0000-4000-8000-000000000002',
   'hide_creator', true, null, '2026-10-12T11:00:00Z', '2026-10-12T11:00:00Z'),
  ('c5a00000-0000-4000-8000-000000000002', 'c5a00000-0000-4000-8000-000000000004',
   'hide_creator', true, null, '2026-10-02T09:00:00Z', '2026-10-02T09:00:00Z');

-- G weighs anime and (negatively) creator A; T already weighs anime itself.
insert into public.user_interest_weights (
  user_id, dimension_type, dimension_value, weight, positive_score, negative_score,
  positive_event_count, negative_event_count, last_event_at, last_event_received_at
) values
  ('c5a00000-0000-4000-8000-000000000001', 'category', 'anime',
   6.0, 6.0, 0, 2, 0, now(), now()),
  ('c5a00000-0000-4000-8000-000000000001', 'creator', 'c5a00000-0000-4000-8000-000000000003',
   -8.0, 0, 8.0, 0, 1, now(), now()),
  ('c5a00000-0000-4000-8000-000000000002', 'category', 'anime',
   1.5, 1.5, 0, 1, 0, now(), now());

-- ─── The guest signs up ──────────────────────────────────────────────────────

select is(
  public.merge_guest_account(
    'c5a00000-0000-4000-8000-000000000001',
    'c5a00000-0000-4000-8000-000000000002',
    'mobile'
  ) ->> 'status',
  'merged',
  'the guest links to the account it signed up as'
);
select is(
  (select credits from public.profiles where id = 'c5a00000-0000-4000-8000-000000000002'),
  40,
  'the balance moves exactly as before'
);
select ok(
  exists(
    select 1 from public.feed_user_creator_feedback
    where user_id = 'c5a00000-0000-4000-8000-000000000002'
      and creator_user_id = 'c5a00000-0000-4000-8000-000000000003'
      and is_active
  ),
  'the account keeps the creator the guest hid out of its feed'
);
select ok(
  exists(
    select 1 from public.feed_user_post_feedback
    where user_id = 'c5a00000-0000-4000-8000-000000000002'
      and post_id = 'c5b00000-0000-4000-8000-000000000001'
      and is_active
  ),
  'the account keeps the post the guest marked out of its feed'
);
select is(
  (select first_recorded_at from public.feed_user_creator_feedback
   where user_id = 'c5a00000-0000-4000-8000-000000000002'
     and creator_user_id = 'c5a00000-0000-4000-8000-000000000003'),
  '2026-10-12T08:00:00Z'::timestamptz,
  'a carried Hide keeps the moment the guest made it'
);
select is(
  (select reason from public.feed_user_post_feedback
   where user_id = 'c5a00000-0000-4000-8000-000000000002'
     and post_id = 'c5b00000-0000-4000-8000-000000000001'),
  'reported',
  'a carried row keeps its reason, so an Undo still leaves a report''s exclusion alone'
);
select is(
  (select first_recorded_at from public.feed_user_post_feedback
   where user_id = 'c5a00000-0000-4000-8000-000000000002'
     and post_id = 'c5b00000-0000-4000-8000-000000000002'),
  '2026-10-01T09:00:00Z'::timestamptz,
  'the account''s own Not interested is kept over the guest''s'
);
select is(
  (select first_recorded_at from public.feed_user_creator_feedback
   where user_id = 'c5a00000-0000-4000-8000-000000000002'
     and creator_user_id = 'c5a00000-0000-4000-8000-000000000004'),
  '2026-10-02T09:00:00Z'::timestamptz,
  'the account''s own Hide is kept over the guest''s'
);
select is(
  (select count(*) from public.feed_user_post_feedback
   where user_id = 'c5a00000-0000-4000-8000-000000000002'
     and post_id = 'c5b00000-0000-4000-8000-000000000003')
  + (select count(*) from public.feed_user_creator_feedback
     where user_id = 'c5a00000-0000-4000-8000-000000000002'
       and creator_user_id = 'c5a00000-0000-4000-8000-000000000005'),
  0::bigint,
  'a preference the guest withdrew is not carried'
);
select is(
  (select array_agg(creator_user_id order by creator_user_id)
   from public.feed_user_creator_feedback
   where user_id = 'c5a00000-0000-4000-8000-000000000002'),
  array[
    'c5a00000-0000-4000-8000-000000000003',
    'c5a00000-0000-4000-8000-000000000004'
  ]::uuid[],
  'the guest''s Hide of the account itself is dropped rather than failing the merge'
);
select is(
  (select count(*) from public.feed_user_post_feedback
   where user_id = 'c5a00000-0000-4000-8000-000000000001')
  + (select count(*) from public.feed_user_creator_feedback
     where user_id = 'c5a00000-0000-4000-8000-000000000001'),
  0::bigint,
  'the guest holds no Hide or Not interested afterwards: they moved'
);
select is(
  (select weight from public.user_interest_weights
   where user_id = 'c5a00000-0000-4000-8000-000000000002'
     and dimension_type = 'category' and dimension_value = 'anime'),
  1.5::double precision,
  'the account''s own interest weight is kept'
);
select is(
  (select weight from public.user_interest_weights
   where user_id = 'c5a00000-0000-4000-8000-000000000002'
     and dimension_type = 'creator'
     and dimension_value = 'c5a00000-0000-4000-8000-000000000003'),
  -8.0::double precision,
  'an interest the account lacked is copied from the guest'
);
select is(
  (select count(*) from public.user_interest_weights
   where user_id = 'c5a00000-0000-4000-8000-000000000001'),
  2::bigint,
  'the guest''s interest rows are copied, not moved'
);

-- ─── Replay ──────────────────────────────────────────────────────────────────

select is(
  public.merge_guest_account(
    'c5a00000-0000-4000-8000-000000000001',
    'c5a00000-0000-4000-8000-000000000002',
    'mobile'
  ) ->> 'status',
  'already_merged',
  'a replayed merge reports success'
);
select is(
  (select count(*) from public.feed_user_post_feedback
   where user_id = 'c5a00000-0000-4000-8000-000000000002')::text
  || '/' || (select count(*) from public.feed_user_creator_feedback
             where user_id = 'c5a00000-0000-4000-8000-000000000002')::text
  || '/' || (select count(*) from public.user_interest_weights
             where user_id = 'c5a00000-0000-4000-8000-000000000002')::text
  || '/' || (select credits from public.profiles
             where id = 'c5a00000-0000-4000-8000-000000000002')::text,
  '2/2/2/40',
  'a replay carries nothing and pays nothing a second time'
);

-- ─── A guest linked before this migration ────────────────────────────────────
-- Linked the way the older merge left it: the link made, the preferences not
-- moved. The migration runs the same carry for every such guest.

update public.profiles
set merged_into_user_id = 'c5a00000-0000-4000-8000-000000000007',
    merged_at = now()
where id = 'c5a00000-0000-4000-8000-000000000006';

insert into public.feed_user_creator_feedback (user_id, creator_user_id, feedback_type)
values ('c5a00000-0000-4000-8000-000000000006', 'c5a00000-0000-4000-8000-000000000003', 'hide_creator');
insert into public.feed_user_post_feedback (user_id, post_id, feedback_type)
values ('c5a00000-0000-4000-8000-000000000006', 'c5b00000-0000-4000-8000-000000000002', 'not_interested');

select lives_ok(
  $$ select public.carry_guest_feed_preferences(
       'c5a00000-0000-4000-8000-000000000006',
       'c5a00000-0000-4000-8000-000000000007'
     ) $$,
  'the carry runs for a guest linked before the migration'
);
select is(
  (select count(*) from public.feed_user_creator_feedback
   where user_id = 'c5a00000-0000-4000-8000-000000000007'
     and creator_user_id = 'c5a00000-0000-4000-8000-000000000003'
     and is_active)
  + (select count(*) from public.feed_user_post_feedback
     where user_id = 'c5a00000-0000-4000-8000-000000000007'
       and post_id = 'c5b00000-0000-4000-8000-000000000002'
       and is_active),
  2::bigint,
  'that guest''s account gets its Hide and Not interested back'
);
select lives_ok(
  $$ select public.carry_guest_feed_preferences(
       'c5a00000-0000-4000-8000-000000000006',
       'c5a00000-0000-4000-8000-000000000007'
     ) $$,
  'carrying the same guest again does not fail'
);
select is(
  (select count(*) from public.feed_user_creator_feedback
   where user_id in ('c5a00000-0000-4000-8000-000000000006',
                     'c5a00000-0000-4000-8000-000000000007'))
  + (select count(*) from public.feed_user_post_feedback
     where user_id in ('c5a00000-0000-4000-8000-000000000006',
                       'c5a00000-0000-4000-8000-000000000007')),
  2::bigint,
  'and changes nothing: each row is held once, by the account'
);

-- ─── Accounts that are not linked ────────────────────────────────────────────

insert into public.feed_user_creator_feedback (user_id, creator_user_id, feedback_type)
values ('c5a00000-0000-4000-8000-000000000008', 'c5a00000-0000-4000-8000-000000000005', 'hide_creator');

select lives_ok(
  $$ select public.carry_guest_feed_preferences(
       'c5a00000-0000-4000-8000-000000000008',
       'c5a00000-0000-4000-8000-000000000002'
     ) $$,
  'asking to carry between accounts that are not linked does not fail'
);
select ok(
  exists(
    select 1 from public.feed_user_creator_feedback
    where user_id = 'c5a00000-0000-4000-8000-000000000008'
      and creator_user_id = 'c5a00000-0000-4000-8000-000000000005'
  )
  and not exists(
    select 1 from public.feed_user_creator_feedback
    where user_id = 'c5a00000-0000-4000-8000-000000000002'
      and creator_user_id = 'c5a00000-0000-4000-8000-000000000005'
  ),
  'and moves nothing: a guest''s preferences reach only the account it is linked to'
);

select * from finish();
rollback;
