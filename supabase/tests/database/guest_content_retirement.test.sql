-- Idle guests that made something (20261104135818): which ones the retention
-- job may retire through the account-deletion pipeline. Each exclusion is an
-- identity idle and made-something but for that one thing, next to identities
-- that are listed.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- ─── Privilege boundaries ────────────────────────────────────────────────────

select ok(
  (select prosecdef and proconfig @> array['search_path=""']
   from pg_catalog.pg_proc
   where oid = 'public.list_idle_guest_identities_with_content(timestamptz, integer, uuid)'::regprocedure),
  'the list runs as its owner with a fixed search path'
);
select is(
  pg_catalog.has_function_privilege('anon', 'public.list_idle_guest_identities_with_content(timestamptz, integer, uuid)', 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated', 'public.list_idle_guest_identities_with_content(timestamptz, integer, uuid)', 'EXECUTE'),
  false,
  'no client can list them'
);
select ok(
  pg_catalog.has_function_privilege('service_role', 'public.list_idle_guest_identities_with_content(timestamptz, integer, uuid)', 'EXECUTE'),
  'the retention job can'
);
select is(
  (select provolatile from pg_catalog.pg_proc
   where oid = 'public.list_idle_guest_identities_with_content(timestamptz, integer, uuid)'::regprocedure),
  's'::"char",
  'the list only reads'
);

-- ─── Fixtures ────────────────────────────────────────────────────────────────
--
--   ...0001  a registered account (owns the feed post, is a merge target)
--   ...0201  a guest idle 200 days with a creation           listed
--   ...0202  a guest idle 200 days with an upload only       listed
--   ...0203  a guest idle 120 days with a creation
--   ...0204  ... with a creation and a post
--   ...0205  ... with a creation and credits
--   ...0206  ... with a creation and a purchase
--   ...0207  ... with a creation, linked to the account
--   ...0208  a guest idle 200 days with nothing (the first list's)
--   ...0209  an account idle 400 days with a creation
--   ...0210  ... with a creation and a feed event 10 days ago
--   ...0211  a guest idle 300 days with a creation           listed first
--   ...0212  a guest idle 200 days with AI usage only        listed
--   ...0213  ... with a creation made 10 days ago
--   ...0214  ... with a creation and a report naming the guest
--   ...0215  ... with a creation someone reported
--   ...0216  ... with a creation a moderator removed
--   ...0217  ... with a creation a moderation action was taken on
--   ...0218  ... with a creation and a post report the guest filed

insert into auth.users (
  id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, last_sign_in_at
)
select
  fixture.id::uuid, fixture.email, 'authenticated', 'authenticated', fixture.email is null,
  '{}'::jsonb, '{}'::jsonb,
  now() - fixture.idle, now() - fixture.idle, now() - fixture.idle
from (values
  ('c6000000-0000-4000-8000-000000000001', 'content-guest-account@example.invalid', interval '400 days'),
  ('c6000000-0000-4000-8000-000000000201', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000202', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000203', null, interval '120 days'),
  ('c6000000-0000-4000-8000-000000000204', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000205', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000206', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000207', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000208', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000209', 'content-guest-idle-account@example.invalid', interval '400 days'),
  ('c6000000-0000-4000-8000-000000000210', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000211', null, interval '300 days'),
  ('c6000000-0000-4000-8000-000000000212', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000213', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000214', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000215', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000216', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000217', null, interval '200 days'),
  ('c6000000-0000-4000-8000-000000000218', null, interval '200 days')
) as fixture(id, email, idle);

-- A creation each, made when the guest was last used.
insert into public.generations (id, user_id, model, status, is_public, created_at, completed_at)
select
  ('c6b00000-0000-4000-8000-000000000' || right(fixture.id, 3))::uuid,
  fixture.id::uuid, 'content-guest-fixture', 'succeeded', false, now() - fixture.made, now() - fixture.made
from (values
  ('c6000000-0000-4000-8000-000000000201', interval '200 days'),
  ('c6000000-0000-4000-8000-000000000203', interval '120 days'),
  ('c6000000-0000-4000-8000-000000000204', interval '200 days'),
  ('c6000000-0000-4000-8000-000000000205', interval '200 days'),
  ('c6000000-0000-4000-8000-000000000206', interval '200 days'),
  ('c6000000-0000-4000-8000-000000000207', interval '200 days'),
  ('c6000000-0000-4000-8000-000000000209', interval '400 days'),
  ('c6000000-0000-4000-8000-000000000210', interval '200 days'),
  ('c6000000-0000-4000-8000-000000000211', interval '300 days'),
  ('c6000000-0000-4000-8000-000000000213', interval '10 days'),
  ('c6000000-0000-4000-8000-000000000214', interval '200 days'),
  ('c6000000-0000-4000-8000-000000000215', interval '200 days'),
  ('c6000000-0000-4000-8000-000000000216', interval '200 days'),
  ('c6000000-0000-4000-8000-000000000217', interval '200 days'),
  ('c6000000-0000-4000-8000-000000000218', interval '200 days')
) as fixture(id, made);

insert into public.media_upload_intents (id, user_id, storage_path, kind, created_at)
values (
  'c6b00000-0000-4000-8000-000000001202', 'c6000000-0000-4000-8000-000000000202',
  'c6000000-0000-4000-8000-000000000202/fixture.png', 'image', now() - interval '200 days'
);

insert into public.ai_usage_events (user_id, feature, provider, model, cost, status, created_at)
values (
  'c6000000-0000-4000-8000-000000000212', 'prompt_enhancement', 'kie', 'gemini-3-flash',
  0, 'succeeded', now() - interval '200 days'
);

insert into public.posts (
  id, user_id, visibility, category, source_kind, generation_id, title, showcase_asset_path
) values
  ('c6c00000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001',
   'public', 'image', 'external', null, 'Content guest fixture feed post',
   'showcase/c6c00000-0000-4000-8000-000000000001/fixture.webp'),
  ('c6c00000-0000-4000-8000-000000000204', 'c6000000-0000-4000-8000-000000000204',
   'public', 'image', 'external', null, 'Content guest fixture guest post',
   'showcase/c6c00000-0000-4000-8000-000000000204/fixture.webp');

update public.profiles set credits = 5
where id = 'c6000000-0000-4000-8000-000000000205';

insert into public.transactions (id, user_id, razorpay_order_id, amount, credits, status)
values (
  'c6d00000-0000-4000-8000-000000000206', 'c6000000-0000-4000-8000-000000000206',
  'order_content_guest_fixture', 49900, 500, 'created'
);

update public.profiles
set merged_into_user_id = 'c6000000-0000-4000-8000-000000000001',
    merged_at = timezone('utc'::text, now())
where id = 'c6000000-0000-4000-8000-000000000207';

insert into public.feed_events (
  client_event_id, viewer_user_id, post_id, creator_user_id, event_type, source_surface,
  occurred_at, received_at
) values (
  'content-guest-fixture-210', 'c6000000-0000-4000-8000-000000000210',
  'c6c00000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001',
  'impression', 'feed', now() - interval '10 days', now() - interval '10 days'
);

-- Moderation of the guest and its creations.
insert into public.moderation_reports (target_type, reported_user_id, reporter_user_id, reason, source_surface, created_at)
values (
  'user', 'c6000000-0000-4000-8000-000000000214', 'c6000000-0000-4000-8000-000000000001',
  'spam', 'creator-profile', now() - interval '200 days'
);
insert into public.moderation_reports (target_type, generation_id, reporter_user_id, reason, source_surface, created_at)
values (
  'generation', 'c6b00000-0000-4000-8000-000000000215', 'c6000000-0000-4000-8000-000000000001',
  'unsafe_content', 'generation-viewer', now() - interval '200 days'
);
update public.generations
set moderation_removed_at = now() - interval '199 days',
    moderation_removed_by = 'c6000000-0000-4000-8000-000000000001'
where id = 'c6b00000-0000-4000-8000-000000000216';
insert into public.admin_generation_moderation_actions (generation_id, reviewer_id, action, reason, idempotency_key, created_at)
values (
  'c6b00000-0000-4000-8000-000000000217', 'c6000000-0000-4000-8000-000000000001',
  'restore', 'Reviewed and restored', 'content-guest-fixture-217', now() - interval '199 days'
);
insert into public.post_reports (post_id, reporter_user_id, reason, created_at)
values (
  'c6c00000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000218',
  'spam', now() - interval '200 days'
);

-- ─── Who is listed ───────────────────────────────────────────────────────────

select is(
  (select array_agg(listed.user_id order by listed.user_id)
   from public.list_idle_guest_identities_with_content(p_limit => 100) as listed
   where listed.user_id::text like 'c6000000-%'),
  array[
    'c6000000-0000-4000-8000-000000000201',
    'c6000000-0000-4000-8000-000000000202',
    'c6000000-0000-4000-8000-000000000211',
    'c6000000-0000-4000-8000-000000000212'
  ]::uuid[],
  'only guests unused for 180 days that made or uploaded something, and hold nothing else, are listed'
);

select is(
  (select listed.user_id
   from public.list_idle_guest_identities_with_content(p_limit => 100) as listed
   where listed.user_id::text like 'c6000000-%'
   limit 1),
  'c6000000-0000-4000-8000-000000000211'::uuid,
  'the longest unused comes first'
);

select is(
  (select count(*)::integer from public.list_idle_guest_identities(p_limit => 500) as listed
   where listed.user_id = any(array[
     'c6000000-0000-4000-8000-000000000201',
     'c6000000-0000-4000-8000-000000000202',
     'c6000000-0000-4000-8000-000000000211',
     'c6000000-0000-4000-8000-000000000212'
   ]::uuid[])),
  0,
  'the two lists never name the same guest: the first still skips anyone with content'
);

select is(
  (select array_agg(listed.user_id)
   from public.list_idle_guest_identities_with_content(p_user_id => 'c6000000-0000-4000-8000-000000000201') as listed),
  array['c6000000-0000-4000-8000-000000000201']::uuid[],
  'a listed guest is listed again when asked about on its own'
);

select is(
  (select count(*)::integer from public.list_idle_guest_identities_with_content(p_limit => 1) as listed),
  1,
  'the list answers at most its limit'
);

-- ─── Each exclusion on its own ───────────────────────────────────────────────

create temporary table content_guest_exclusion (id uuid, reason text) on commit drop;
insert into content_guest_exclusion (id, reason) values
  ('c6000000-0000-4000-8000-000000000203', 'a guest with content used in the last 180 days is kept'),
  ('c6000000-0000-4000-8000-000000000204', 'a guest with a post is kept: others may have saved or remixed it'),
  ('c6000000-0000-4000-8000-000000000205', 'a guest holding credits is kept'),
  ('c6000000-0000-4000-8000-000000000206', 'a guest with a purchase on record is kept'),
  ('c6000000-0000-4000-8000-000000000207', 'a guest linked to an account is kept: the account owns its creations'),
  ('c6000000-0000-4000-8000-000000000208', 'a guest with nothing is the first list''s, not this one''s'),
  ('c6000000-0000-4000-8000-000000000209', 'an account is never listed'),
  ('c6000000-0000-4000-8000-000000000210', 'a guest whose feed was read 10 days ago is kept'),
  ('c6000000-0000-4000-8000-000000000213', 'a guest that made something 10 days ago is kept'),
  ('c6000000-0000-4000-8000-000000000214', 'a guest a report names is kept for an operator'),
  ('c6000000-0000-4000-8000-000000000215', 'a guest whose creation was reported is kept for an operator'),
  ('c6000000-0000-4000-8000-000000000216', 'a guest with a creation a moderator removed is kept for an operator'),
  ('c6000000-0000-4000-8000-000000000217', 'a guest with a moderation action on a creation is kept: deleting it would cascade the action away'),
  ('c6000000-0000-4000-8000-000000000218', 'a guest that filed a post report is kept, as the first list keeps a reporter');

select is(
  (select count(*)::integer
   from public.list_idle_guest_identities_with_content(p_user_id => exclusion.id)),
  0,
  exclusion.reason
)
from content_guest_exclusion as exclusion
order by exclusion.id;

-- A caller's clock cannot shorten the window.
select is(
  (select count(*)::integer
   from public.list_idle_guest_identities_with_content(
     p_now => now() + interval '400 days',
     p_user_id => 'c6000000-0000-4000-8000-000000000203')),
  0,
  'a clock ahead of the database''s cannot make a guest idle sooner'
);

-- ─── The pipeline's guard agrees ─────────────────────────────────────────────

select is(
  public.prepare_guest_account_deletion('c6000000-0000-4000-8000-000000000207') ->> 'status',
  'merged',
  'the deletion guard refuses a linked guest even if it were listed'
);
select is(
  public.prepare_guest_account_deletion('c6000000-0000-4000-8000-000000000201') ->> 'status',
  'prepared',
  'a listed guest goes down the account-deletion pipeline, which sweeps its files'
);
select is(
  (select count(*)::integer
   from public.list_idle_guest_identities_with_content(p_user_id => 'c6000000-0000-4000-8000-000000000201')),
  0,
  'a guest whose deletion is under way is not listed again'
);

select * from finish();
rollback;
