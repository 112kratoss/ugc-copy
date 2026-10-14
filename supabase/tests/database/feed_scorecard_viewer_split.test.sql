-- The viewer scorecard's split by account
-- (20261014053528_feed_scorecard_viewer_split.sql).
--
-- feed_scorecard_viewers gains registered_viewers, anonymous_viewers (the
-- app's guests, auth.users.is_anonymous) and web_guest_viewers (no user id).
-- The three partition the viewers; signed_in_viewers and the 7-day creation
-- rate over it keep their meaning, app guests included. The function was
-- dropped and created again, so its surface and grants are checked as v4 left
-- them. The service role cannot read auth.users, so the anonymous flag comes
-- through a definer helper that only the service role may call. The scorecard
-- is called as service_role, the only role allowed to, so a grant the helper
-- path lacks fails here.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(14);

-- ─── Surface ─────────────────────────────────────────────────────────────────

select is(
  (select array_agg(arg.arg_name || ' ' || format_type(arg.arg_type, null) order by arg.arg_ordinal)
    from pg_proc as p
    cross join lateral unnest(p.proargnames, p.proargmodes, p.proallargtypes)
      with ordinality as arg(arg_name, arg_mode, arg_type, arg_ordinal)
    where p.oid = 'public.feed_scorecard_viewers(integer)'::regprocedure
      and arg.arg_mode = 't'),
  array[
    'algorithm_version_id uuid',
    'algorithm_label text',
    'experiment_variant_id uuid',
    'variant_key text',
    'viewers bigint',
    'sessions bigint',
    'sessions_per_viewer double precision',
    'd1_return_rate double precision',
    'd7_return_rate double precision',
    'meaningful_creation_7d_rate double precision',
    'rendered_per_viewer double precision',
    'meaningful_per_viewer double precision',
    'd1_eligible_viewers bigint',
    'd1_returned_viewers bigint',
    'd7_eligible_viewers bigint',
    'd7_returned_viewers bigint',
    'signed_in_viewers bigint',
    'meaningful_creators_7d bigint',
    'registered_viewers bigint',
    'anonymous_viewers bigint',
    'web_guest_viewers bigint'
  ],
  'the scorecard keeps every v4 column in place and appends the three split counts');
select ok((select not p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']
    from pg_proc as p where p.oid = 'public.feed_scorecard_viewers(integer)'::regprocedure),
  'the scorecard still runs as its caller with a pinned search path');
select ok(has_function_privilege('service_role', 'public.feed_scorecard_viewers(integer)', 'EXECUTE'),
  'the service role can call the scorecard again');
select ok(not has_function_privilege('public', 'public.feed_scorecard_viewers(integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.feed_scorecard_viewers(integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.feed_scorecard_viewers(integer)', 'EXECUTE'),
  'public, anonymous and signed-in clients still cannot call the scorecard');
select ok(obj_description('public.feed_scorecard_viewers(integer)'::regprocedure, 'pg_proc')
    like '%split into registered accounts, anonymous accounts%',
  'the re-created scorecard carries its comment, which names the split');
select ok((select p.prosecdef and p.proconfig @> array['search_path=""']
    from pg_proc as p where p.oid = 'public.feed_anonymous_viewer_ids(uuid[])'::regprocedure),
  'the anonymous-id helper runs as its owner with an empty search path');
select ok(has_function_privilege('service_role', 'public.feed_anonymous_viewer_ids(uuid[])', 'EXECUTE')
    and not has_function_privilege('public', 'public.feed_anonymous_viewer_ids(uuid[])', 'EXECUTE')
    and not has_function_privilege('anon', 'public.feed_anonymous_viewer_ids(uuid[])', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.feed_anonymous_viewer_ids(uuid[])', 'EXECUTE'),
  'only the service role can call the anonymous-id helper');

-- ─── Fixture ─────────────────────────────────────────────────────────────────
-- Under a version of its own: a registered account R served yesterday and
-- today, an app guest A (an anonymous account) served today, and a web guest
-- served today. R made something an hour ago. X is an id with no account.

insert into public.feed_algorithm_versions (algorithm_key, version, status)
values ('viewer-split-pgtap', 1, 'shadow');

insert into auth.users (id, email, aud, role, is_anonymous, created_at)
values
  ('d1500000-0000-4000-8000-000000000001', 'viewer-split-registered@example.invalid',
    'authenticated', 'authenticated', false, now() - interval '30 days'),
  ('d1500000-0000-4000-8000-000000000002', null,
    'authenticated', 'authenticated', true, now() - interval '3 days');

create temporary table split_fixture as
select
  (select id from public.feed_algorithm_versions
    where algorithm_key = 'viewer-split-pgtap' and version = 1) as version_id,
  'd1500000-0000-4000-8000-000000000001'::uuid as registered_id,
  'd1500000-0000-4000-8000-000000000002'::uuid as anonymous_id,
  'd1500000-0000-4000-8000-000000000009'::uuid as unknown_id,
  (now() at time zone 'utc')::date as today;
grant select on split_fixture to service_role;

insert into public.feed_viewer_daily (
  fact_date, viewer_key, viewer_user_id, algorithm_version_id, sessions, served, rendered,
  first_served_at, last_served_at
)
select viewer_day.fact_date, viewer_day.viewer_key, viewer_day.viewer_user_id, split_fixture.version_id, 1, 1, 1,
  viewer_day.served_at, viewer_day.served_at
from split_fixture
cross join lateral (values
  (split_fixture.today - 1, split_fixture.registered_id::text, split_fixture.registered_id,
    now() - interval '1 day'),
  (split_fixture.today, split_fixture.registered_id::text, split_fixture.registered_id,
    now() - interval '2 hours'),
  (split_fixture.today, split_fixture.anonymous_id::text, split_fixture.anonymous_id,
    now() - interval '2 hours'),
  (split_fixture.today, 'anon:' || repeat('e', 64), null::uuid,
    now() - interval '2 hours')
) as viewer_day(fact_date, viewer_key, viewer_user_id, served_at);

insert into public.generations (user_id, status, category, prompt, created_at, completed_at)
select registered_id, 'succeeded', 'image', 'viewer split fixture',
  now() - interval '1 hour', now() - interval '30 minutes'
from split_fixture;

-- ─── As the service role ─────────────────────────────────────────────────────

set local role service_role;
select is((select viewers || '/' || sessions || '/' || signed_in_viewers || '/' || meaningful_creators_7d
      || '/' || meaningful_creation_7d_rate
    from public.feed_scorecard_viewers(7)
    where algorithm_version_id = (select version_id from split_fixture)),
  '3/4/2/1/0.5',
  'viewers count each viewer once, and signed in still counts the app guest, in the creation rate''s denominator too');
select is((select registered_viewers || '/' || anonymous_viewers || '/' || web_guest_viewers
    from public.feed_scorecard_viewers(7)
    where algorithm_version_id = (select version_id from split_fixture)),
  '1/1/1',
  'the split names one registered account, one app guest and one web guest');
select ok((select bool_and(registered_viewers + anonymous_viewers = signed_in_viewers
      and signed_in_viewers + web_guest_viewers = viewers)
    from public.feed_scorecard_viewers(90)),
  'on every row registered + anonymous = signed in, and signed in + web guests = viewers');
select is((select array_agg(user_id order by user_id)
    from public.feed_anonymous_viewer_ids(array[
      (select registered_id from split_fixture),
      (select anonymous_id from split_fixture),
      (select unknown_id from split_fixture)
    ])),
  array['d1500000-0000-4000-8000-000000000002'::uuid],
  'the helper answers only which of the ids it is given are anonymous');
select is((select count(*)::integer from public.feed_anonymous_viewer_ids(null)),
  0, 'no ids, no rows');
reset role;

-- ─── Client roles ────────────────────────────────────────────────────────────

set local role anon;
select throws_ok($$select * from public.feed_anonymous_viewer_ids(array['d1500000-0000-4000-8000-000000000002'::uuid])$$,
  '42501', null, 'an anonymous client cannot ask which accounts are guests');
reset role;
set local role authenticated;
select throws_ok($$select * from public.feed_anonymous_viewer_ids(array['d1500000-0000-4000-8000-000000000002'::uuid])$$,
  '42501', null, 'a signed-in client cannot ask which accounts are guests');
reset role;

select * from finish();
rollback;
