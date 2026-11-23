-- showcase_feed_read_ahead_counters (20261123151805): Explore's read-ahead
-- counts, one row per event per UTC hour, kept and read by the service role only.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(11);

select ok(not has_table_privilege('anon', 'public.showcase_feed_read_ahead_counters', 'SELECT'),
  'anon cannot read the counts');
select ok(not has_table_privilege('authenticated', 'public.showcase_feed_read_ahead_counters', 'SELECT'),
  'authenticated cannot read the counts');
select ok(not has_table_privilege('authenticated', 'public.showcase_feed_read_ahead_counters', 'INSERT'),
  'authenticated cannot write a count');
select ok(not has_function_privilege('anon', 'public.record_showcase_feed_read_ahead_event(text)', 'EXECUTE'),
  'anon cannot count');
select ok(not has_function_privilege('authenticated', 'public.record_showcase_feed_read_ahead_event(text)', 'EXECUTE'),
  'authenticated cannot count');
select ok(has_function_privilege('service_role', 'public.record_showcase_feed_read_ahead_event(text)', 'EXECUTE'),
  'the service role counts');

set local role service_role;

select lives_ok(
  $$select public.record_showcase_feed_read_ahead_event('hold')$$,
  'the service role records a hold'
);
select lives_ok(
  $$select public.record_showcase_feed_read_ahead_event('hold'); select public.record_showcase_feed_read_ahead_event('claim')$$,
  'and a second hold and a claim'
);

select is(
  (select event_count
   from public.showcase_feed_read_ahead_counters
   where event = 'hold' and bucket_start = date_trunc('hour', now(), 'UTC')),
  2::bigint,
  'two holds in one hour are one row counting two, on the UTC hour'
);

select is(
  (select array_agg(event order by event)
   from public.showcase_feed_read_ahead_counters
   where bucket_start = date_trunc('hour', now(), 'UTC')),
  array['claim', 'hold'],
  'one row per event in the hour'
);

select throws_ok(
  $$select public.record_showcase_feed_read_ahead_event('opened')$$,
  '23514',
  null,
  'an event outside the three is refused'
);

reset role;

select * from finish();
rollback;
