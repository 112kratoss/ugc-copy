-- The search log's two added signals (20261115105353): how a search was entered
-- (search_query_events.entry) and which result was opened from it
-- (public.search_result_opens). Backend-owned and append-only for the service
-- role, bounded by checks, swept after 90 days, counted by the growth
-- accounting, and read by search_query_report, which counts an open only while
-- its id is something search shows the public.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- ─── How a search was entered ────────────────────────────────────────────────

select col_is_null('public', 'search_query_events', 'entry', 'a search row may say nothing of how it was entered');
select lives_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count, entry)
     select 'port', 'top', false, repeat('a', 64), 0, 1, 0, entry
     from unnest(array['typed', 'suggestion', 'entity', 'recent', 'starter', 'related', 'link', null]) as entry $$,
  'each of the seven entries is kept, and so is none'
);
select throws_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count, entry)
     values ('port', 'top', false, repeat('a', 64), 0, 1, 0, 'voice') $$,
  '23514', null, 'an entry outside the list is refused'
);
select throws_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count, entry)
     values ('port', 'top', false, repeat('a', 64), 0, 1, 0, 'correction') $$,
  '23514', null, '"search instead for" is no entry: a search read as typed writes no row that could hold it'
);
select lives_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count)
     values ('port', 'top', false, repeat('a', 64), 0, 1, 0) $$,
  'the insert of the app live during the release, which names no entry, still works'
);

-- ─── The opened results: shape and privileges ────────────────────────────────

select has_table('public', 'search_result_opens', 'the opened-results log exists');
select columns_are(
  'public', 'search_result_opens',
  array['id', 'created_at', 'query', 'search_type', 'sort', 'entry', 'visitor_day',
        'result_kind', 'result_id', 'result_position'],
  'a row holds the query, tab, order and entry of the search, the hashed visitor-day, and the kind, id and place of what was opened: no user, network or device, and nothing else about the person'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.search_result_opens'::regclass),
  'row level security is on'
);
select is(
  (select count(*)::integer from pg_policy where polrelid = 'public.search_result_opens'::regclass),
  0,
  'no policy: the Data API roles see nothing'
);
select has_index('public', 'search_result_opens', 'search_result_opens_created_at_idx',
  'the report window and the retention sweep read by created_at');

select ok(not has_table_privilege('anon', 'public.search_result_opens', 'SELECT'), 'anon cannot read the opens');
select ok(not has_table_privilege('anon', 'public.search_result_opens', 'INSERT'), 'anon cannot write an open');
select ok(not has_table_privilege('authenticated', 'public.search_result_opens', 'SELECT'), 'authenticated cannot read the opens');
select ok(not has_table_privilege('authenticated', 'public.search_result_opens', 'INSERT'), 'authenticated cannot write an open');
select ok(has_table_privilege('service_role', 'public.search_result_opens', 'SELECT'), 'the service role reads the opens');
select ok(has_table_privilege('service_role', 'public.search_result_opens', 'INSERT'), 'the service role appends an open');
select ok(not has_table_privilege('service_role', 'public.search_result_opens', 'UPDATE'), 'append-only: no update for the service role');
select ok(not has_table_privilege('service_role', 'public.search_result_opens', 'DELETE'), 'append-only: the service role never deletes (the sweep runs as its owner)');
select ok(not has_table_privilege('service_role', 'public.search_result_opens', 'TRUNCATE'), 'append-only: no truncate for the service role');

-- ─── Checks ──────────────────────────────────────────────────────────────────

create function pg_temp.open_row(
  p_kind text, p_id text, p_position integer default 1,
  p_query text default 'port', p_type text default 'top', p_sort text default null,
  p_entry text default null, p_visitor text default repeat('a', 64)
) returns void language sql as $$
  insert into public.search_result_opens (query, search_type, sort, entry, visitor_day, result_kind, result_id, result_position)
  values (p_query, p_type, p_sort, p_entry, p_visitor, p_kind, p_id, p_position);
$$;

select lives_ok(
  $$ select pg_temp.open_row('post', '0b9e1000-0000-4000-8000-000000000001', 3, 'port', 'posts', 'latest', 'typed') $$,
  'a well-formed open inserts, created_at defaulting to now()'
);
select lives_ok($$ select pg_temp.open_row('creator', '0b9e1000-0000-4000-8000-000000000002') $$, 'a creator is named by its uuid');
select lives_ok($$ select pg_temp.open_row('recipe', '0b9e1000-0000-4000-8000-000000000003') $$, 'a recipe is named by its uuid');
select lives_ok($$ select pg_temp.open_row('entity', 'model:kling-2.6') $$, 'a model is named as a made-with filter names it');
select lives_ok($$ select pg_temp.open_row('entity', 'tool:midjourney') $$, 'and so is a tool');
select lives_ok($$ select pg_temp.open_row('post', '0b9e1000-0000-4000-8000-000000000001', 500) $$, 'place 500 is the last one kept');

select throws_ok($$ select pg_temp.open_row('comment', '0b9e1000-0000-4000-8000-000000000001') $$,
  '23514', null, 'a kind outside post, creator, recipe, entity is refused');
select throws_ok($$ select pg_temp.open_row('post', 'luna-studio') $$,
  '23514', null, 'a post id that is not a uuid is refused: no handle, title or URL can be stored');
select throws_ok($$ select pg_temp.open_row('creator', 'model:kling-2.6') $$,
  '23514', null, 'a creator cannot be named as an entity is');
select throws_ok($$ select pg_temp.open_row('entity', '0b9e1000-0000-4000-8000-000000000001') $$,
  '23514', null, 'an entity cannot be named by a uuid');
select throws_ok($$ select pg_temp.open_row('entity', 'model:has a space') $$,
  '23514', null, 'an entity key holds no space');
select throws_ok($$ select pg_temp.open_row('entity', 'brand:nike') $$,
  '23514', null, 'an entity is a model or a tool');
select throws_ok($$ select pg_temp.open_row('entity', 'model:' || repeat('k', 81)) $$,
  '23514', null, 'an entity key of more than 80 characters is refused');
select throws_ok($$ select pg_temp.open_row('post', '0b9e1000-0000-4000-8000-000000000001', 0) $$,
  '23514', null, 'a place is 1-based');
select throws_ok($$ select pg_temp.open_row('post', '0b9e1000-0000-4000-8000-000000000001', 501) $$,
  '23514', null, 'a place past 500 is refused');
select throws_ok($$ select pg_temp.open_row('post', '0b9e1000-0000-4000-8000-000000000001', 1, '') $$,
  '23514', null, 'an empty query is refused');
select throws_ok($$ select pg_temp.open_row('post', '0b9e1000-0000-4000-8000-000000000001', 1, repeat('x', 101)) $$,
  '23514', null, 'a query of more than 100 characters is refused');
select throws_ok($$ select pg_temp.open_row('post', '0b9e1000-0000-4000-8000-000000000001', 1, 'port', 'everything') $$,
  '23514', null, 'a tab outside top, creators, posts, recipes is refused');
select throws_ok($$ select pg_temp.open_row('post', '0b9e1000-0000-4000-8000-000000000001', 1, 'port', 'posts', 'oldest') $$,
  '23514', null, 'an order outside top and latest is refused');
select throws_ok($$ select pg_temp.open_row('post', '0b9e1000-0000-4000-8000-000000000001', 1, 'port', 'posts', null, 'voice') $$,
  '23514', null, 'an entry outside the list is refused');
select throws_ok($$ select pg_temp.open_row('post', '0b9e1000-0000-4000-8000-000000000001', 1, 'port', 'top', null, null, 'a-user-id-or-an-ip-address') $$,
  '23514', null, 'a visitor-day that is not a 64-character hash is refused, so a raw key or id cannot be stored');

-- ─── Retention and growth accounting ─────────────────────────────────────────

delete from public.search_result_opens;
insert into public.search_result_opens (created_at, query, search_type, visitor_day, result_kind, result_id, result_position)
values
  (now() - interval '91 days', 'old query', 'top', repeat('c', 64), 'post', '0b9e1000-0000-4000-8000-000000000001', 1),
  (now() - interval '89 days', 'recent query', 'top', repeat('d', 64), 'post', '0b9e1000-0000-4000-8000-000000000001', 1);

select is(
  (public.prune_operational_backend_data() ->> 'search_result_opens_deleted')::integer,
  1,
  'the operational sweep deletes opens older than 90 days and reports them'
);
select is(
  (select array_agg(query order by query) from public.search_result_opens),
  array['recent query'],
  'an open inside the window stays'
);
insert into public.search_result_opens (created_at, query, search_type, visitor_day, result_kind, result_id, result_position)
select now() - interval '100 days', 'old query', 'top', repeat('c', 64), 'post', '0b9e1000-0000-4000-8000-000000000001', n
from generate_series(1, 3) as n;
select ok(
  (public.prune_operational_backend_data(p_max_deletes_per_table => 2) ->> 'batch_limit_reached')::boolean,
  'a full batch of opens says a backlog remains, so the job asks again'
);
select is(
  ((public.prune_operational_backend_data() ->> 'total_deleted')::integer),
  1,
  'and the opens it deletes are in the sweep''s total'
);
select ok(
  exists (select 1 from public.get_operational_table_growth() where table_name = 'search_result_opens'),
  'the growth accounting watches the opens'
);
select ok(
  exists (select 1 from public.get_operational_table_growth() where table_name = 'search_query_events')
  and exists (select 1 from public.get_operational_table_growth() where table_name = 'post_search_embeddings'),
  'and still watches what it watched'
);

-- ─── The report ──────────────────────────────────────────────────────────────
--
-- …02 creates. Posts: …11 public (made with Midjourney), …12 public under an
-- NSFW label, …13 private, …14 public with a published free recipe.
insert into auth.users (id, email, aud, role, created_at, raw_app_meta_data, raw_user_meta_data)
values ('0b9e0000-0000-4000-8000-000000000002'::uuid, 'search-open-log-02@example.invalid',
        'authenticated', 'authenticated', now() - interval '200 days', '{}'::jsonb, '{}'::jsonb);
update public.profiles set username = 'wrenna-maker', display_name = 'Wrenna Maker'
where id = '0b9e0000-0000-4000-8000-000000000002'::uuid;

create function pg_temp.post_id(p_suffix text) returns uuid language sql immutable as $$
  select ('0b9e1000-0000-4000-8000-0000000000' || p_suffix)::uuid;
$$;
create function pg_temp.post(p_suffix text, p_title text, p_nsfw boolean default false, p_visibility text default 'public')
returns void language sql as $$
  insert into public.posts (
    id, user_id, visibility, category, source_kind, post_format, review_status,
    title, body, source_tool, source_tool_slug, showcase_asset_path, is_nsfw, created_at, updated_at
  ) values (
    pg_temp.post_id(p_suffix), '0b9e0000-0000-4000-8000-000000000002'::uuid, p_visibility, 'image', 'external',
    'media', 'visible', p_title, 'A quiet frame in harbour light', 'Midjourney', 'midjourney',
    case when p_nsfw then 'private-posts/' || pg_temp.post_id(p_suffix) || '/original.jpg'
         else 'showcase/search-open-log-' || p_suffix || '.png' end,
    p_nsfw, now() - interval '3 days', now()
  );
$$;
select pg_temp.post('11', 'Harbour at dawn');
select pg_temp.post('12', 'Harbour after dark', true);
select pg_temp.post('13', 'Harbour kept private', false, 'private');
select pg_temp.post('14', 'Harbour sketch');

insert into public.post_source_tools (post_id, tool_label, tool_slug, model_label, model_slug, sort_order)
values (pg_temp.post_id('11'), 'Midjourney', 'midjourney', 'Niji 6', 'niji-6', 0);

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
) values (
  '0b9e5000-0000-4000-8000-000000000014'::uuid, pg_temp.post_id('14'), '0b9e0000-0000-4000-8000-000000000002'::uuid,
  'free', 'published', 'Harbour sketch recipe', 'Three steps to the finished picture',
  'A preview long enough to pass the marketplace quality gate.',
  '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', 'The prompt a visitor unlocks for this picture')),
  '[]'::jsonb, 0, 0, 0, now(), now()
);

-- The fixtures are what the report takes for shown and not shown.
select ok(
  exists (select 1 from public.post_search_documents where post_id = pg_temp.post_id('11'))
  and not exists (select 1 from public.post_search_documents where post_id = pg_temp.post_id('13'))
  and exists (select 1 from public.creator_search_documents where creator_user_id = '0b9e0000-0000-4000-8000-000000000002'::uuid)
  and exists (select 1 from public.marketplace_bundle_listings where bundle_id = '0b9e5000-0000-4000-8000-000000000014'::uuid and listable)
  and exists (select 1 from public.post_search_entities where kind = 'model' and key = 'niji-6'),
  'fixtures: a public post, creator, recipe and model that search shows, and a private post it does not'
);

delete from public.search_query_events;
delete from public.search_result_opens;

create function pg_temp.search(
  p_visitor text, p_ago interval, p_query text, p_posts integer default 2,
  p_entry text default null, p_type text default 'top'
) returns void language sql as $$
  insert into public.search_query_events (created_at, query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count, entry)
  values (now() - p_ago, p_query, p_type, false, repeat(p_visitor, 64), 0, p_posts, 0, p_entry);
$$;
create function pg_temp.opened(
  p_visitor text, p_ago interval, p_query text, p_kind text, p_id text, p_position integer
) returns void language sql as $$
  insert into public.search_result_opens (created_at, query, search_type, visitor_day, result_kind, result_id, result_position)
  values (now() - p_ago, p_query, 'top', repeat(p_visitor, 64), p_kind, p_id, p_position);
$$;

-- Visitor-day 1 typed "harbour" and opened the public post at place 2, twice, and the creator at place 1.
select pg_temp.search('1', interval '600 seconds', 'harbour', 2, 'typed');
select pg_temp.opened('1', interval '590 seconds', 'harbour', 'post', pg_temp.post_id('11')::text, 2);
select pg_temp.opened('1', interval '580 seconds', 'harbour', 'post', pg_temp.post_id('11')::text, 6);
select pg_temp.opened('1', interval '570 seconds', 'harbour', 'creator', '0b9e0000-0000-4000-8000-000000000002', 1);
-- Visitor-day 2 took "harbour" from a recent search and opened nothing.
select pg_temp.search('2', interval '500 seconds', 'harbour', 2, 'recent');
-- Visitor-day 3 typed "harbour" and "opened" only what search does not show: a labelled post, a
-- private post, a post that never existed, a recipe that never existed, a model no post has.
select pg_temp.search('3', interval '400 seconds', 'harbour', 2, 'typed');
select pg_temp.opened('3', interval '399 seconds', 'harbour', 'post', pg_temp.post_id('12')::text, 1);
select pg_temp.opened('3', interval '398 seconds', 'harbour', 'post', pg_temp.post_id('13')::text, 1);
select pg_temp.opened('3', interval '397 seconds', 'harbour', 'post', '0b9e1000-0000-4000-8000-0000000000ff', 1);
select pg_temp.opened('3', interval '396 seconds', 'harbour', 'recipe', '0b9e5000-0000-4000-8000-0000000000ff', 1);
select pg_temp.opened('3', interval '395 seconds', 'harbour', 'entity', 'model:no-such-model', 1);
-- Visitor-day 4 typed har → harb → harbour sketch a second apart, opened the recipe from "harb"
-- (place 4) and the model row from "harbour sketch" (place 1): "har" is a typing step, "harb" is a
-- search because something was opened from it.
select pg_temp.search('4', interval '300 seconds', 'har', 2, 'typed');
select pg_temp.search('4', interval '299 seconds', 'harb', 2, 'typed');
select pg_temp.search('4', interval '298 seconds', 'harbour sketch', 1, 'typed');
select pg_temp.opened('4', interval '297 seconds', 'harb', 'recipe', '0b9e5000-0000-4000-8000-000000000014', 4);
select pg_temp.opened('4', interval '290 seconds', 'harbour sketch', 'entity', 'model:niji-6', 1);
-- Visitor-day 5 found nothing for "zzyzx", from a start-screen row; an older client (no entry).
select pg_temp.search('5', interval '200 seconds', 'zzyzx', 0, 'starter');
select pg_temp.search('6', interval '190 seconds', 'zzyzx', 0, null);
-- Visitor-day 7 asked "harbour" on Top as a suggestion, then on Posts from a link: one search, its first entry.
select pg_temp.search('7', interval '100 seconds', 'harbour', 2, 'suggestion');
select pg_temp.search('7', interval '97 seconds', 'harbour', 2, 'link', 'posts');
-- Visitor-days A and B searched "harbour" from a client that says no entry (an app before its
-- update, a tab loaded before the release): such a client cannot report an open, so neither search
-- is opened or unopened. B's has an open under its code (another client of the same account): it
-- still counts for nothing, as B's search is not one that could report.
select pg_temp.search('a', interval '95 seconds', 'harbour', 2, null);
select pg_temp.search('b', interval '94 seconds', 'harbour', 2, null);
select pg_temp.opened('b', interval '93 seconds', 'harbour', 'post', pg_temp.post_id('11')::text, 9);
-- An open with no search behind it that day (the search log was off, or the key rolled over) counts nowhere.
select pg_temp.opened('8', interval '50 seconds', 'harbour', 'post', pg_temp.post_id('11')::text, 1);
-- And an open outside the window is not read.
select pg_temp.opened('2', interval '10 days', 'harbour', 'post', pg_temp.post_id('11')::text, 1);

select results_eq(
  $$ select query, searches, zero_result_searches, reporting_searches, opened_searches, unopened_searches, mean_open_position, entry_mix
     from public.search_query_report(7, 50) $$,
  $$ values
       ('zzyzx'::text, 2::bigint, 2::bigint, 1::bigint, 0::bigint, 0::bigint, null::numeric, '{"starter": 1, "unknown": 1}'::jsonb),
       ('harbour'::text, 6::bigint, 0::bigint, 4::bigint, 1::bigint, 3::bigint, 1.50::numeric, '{"typed": 2, "recent": 1, "suggestion": 1, "unknown": 2}'::jsonb),
       ('harb'::text, 1::bigint, 0::bigint, 1::bigint, 1::bigint, 0::bigint, 4.00::numeric, '{"typed": 1}'::jsonb),
       ('harbour sketch'::text, 1::bigint, 0::bigint, 1::bigint, 1::bigint, 0::bigint, 1.00::numeric, '{"typed": 1}'::jsonb) $$,
  'a search is opened when a result search still shows was pressed from it; one result pressed twice is one open at its first place; an id search does not show counts for nothing; a query a result was opened from is a search, not a typing step; a zero-result search is not "unopened"; a search takes its first entry; and a search from a client that says no entry is counted as a search and as neither opened nor unopened'
);
select is(
  (select reporting_searches from public.search_query_report(7, 50) where query = 'harbour'),
  (select opened_searches + unopened_searches from public.search_query_report(7, 50) where query = 'harbour'),
  'of the searches that could report an open and found something, each is opened or unopened'
);
select is(
  (select count(*)::integer from public.search_query_report(7, 50) where query = 'har'),
  0,
  'a query nothing was opened from still collapses into the one it led to'
);
select results_eq(
  $$ select distinct total_searches, total_zero_result_searches, total_reporting_searches, total_opened_searches,
            total_unopened_searches, total_mean_open_position, total_entry_mix
     from public.search_query_report(7, 50) $$,
  $$ values (10::bigint, 2::bigint, 7::bigint, 3::bigint, 3::bigint, 2.00::numeric,
             '{"typed": 4, "recent": 1, "suggestion": 1, "starter": 1, "unknown": 3}'::jsonb) $$,
  'every row carries the window totals: searches, zero-result, those from a client that reports opens, opened, left unopened, the mean place and the entry mix'
);
select results_eq(
  $$ select query, unopened_searches from public.search_query_report(7, 2, 'unopened') $$,
  $$ values ('harbour'::text, 3::bigint), ('zzyzx'::text, 0::bigint) $$,
  'p_order = unopened puts the queries most often left without an open first, then the most searched'
);
select is(
  (select max(total_opened_searches) from public.search_query_report(7, 1, 'unopened')),
  3::bigint,
  'the totals cover every query, not only the rows returned'
);
select results_eq(
  $$ select query, searches, zero_result_searches from public.search_query_report(p_days => 7, p_limit => 1) $$,
  $$ values ('zzyzx'::text, 2::bigint, 2::bigint) $$,
  'the two-argument call of an older checkout still answers, zero-result searches first'
);

-- A result that stops being public stops counting: the post gains a label.
update public.posts set is_nsfw = true where id = pg_temp.post_id('11');
select results_eq(
  $$ select opened_searches, unopened_searches, mean_open_position
     from public.search_query_report(7, 50) where query = 'harbour' $$,
  $$ values (1::bigint, 3::bigint, 1.00::numeric) $$,
  'an open counts only while its id is public: the labelled post''s open is gone, the creator''s stays'
);
update public.posts set is_nsfw = false where id = pg_temp.post_id('11');

select throws_ok(
  $$ select * from public.search_query_report(7, 50, 'newest') $$,
  'search_query_report: p_order must be zero_result or unopened',
  'an unknown order is refused'
);
select ok(
  not has_function_privilege('anon', 'public.search_query_report(integer, integer, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_query_report(integer, integer, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.search_query_report(integer, integer, text)', 'EXECUTE'),
  'only the service role runs the report'
);
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_proc as p where p.oid = 'public.search_query_report(integer, integer, text)'::regprocedure),
  'the report is SECURITY DEFINER with an empty search_path'
);
select is(
  (select count(*)::integer from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'search_query_report'),
  1,
  'one report function: the two-argument one was replaced, not kept beside it'
);

-- ─── The report stays linear ─────────────────────────────────────────────────
--
-- 25,920 searches and 25,920 opens from one visitor-day, the opens on four ids: the opens are
-- grouped and each id looked up once, so the report is still a sort.

delete from public.search_query_events;
delete from public.search_result_opens;
insert into public.search_query_events (created_at, query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count, entry)
select now() - interval '1 hour' + (n * interval '100 milliseconds'),
       'q' || (n % 7), 'top', false, repeat('9', 64), 0, n % 3, 0, 'typed'
from generate_series(1, 25920) as n;
insert into public.search_result_opens (created_at, query, search_type, visitor_day, result_kind, result_id, result_position)
select now() - interval '1 hour' + (n * interval '100 milliseconds'),
       'q' || (n % 7), 'top', repeat('9', 64), 'post', pg_temp.post_id((11 + n % 4)::text)::text, 1 + n % 24
from generate_series(1, 25920) as n;

set local statement_timeout = '10s';
select lives_ok(
  $$ select count(*) from public.search_query_report(1, 50, 'unopened') $$,
  'the report of 25,920 searches and 25,920 opens runs within 10 seconds'
);
set local statement_timeout = 0;

select * from finish();
rollback;
