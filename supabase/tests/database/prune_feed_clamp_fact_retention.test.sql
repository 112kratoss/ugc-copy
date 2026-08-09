-- Regression coverage for the retention clamp.
--
-- The combination below -- events 90, facts 30 -- raised in production and
-- aborted the entire hourly feed-maintenance job, stats refreshes included,
-- because maintainFeedPersonalization throws on the first failing RPC. It then
-- deadlocked the release pipeline, since the resulting degraded health made the
-- production gate refuse to promote the fix.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(4);

select lives_ok(
  $$ select public.prune_feed_personalization_data(now(), 90, 2, 5000, 30) $$,
  'fact retention shorter than event retention no longer raises'
);

select is(
  (public.prune_feed_personalization_data(now(), 90, 2, 5000, 30) ->> 'skipped')::boolean,
  false,
  'the prune actually runs rather than short-circuiting'
);

-- Genuinely invalid input must still fail loudly. The clamp is for a policy
-- disagreement between two legal values, not a licence to accept nonsense.
select throws_ok(
  $$ select public.prune_feed_personalization_data(now(), 90, 2, 5000, 0) $$,
  'Feed fact retention days must be between 1 and 1460',
  'a fact retention of zero still raises'
);

select throws_ok(
  $$ select public.prune_feed_personalization_data(now(), 90, 2, 5000, 2000) $$,
  'Feed fact retention days must be between 1 and 1460',
  'a fact retention past the ceiling still raises'
);

select * from finish();
rollback;
