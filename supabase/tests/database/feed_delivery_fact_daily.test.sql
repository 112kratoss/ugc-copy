-- Behavioural coverage for F7b's daily rollup.
--
-- The rollup is what makes decision #2 safe: raw facts drop to 30 days only
-- because these aggregates carry the experiment lookback instead. So the
-- properties that matter are not "does it sum" but "can it be run again" --
-- the job runs hourly over a rolling window, and a rollup that accumulated
-- instead of replacing would inflate every metric a little more each hour,
-- which is the kind of wrong that looks plausible for months.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(9);

-- ─── Fixture ─────────────────────────────────────────────────────────────────

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values ('00000f7b-0000-4000-9000-000000000001'::uuid, 'f7b-rollup@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, review_status, body, created_at, updated_at)
values ('00000f7b-0000-4000-9000-000000000010'::uuid,
        '00000f7b-0000-4000-9000-000000000001'::uuid,
        'public', 'image', 'magicbooklet', 'text', 'visible', 'rollup fixture', now(), now());

-- Reuse whichever algorithm version the schema seeded; the rollup only groups
-- by it, so its identity does not matter, only that the FK resolves.
create temporary table f7b_ctx as
select id as algorithm_version_id from public.feed_algorithm_versions order by created_at limit 1;

insert into public.feed_sessions (id, algorithm_version_id)
select '00000f7b-0000-4000-9000-000000000020'::uuid, algorithm_version_id from f7b_ctx;

-- Two deliveries on the same day and grain, one served and opened.
-- delivery_id carries no default: the application mints it so a replayed
-- cursor page cannot double-write, so the fixture supplies it too.
insert into public.feed_delivery_facts (
  delivery_id, session_id, algorithm_version_id, post_id, position, candidate_source,
  final_score, surface, mode, ranked_at, served_at, opened_at, dwell_ms_max
)
select 9000000001, '00000f7b-0000-4000-9000-000000000020'::uuid, algorithm_version_id,
       '00000f7b-0000-4000-9000-000000000010'::uuid, 1, 'recent',
       0.5, 'feed', 'for-you', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 4000
from f7b_ctx
union all
-- dwell_ms_max is NOT NULL DEFAULT 0, so "no dwell observed" is 0 rather than
-- null. That is exactly why the rollup counts observations on `> 0`.
select 9000000002, '00000f7b-0000-4000-9000-000000000020'::uuid, algorithm_version_id,
       '00000f7b-0000-4000-9000-000000000010'::uuid, 2, 'recent',
       0.25, 'feed', 'for-you', now() - interval '1 day', null, null, 0
from f7b_ctx;

-- ─── Aggregation ─────────────────────────────────────────────────────────────

select lives_ok(
  $$ select public.refresh_feed_delivery_fact_daily(now(), 3, 400) $$,
  'the rollup runs'
);

select is(
  (select deliveries from public.feed_delivery_fact_daily where candidate_source = 'recent'),
  2::bigint,
  'both deliveries land in one bucket'
);

select is(
  (select served from public.feed_delivery_fact_daily where candidate_source = 'recent'),
  1::bigint,
  'served counts only the delivery that was actually served'
);

select is(
  (select dwell_ms_sum || ':' || dwell_ms_count from public.feed_delivery_fact_daily where candidate_source = 'recent'),
  '4000:1',
  'dwell is kept as sum plus count, so it can be re-aggregated across buckets'
);

-- ─── Idempotence: the property the hourly job depends on ─────────────────────

select public.refresh_feed_delivery_fact_daily(now(), 3, 400);
select public.refresh_feed_delivery_fact_daily(now(), 3, 400);

select is(
  (select count(*) from public.feed_delivery_fact_daily),
  1::bigint,
  're-running the rollup does not append duplicate buckets'
);

select is(
  (select deliveries from public.feed_delivery_fact_daily where candidate_source = 'recent'),
  2::bigint,
  're-running the rollup replaces counts rather than accumulating them'
);

-- ─── Late outcomes ───────────────────────────────────────────────────────────
--
-- Facts are mutated after insert as outcomes arrive, which is why the job
-- recomputes a trailing window instead of appending a finished day.

update public.feed_delivery_facts
set saved_at = now()
where position = 2;

select public.refresh_feed_delivery_fact_daily(now(), 3, 400);

select is(
  (select saves from public.feed_delivery_fact_daily where candidate_source = 'recent'),
  1::bigint,
  'an outcome stamped after the first rollup is picked up by the next one'
);

-- ─── Retention ───────────────────────────────────────────────────────────────

insert into public.feed_delivery_fact_daily (fact_date, candidate_source, surface, deliveries)
values (current_date - 500, 'ancient', 'feed', 1);

select public.refresh_feed_delivery_fact_daily(now(), 3, 400);

select is(
  (select count(*) from public.feed_delivery_fact_daily where candidate_source = 'ancient'),
  0::bigint,
  'buckets past the aggregate retention window are pruned'
);

select is(
  (select count(*) from public.feed_delivery_fact_daily where candidate_source = 'recent'),
  1::bigint,
  'pruning leaves buckets inside the window alone'
);

select * from finish();
rollback;
