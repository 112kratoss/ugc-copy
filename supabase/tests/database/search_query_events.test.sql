-- The anonymous search log (public.search_query_events) and its report: backend-owned and
-- append-only for the service role, bounded by its checks, swept by the operational retention
-- job after 90 days, counted by the growth accounting, and read through search_query_report,
-- which collapses typing steps ("po" → "por" → "port") into the search they led to.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- ─── Shape and privileges ────────────────────────────────────────────────────

select has_table('public', 'search_query_events', 'the search log exists');
select columns_are(
  'public', 'search_query_events',
  array['id', 'created_at', 'query', 'search_type', 'signed_in', 'visitor_day',
        'creator_count', 'post_count', 'recipe_count'],
  'a row holds the normalized query, the search type, whether a session was presented, the hashed visitor-day and three counts: nothing else about the person'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.search_query_events'::regclass),
  'row level security is on'
);
select is(
  (select count(*)::integer from pg_policy where polrelid = 'public.search_query_events'::regclass),
  0,
  'no policy: the Data API roles see nothing'
);
select has_index('public', 'search_query_events', 'search_query_events_created_at_idx',
  'the report window and the retention sweep read by created_at');

select ok(not has_table_privilege('anon', 'public.search_query_events', 'SELECT'), 'anon cannot read the log');
select ok(not has_table_privilege('anon', 'public.search_query_events', 'INSERT'), 'anon cannot write the log');
select ok(not has_table_privilege('authenticated', 'public.search_query_events', 'SELECT'), 'authenticated cannot read the log');
select ok(not has_table_privilege('authenticated', 'public.search_query_events', 'INSERT'), 'authenticated cannot write the log');
select ok(has_table_privilege('service_role', 'public.search_query_events', 'SELECT'), 'the service role reads the log');
select ok(has_table_privilege('service_role', 'public.search_query_events', 'INSERT'), 'the service role appends to the log');
select ok(not has_table_privilege('service_role', 'public.search_query_events', 'UPDATE'), 'append-only: no update for the service role');
select ok(not has_table_privilege('service_role', 'public.search_query_events', 'DELETE'), 'append-only: the service role never deletes (the sweep runs as its owner)');
select ok(not has_table_privilege('service_role', 'public.search_query_events', 'TRUNCATE'), 'append-only: no truncate for the service role');

-- ─── Checks ──────────────────────────────────────────────────────────────────

select lives_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count)
     values ('port', 'top', false, repeat('a', 64), 0, 2, 1) $$,
  'a well-formed row inserts, created_at defaulting to now()'
);
select throws_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count)
     values ('port', 'everything', false, repeat('a', 64), 0, 0, 0) $$,
  '23514', null, 'a search type outside top, creators, posts, recipes is refused'
);
select throws_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count)
     values ('', 'top', false, repeat('a', 64), 0, 0, 0) $$,
  '23514', null, 'an empty query is refused'
);
select throws_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count)
     values (repeat('x', 101), 'top', false, repeat('a', 64), 0, 0, 0) $$,
  '23514', null, 'a query of more than 100 characters is refused'
);
select lives_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count)
     values (repeat('x', 100), 'top', false, repeat('b', 64), 0, 0, 0) $$,
  'a query of exactly 100 characters is kept'
);
select throws_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count)
     values ('port', 'top', false, repeat('a', 64), -1, 0, 0) $$,
  '23514', null, 'a negative count is refused'
);
select throws_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count)
     values ('port', 'top', false, 'a-user-id-or-an-ip-address', 0, 0, 0) $$,
  '23514', null, 'a visitor-day that is not a 64-character hash is refused, so a raw key or id cannot be stored'
);

-- ─── The day keys ────────────────────────────────────────────────────────────

select has_table('public', 'search_visitor_day_keys', 'the day-key table exists');
select columns_are('public', 'search_visitor_day_keys', array['day', 'key', 'created_at'], 'a day and its key');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.search_visitor_day_keys'::regclass)
  and not has_table_privilege('anon', 'public.search_visitor_day_keys', 'SELECT')
  and not has_table_privilege('authenticated', 'public.search_visitor_day_keys', 'SELECT')
  and has_table_privilege('service_role', 'public.search_visitor_day_keys', 'SELECT')
  and has_table_privilege('service_role', 'public.search_visitor_day_keys', 'INSERT')
  and not has_table_privilege('service_role', 'public.search_visitor_day_keys', 'UPDATE')
  and not has_table_privilege('service_role', 'public.search_visitor_day_keys', 'DELETE'),
  'RLS on; only the service role reads or appends; nobody updates or deletes but the sweep'
);
select ok(
  not has_function_privilege('anon', 'public.search_visitor_day_key(date)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_visitor_day_key(date)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.search_visitor_day_key(date)', 'EXECUTE'),
  'only the service role asks for a day key'
);
select matches(
  public.search_visitor_day_key(date '2026-11-12'),
  '^[0-9a-f]{64}$',
  'the first call makes a 64-hex key'
);
select is(
  public.search_visitor_day_key(date '2026-11-12'),
  (select key from public.search_visitor_day_keys where day = date '2026-11-12'),
  'a second call returns the same key, so concurrent instances agree'
);
select isnt(
  public.search_visitor_day_key(date '2026-11-13'),
  public.search_visitor_day_key(date '2026-11-12'),
  'another day, another key'
);
delete from public.search_visitor_day_keys;
insert into public.search_visitor_day_keys (day, key)
values
  ((now() at time zone 'utc')::date - 3, repeat('a', 64)),
  ((now() at time zone 'utc')::date - 2, repeat('b', 64)),
  ((now() at time zone 'utc')::date,     repeat('c', 64));
select is(
  (public.prune_operational_backend_data() ->> 'search_visitor_day_keys_deleted')::integer,
  2,
  'the sweep deletes a key whose day started more than 48 hours ago, and reports it'
);
select is(
  (select array_agg(key order by key) from public.search_visitor_day_keys),
  array[repeat('c', 64)],
  'today''s key stays'
);

-- ─── Retention and growth accounting ─────────────────────────────────────────

delete from public.search_query_events;
insert into public.search_query_events (created_at, query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count)
values
  (now() - interval '91 days', 'old query', 'top', false, repeat('c', 64), 0, 0, 0),
  (now() - interval '89 days', 'recent query', 'top', true, repeat('d', 64), 1, 0, 0);

select is(
  (public.prune_operational_backend_data() ->> 'search_query_events_deleted')::integer,
  1,
  'the operational sweep deletes rows older than 90 days and reports them'
);
select is(
  (select array_agg(query order by query) from public.search_query_events),
  array['recent query'],
  'a row inside the window stays'
);
select ok(
  exists (select 1 from public.get_operational_table_growth() where table_name = 'search_query_events'),
  'the growth accounting watches the log'
);

-- ─── The report ──────────────────────────────────────────────────────────────

delete from public.search_query_events;

-- Visitor-day 1 types po → por → port a second or two apart and gets nothing: one search, "port".
-- Visitor-day 2 and 3 type port; 2 finds posts, 3 finds nothing.
-- Visitor-day 4 types "cat" then, unrelated, "dog": two searches.
-- Visitor-day 5 types "ab" then "abc" 20 seconds later: past the 15 seconds, both are final.
-- Visitor-day 6 asks "dress" on Top (4 posts) and 3 seconds later on Creators (none): a tab switch,
--   one search, and not a zero-result one, since only the rows of the same text that all found
--   nothing count as zero.
-- Visitor-day 7 searched "port" ten days ago: outside a 7-day window.
-- Visitor-day 8 types "ca" then "cat" in a second: only "cat" is final, and it found a creator.
insert into public.search_query_events (created_at, query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count)
values
  (now() - interval '100 seconds', 'po',   'top',   false, repeat('1', 64), 0, 0, 0),
  (now() - interval '99 seconds',  'por',  'top',   false, repeat('1', 64), 0, 0, 0),
  (now() - interval '97 seconds',  'port', 'top',   false, repeat('1', 64), 0, 0, 0),
  (now() - interval '1 hour',      'port', 'top',   false, repeat('2', 64), 0, 3, 0),
  (now() - interval '2 hours',     'port', 'top',   true,  repeat('3', 64), 0, 0, 0),
  (now() - interval '1000 seconds', 'cat', 'top',   false, repeat('4', 64), 0, 1, 0),
  (now() - interval '990 seconds',  'dog', 'top',   false, repeat('4', 64), 0, 0, 0),
  (now() - interval '500 seconds', 'ab',   'top',   false, repeat('5', 64), 0, 0, 0),
  (now() - interval '480 seconds', 'abc',  'top',   false, repeat('5', 64), 0, 0, 0),
  (now() - interval '300 seconds', 'dress', 'top',  false, repeat('6', 64), 0, 4, 0),
  (now() - interval '297 seconds', 'dress', 'creators', false, repeat('6', 64), 0, 0, 0),
  (now() - interval '10 days',     'port', 'top',   false, repeat('7', 64), 0, 0, 0),
  (now() - interval '700 seconds', 'ca',   'top',   false, repeat('8', 64), 0, 0, 0),
  (now() - interval '699 seconds', 'cat',  'top',   false, repeat('8', 64), 1, 0, 0);

select results_eq(
  $$ select query, searches, zero_result_searches
     from public.search_query_report(7, 50) $$,
  $$ values
       ('port'::text, 3::bigint, 2::bigint),
       ('ab'::text,   1::bigint, 1::bigint),
       ('abc'::text,  1::bigint, 1::bigint),
       ('dog'::text,  1::bigint, 1::bigint),
       ('cat'::text,  2::bigint, 0::bigint),
       ('dress'::text, 1::bigint, 0::bigint) $$,
  'typing steps collapse into their final query; a tab switch is one search that found something; the zero-result count is per visitor-day; zero-result searches come first'
);
select is(
  (select count(*)::integer from public.search_query_report(7, 50) where query in ('po', 'por', 'ca')),
  0,
  'a query that a later one within 15 seconds extends is not a search of its own'
);
select results_eq(
  $$ select distinct total_searches, total_zero_result_searches from public.search_query_report(7, 50) $$,
  $$ values (9::bigint, 5::bigint) $$,
  'every row carries the window totals, so a zero-result rate is one division'
);
select is(
  (select count(*)::integer from public.search_query_report(7, 1)),
  1,
  'p_limit bounds the rows'
);
select is(
  (select max(total_searches) from public.search_query_report(7, 1)),
  9::bigint,
  'the totals cover every query, not only the rows returned'
);
select is(
  (select searches from public.search_query_report(30, 50) where query = 'port'),
  4::bigint,
  'a wider window reaches the older search'
);
select throws_ok(
  $$ select * from public.search_query_report(0, 50) $$,
  'search_query_report: p_days must be between 1 and 90',
  'a window under one day is refused'
);
select throws_ok(
  $$ select * from public.search_query_report(7, 0) $$,
  'search_query_report: p_limit must be between 1 and 1000',
  'a limit under one is refused'
);
select ok(
  not has_function_privilege('anon', 'public.search_query_report(integer, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_query_report(integer, integer)', 'EXECUTE'),
  'no client can run the report'
);
select ok(
  has_function_privilege('service_role', 'public.search_query_report(integer, integer)', 'EXECUTE'),
  'the service role can'
);

-- ─── The report stays linear per visitor-day ─────────────────────────────────
--
-- 25,920 rows from one key (a bot, or one hour of searching every 100 ms) took 99 seconds when
-- each row was compared with every later row of its visitor-day. Compared with the next row
-- only, it is a sort. The statement timeout turns a regression into a failure, not a hang.

delete from public.search_query_events;
insert into public.search_query_events (created_at, query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count)
select now() - interval '1 hour' + (n * interval '100 milliseconds'),
       'q' || (n % 7), 'top', false, repeat('9', 64), 0, n % 3, 0
from generate_series(1, 25920) as n;

set local statement_timeout = '10s';
select lives_ok(
  $$ select count(*) from public.search_query_report(1, 50) $$,
  'the report of 25,920 rows from one visitor-day runs within 10 seconds'
);
set local statement_timeout = 0;

select * from finish();
rollback;
