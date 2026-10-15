-- Guest data (D5): which idle guests the retention job may delete, and the
-- guard a guest's own deletion passes through.
--
-- Every exclusion of the idle-guest contract is pinned by an identity that is
-- idle and empty but for that one thing, asked about on its own (p_user_id),
-- next to an identity that has nothing at all and is listed.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- ─── Privilege boundaries ────────────────────────────────────────────────────

select ok(
  (select prosecdef from pg_catalog.pg_proc
   where oid = 'public.list_idle_guest_identities(timestamptz, integer, uuid)'::regprocedure),
  'the candidate list runs with its owner''s privileges'
);
select ok(
  (select proconfig @> array['search_path=""']
   from pg_catalog.pg_proc
   where oid = 'public.list_idle_guest_identities(timestamptz, integer, uuid)'::regprocedure),
  'the candidate list has a fixed search path'
);
select is(
  pg_catalog.has_function_privilege('anon', 'public.list_idle_guest_identities(timestamptz, integer, uuid)', 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated', 'public.list_idle_guest_identities(timestamptz, integer, uuid)', 'EXECUTE'),
  false,
  'no client can list guest identities'
);
select ok(
  pg_catalog.has_function_privilege('service_role', 'public.list_idle_guest_identities(timestamptz, integer, uuid)', 'EXECUTE'),
  'the retention job can list them'
);

select ok(
  (select prosecdef and proconfig @> array['search_path=""']
   from pg_catalog.pg_proc
   where oid = 'public.prepare_guest_account_deletion(uuid)'::regprocedure),
  'the guest deletion guard runs with its owner''s privileges and a fixed search path'
);
select is(
  pg_catalog.has_function_privilege('anon', 'public.prepare_guest_account_deletion(uuid)', 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated', 'public.prepare_guest_account_deletion(uuid)', 'EXECUTE'),
  false,
  'no client can start a guest deletion directly'
);
select ok(
  pg_catalog.has_function_privilege('service_role', 'public.prepare_guest_account_deletion(uuid)', 'EXECUTE'),
  'the account route can'
);

-- ─── Fixtures ────────────────────────────────────────────────────────────────
--
--   ...0001  a registered account, idle for 300 days (it also owns the post
--            the feed fixtures point at)
--   ...0101  an idle guest with nothing (300 days)            listed
--   ...0102  an idle guest with only maintenance-written state listed
--   ...0103  created 10 days ago
--   ...0104  signed in 10 days ago
--   ...0105  a session refreshed last week
--   ...0106  an old session (refreshed 120 days ago)          listed
--   ...0107  credits
--   ...0108  promotional credits
--   ...0109  a purchase (transactions)
--   ...0110  a purchase in progress (mobile_purchase_intents)
--   ...0111  a generation
--   ...0112  a post
--   ...0113  an upload (media_upload_intents)
--   ...0114  an upload reservation
--   ...0115  linked to the account (merged)
--   ...0116  a guest another guest (...0117) was linked to
--   ...0118  the target of an account_merges row (guest ...0119)
--   ...0120  a pending merge ticket
--   ...0121  an idle guest with nothing (200 days)             listed, then deleted
--   ...0122  a session updated last week (never "refreshed")
--   ...0123  a feed event last week, and no other use
--   ...0124  a Hide last week, and no other use
--   ...0125  an onboarding event last week, and no other use
--   ...0126  a refresh token issued last week on an old session
--   ...0127  a feed event 200 days ago (280 days old)          listed

insert into auth.users (
  id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, last_sign_in_at
)
select
  fixture.id::uuid,
  fixture.email,
  'authenticated',
  'authenticated',
  fixture.email is null,
  '{}'::jsonb,
  '{}'::jsonb,
  now() - fixture.created_ago,
  now() - fixture.created_ago,
  now() - fixture.signed_in_ago
from (values
  ('d5000000-0000-4000-8000-000000000001', 'idle-account@example.invalid', interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000101', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000102', null, interval '250 days', interval '250 days'),
  ('d5000000-0000-4000-8000-000000000103', null, interval '10 days', interval '10 days'),
  ('d5000000-0000-4000-8000-000000000104', null, interval '300 days', interval '10 days'),
  ('d5000000-0000-4000-8000-000000000105', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000106', null, interval '400 days', interval '400 days'),
  ('d5000000-0000-4000-8000-000000000107', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000108', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000109', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000110', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000111', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000112', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000113', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000114', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000115', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000116', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000117', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000118', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000119', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000120', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000121', null, interval '200 days', interval '200 days'),
  ('d5000000-0000-4000-8000-000000000122', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000123', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000124', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000125', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000126', null, interval '300 days', interval '300 days'),
  ('d5000000-0000-4000-8000-000000000127', null, interval '280 days', interval '280 days')
) as fixture(id, email, created_ago, signed_in_ago);

-- State the feed's own maintenance writes is not use: it must not keep a guest.
insert into public.user_interest_refresh_state (user_id, refreshed_at)
values ('d5000000-0000-4000-8000-000000000102', now() - interval '1 day');

-- Sessions. Auth keeps refreshed_at without a time zone, in UTC.
insert into auth.sessions (id, user_id, created_at, updated_at, refreshed_at)
values
  ('d5a00000-0000-4000-8000-000000000105', 'd5000000-0000-4000-8000-000000000105',
   now() - interval '300 days', now() - interval '300 days',
   (now() - interval '7 days') at time zone 'UTC'),
  ('d5a00000-0000-4000-8000-000000000106', 'd5000000-0000-4000-8000-000000000106',
   now() - interval '400 days', now() - interval '400 days',
   (now() - interval '120 days') at time zone 'UTC'),
  ('d5a00000-0000-4000-8000-000000000122', 'd5000000-0000-4000-8000-000000000122',
   now() - interval '300 days', now() - interval '7 days', null),
  ('d5a00000-0000-4000-8000-000000000126', 'd5000000-0000-4000-8000-000000000126',
   now() - interval '300 days', now() - interval '300 days', null);

-- A refresh recorded only as the token it issued.
insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
values (
  '00000000-0000-0000-0000-000000000000', 'idle-guest-fixture-refresh-126',
  'd5000000-0000-4000-8000-000000000126', false,
  now() - interval '7 days', now() - interval '7 days',
  'd5a00000-0000-4000-8000-000000000126'
);

-- Browsing as a guest: a feed event on a post, a Hide of its creator, and an
-- onboarding event, each last week and each the guest's only use; and a feed
-- event long ago, which keeps no one.
insert into public.posts (
  id, user_id, visibility, category, source_kind, generation_id, title, showcase_asset_path
) values (
  'd5b00000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001',
  'public', 'image', 'external', null, 'Idle guest fixture feed post',
  'showcase/d5b00000-0000-4000-8000-000000000001/fixture.webp'
);

insert into public.feed_events (
  client_event_id, viewer_user_id, post_id, creator_user_id, event_type, source_surface,
  occurred_at, received_at
) values
  ('idle-guest-fixture-123', 'd5000000-0000-4000-8000-000000000123',
   'd5b00000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001',
   'impression', 'feed', now() - interval '7 days', now() - interval '7 days'),
  ('idle-guest-fixture-127', 'd5000000-0000-4000-8000-000000000127',
   'd5b00000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001',
   'impression', 'feed', now() - interval '200 days', now() - interval '200 days');

insert into public.feed_user_creator_feedback (user_id, creator_user_id, first_recorded_at, updated_at)
values (
  'd5000000-0000-4000-8000-000000000124', 'd5000000-0000-4000-8000-000000000001',
  now() - interval '7 days', now() - interval '7 days'
);

insert into public.onboarding_events (
  client_event_id, installation_id, user_id, flow_version, platform, event_name, occurred_at, created_at
) values (
  'd5b00000-0000-4000-8000-000000000125', 'fid_' || repeat('d5', 32),
  'd5000000-0000-4000-8000-000000000125', 1, 'android', 'started',
  now() - interval '7 days', now() - interval '7 days'
);

update public.profiles set credits = 5
where id = 'd5000000-0000-4000-8000-000000000107';
update public.profiles set promotional_credits = 3
where id = 'd5000000-0000-4000-8000-000000000108';

insert into public.transactions (id, user_id, razorpay_order_id, amount, credits, status)
values (
  'd5b00000-0000-4000-8000-000000000109', 'd5000000-0000-4000-8000-000000000109',
  'order_idle_guest_fixture', 49900, 500, 'created'
);

insert into public.mobile_purchase_intents
  (id, user_id, product_id, entitlement_type, amount_subunits, currency, credits, status, expires_at)
values (
  'd5b00000-0000-4000-8000-000000000110', 'd5000000-0000-4000-8000-000000000110',
  'com.magicbooklet.credits.pro', 'credits', 49900, 'INR', 500, 'pending', now() + interval '1 day'
);

insert into public.generations (id, user_id, model, status, is_public)
values (
  'd5b00000-0000-4000-8000-000000000111', 'd5000000-0000-4000-8000-000000000111',
  'idle-guest-fixture', 'succeeded', false
);

insert into public.posts (
  id, user_id, visibility, category, source_kind, generation_id, title, showcase_asset_path
) values (
  'd5b00000-0000-4000-8000-000000000112', 'd5000000-0000-4000-8000-000000000112',
  'public', 'image', 'external', null, 'Idle guest fixture post',
  'showcase/d5b00000-0000-4000-8000-000000000112/fixture.webp'
);

insert into public.media_upload_intents (id, user_id, storage_path, kind, created_at)
values (
  'd5b00000-0000-4000-8000-000000000113', 'd5000000-0000-4000-8000-000000000113',
  'd5000000-0000-4000-8000-000000000113/fixture.png', 'image', now() - interval '300 days'
);

select is(
  public.reserve_upload_bytes_v2(
    'd5b00000-0000-4000-8000-000000000114',
    'd5000000-0000-4000-8000-000000000114',
    'uploads', 'd5000000-0000-4000-8000-000000000114/fixture.png',
    1, 262144000, 'image/png', 1073741824, 107374182400, 7200
  ) ->> 'reason',
  'reserved',
  'fixture: the upload-reservation guest holds a reservation'
);

update public.profiles
set merged_into_user_id = 'd5000000-0000-4000-8000-000000000001',
    merged_at = timezone('utc'::text, now())
where id = 'd5000000-0000-4000-8000-000000000115';

update public.profiles
set merged_into_user_id = 'd5000000-0000-4000-8000-000000000116',
    merged_at = timezone('utc'::text, now())
where id = 'd5000000-0000-4000-8000-000000000117';

insert into public.account_merges (
  guest_user_id, target_user_id, credits_moved, promotional_credits_moved, source_surface
) values (
  'd5000000-0000-4000-8000-000000000119', 'd5000000-0000-4000-8000-000000000118', 0, 0, 'mobile'
);

insert into public.account_merge_tickets (ticket_hash, guest_user_id, expires_at)
values (
  repeat('d5', 32), 'd5000000-0000-4000-8000-000000000120', now() + interval '30 days'
);

-- ─── Who is listed ───────────────────────────────────────────────────────────

select is(
  (select array_agg(listed.user_id order by listed.user_id)
   from public.list_idle_guest_identities(p_limit => 500) as listed
   where listed.user_id::text like 'd5000000-%'),
  array[
    'd5000000-0000-4000-8000-000000000101',
    'd5000000-0000-4000-8000-000000000102',
    'd5000000-0000-4000-8000-000000000106',
    'd5000000-0000-4000-8000-000000000121',
    'd5000000-0000-4000-8000-000000000127'
  ]::uuid[],
  'only guests unused for 90 days that hold and made nothing are listed'
);

select is(
  (select array_agg(listed.user_id order by listed.position)
   from (
     select candidate.user_id, row_number() over () as position
     from public.list_idle_guest_identities(p_limit => 500) as candidate
   ) as listed
   where listed.user_id::text like 'd5000000-%'),
  array[
    'd5000000-0000-4000-8000-000000000101',
    'd5000000-0000-4000-8000-000000000127',
    'd5000000-0000-4000-8000-000000000102',
    'd5000000-0000-4000-8000-000000000121',
    'd5000000-0000-4000-8000-000000000106'
  ]::uuid[],
  'the longest unused come first, by last use rather than by creation'
);

select is(
  (select last_active_at from public.list_idle_guest_identities(
     p_user_id => 'd5000000-0000-4000-8000-000000000106')),
  (select (refreshed_at at time zone 'UTC') from auth.sessions
   where id = 'd5a00000-0000-4000-8000-000000000106'),
  'a guest''s last use is its last session refresh'
);

-- ─── Each exclusion on its own ───────────────────────────────────────────────

create temporary table idle_guest_exclusion (id uuid, reason text) on commit drop;
insert into idle_guest_exclusion (id, reason) values
  ('d5000000-0000-4000-8000-000000000001', 'an account (not anonymous) is never a candidate'),
  ('d5000000-0000-4000-8000-000000000103', 'a guest created in the last 90 days is kept'),
  ('d5000000-0000-4000-8000-000000000104', 'a guest that signed in in the last 90 days is kept'),
  ('d5000000-0000-4000-8000-000000000105', 'a guest that refreshed its session last week is kept'),
  ('d5000000-0000-4000-8000-000000000122', 'a guest whose session was updated last week is kept'),
  ('d5000000-0000-4000-8000-000000000126', 'a guest whose session issued a refresh token last week is kept'),
  ('d5000000-0000-4000-8000-000000000123', 'a guest whose only activity is a feed event last week is kept'),
  ('d5000000-0000-4000-8000-000000000124', 'a guest whose only activity is a Hide last week is kept'),
  ('d5000000-0000-4000-8000-000000000125', 'a guest whose only activity is an onboarding event last week is kept'),
  ('d5000000-0000-4000-8000-000000000107', 'a guest holding credits is kept'),
  ('d5000000-0000-4000-8000-000000000108', 'a guest holding promotional credits is kept'),
  ('d5000000-0000-4000-8000-000000000109', 'a guest with a purchase on record is kept'),
  ('d5000000-0000-4000-8000-000000000110', 'a guest with a purchase in progress is kept'),
  ('d5000000-0000-4000-8000-000000000111', 'a guest with a generation is kept'),
  ('d5000000-0000-4000-8000-000000000112', 'a guest with a post is kept'),
  ('d5000000-0000-4000-8000-000000000113', 'a guest with an upload is kept'),
  ('d5000000-0000-4000-8000-000000000114', 'a guest with an upload reservation is kept'),
  ('d5000000-0000-4000-8000-000000000115', 'a guest linked to an account is kept'),
  ('d5000000-0000-4000-8000-000000000117', 'a guest linked to another identity is kept'),
  ('d5000000-0000-4000-8000-000000000116', 'a guest another identity is linked to is kept'),
  ('d5000000-0000-4000-8000-000000000118', 'a guest named as a merge target is kept'),
  ('d5000000-0000-4000-8000-000000000119', 'a guest named as a merged guest is kept'),
  ('d5000000-0000-4000-8000-000000000120', 'a guest with a pending merge ticket is kept');

select is(
  (select count(*) from public.list_idle_guest_identities(p_user_id => exclusion.id)),
  0::bigint,
  exclusion.reason
)
from idle_guest_exclusion as exclusion
order by exclusion.id;

select is(
  (select count(*) from public.list_idle_guest_identities(
     p_user_id => 'd5000000-0000-4000-8000-000000000101')),
  1::bigint,
  'the re-check of one identity finds a candidate'
);

select is(
  (select count(*) from public.list_idle_guest_identities(
     p_now => now() + interval '1000 days',
     p_user_id => 'd5000000-0000-4000-8000-000000000103')),
  0::bigint,
  'a caller''s clock cannot make a guest idle sooner than the database''s'
);

-- ─── A guest's own deletion ──────────────────────────────────────────────────

select is(
  public.prepare_guest_account_deletion('d5000000-0000-4000-8000-000000000115') ->> 'status',
  'merged',
  'a guest linked to an account cannot delete itself'
);
select is(
  (select identity_state from public.profiles
   where id = 'd5000000-0000-4000-8000-000000000115'),
  'merged',
  'the refused guest stays linked'
);
select ok(
  not exists (select 1 from public.account_deletion_jobs
              where user_id = 'd5000000-0000-4000-8000-000000000115'),
  'nothing was started for the refused guest'
);
select is(
  public.prepare_guest_account_deletion('d5000000-0000-4000-8000-000000000116') ->> 'status',
  'merged',
  'a guest another identity is linked to cannot delete itself'
);
select is(
  public.prepare_guest_account_deletion('d5000000-0000-4000-8000-000000000118') ->> 'status',
  'merged',
  'a guest named as a merge target cannot delete itself'
);
select is(
  public.prepare_guest_account_deletion('d5000000-0000-4000-8000-000000000001') ->> 'status',
  'not_a_guest',
  'an account is never deleted down the guest path'
);
select ok(
  not exists (select 1 from public.account_deletion_jobs
              where user_id = 'd5000000-0000-4000-8000-000000000001')
  and (select identity_state from public.profiles
       where id = 'd5000000-0000-4000-8000-000000000001') = 'active',
  'nothing was started for the account'
);
select is(
  public.prepare_guest_account_deletion(null) ->> 'status',
  'invalid_request',
  'a missing identity is refused'
);
select is(
  public.prepare_guest_account_deletion('d5000000-0000-4000-8000-00000000ffff') ->> 'status',
  'not_found',
  'an unknown identity is refused'
);

select is(
  public.prepare_guest_account_deletion('d5000000-0000-4000-8000-000000000121') ->> 'status',
  'prepared',
  'an unlinked guest is prepared for deletion like an account'
);
select is(
  (select identity_state from public.profiles
   where id = 'd5000000-0000-4000-8000-000000000121'),
  'deleting',
  'the guest is locked as deleting'
);
select is(
  (select storage_manifest -> 'owner_user_ids' from public.account_deletion_jobs
   where user_id = 'd5000000-0000-4000-8000-000000000121'),
  '["d5000000-0000-4000-8000-000000000121"]'::jsonb,
  'the job sweeps the guest''s own files and no one else''s'
);
select is(
  public.prepare_guest_account_deletion('d5000000-0000-4000-8000-000000000121') ->> 'status',
  'prepared',
  'a retried guest deletion goes on from its job'
);
select is(
  (select attempt_count from public.account_deletion_jobs
   where user_id = 'd5000000-0000-4000-8000-000000000121'),
  2,
  'the retry is recorded as a second attempt of the same job'
);
select is(
  (select count(*) from public.list_idle_guest_identities(
     p_user_id => 'd5000000-0000-4000-8000-000000000121')),
  0::bigint,
  'a guest being deleted is not also a retention candidate'
);

-- ─── Bounded ─────────────────────────────────────────────────────────────────

select is(
  (select count(*) from public.list_idle_guest_identities(p_limit => 1)),
  1::bigint,
  'a call lists no more than its limit'
);
select is(
  (select count(*) from public.list_idle_guest_identities(p_limit => 0)),
  1::bigint,
  'a limit below one still lists one'
);

-- More idle, empty guests than any one call may list.
insert into auth.users (
  id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, last_sign_in_at
)
select
  gen_random_uuid(), null, 'authenticated', 'authenticated', true, '{}'::jsonb, '{}'::jsonb,
  now() - interval '500 days', now() - interval '500 days', now() - interval '500 days'
from generate_series(1, 510);

select is(
  (select count(*) from public.list_idle_guest_identities(p_limit => 100000)),
  500::bigint,
  'no call lists more than 500'
);
select is(
  (select count(*) from public.list_idle_guest_identities()),
  100::bigint,
  'a call without a limit lists 100'
);

select * from finish();
rollback;
