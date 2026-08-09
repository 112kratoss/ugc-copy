-- Finding B: the retention clamp must report itself. The clamp migration
-- promised "the applied value is returned so the clamp is visible" but its
-- summary never included it, so a clamped run was indistinguishable from a
-- clean one — and the incident-verification recipe had nothing to detect.
-- These tests pin the three reporting fields both ways.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(6);

-- Skewed call: facts (30) shorter than events (90) — the exact shape that
-- failed hourly during the 2026-08-09 incident. It must clamp up and say so.
select is(
  (public.prune_feed_personalization_data(
     timezone('utc', now()), 90, 2, 5000, 30
   ))->>'fact_retention_clamped',
  'true',
  'a skewed policy reports the clamp'
);

select is(
  (public.prune_feed_personalization_data(
     timezone('utc', now()), 90, 2, 5000, 30
   ))->>'fact_retention_days_applied',
  '90',
  'the applied window is the event window, clamped upward'
);

select is(
  (public.prune_feed_personalization_data(
     timezone('utc', now()), 90, 2, 5000, 30
   ))->>'fact_retention_days_requested',
  '30',
  'the requested window is echoed for the job record'
);

-- Aligned call: nothing to clamp, nothing to flag.
select is(
  (public.prune_feed_personalization_data(
     timezone('utc', now()), 30, 2, 5000, 400
   ))->>'fact_retention_clamped',
  'false',
  'an aligned policy reports no clamp'
);

select is(
  (public.prune_feed_personalization_data(
     timezone('utc', now()), 30, 2, 5000, 400
   ))->>'fact_retention_days_applied',
  '400',
  'the applied window equals the request when unclamped'
);

-- Genuinely invalid input still raises; the clamp only absorbs the ordering
-- disagreement between two individually legal values.
select throws_ok(
  $$select public.prune_feed_personalization_data(
      timezone('utc', now()), 90, 2, 5000, 0
    )$$,
  'P0001',
  'Feed fact retention days must be between 1 and 1460',
  'out-of-range input is still rejected'
);

select * from finish();

rollback;
