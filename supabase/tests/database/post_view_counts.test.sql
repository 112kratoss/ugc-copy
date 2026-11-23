-- Post view counts (20261123070740): a view is one mark per post, viewer and
-- UTC day, made by the feed's qualified impressions of a viewer with an
-- account (Home and the feed reel) or by POST /api/showcase/views (the post
-- page, other reels and every web guest's view, a guest held to 20 per
-- network per post per day); only a public, visible post counts and never its
-- creator's own view; the rollup adds marks to posts.view_count and
-- post_view_days once, then prunes them. Fixtures roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id,email,aud,role,is_anonymous,created_at) values
('f7a10001-0000-4000-8000-000000000001','views-creator@example.invalid','authenticated','authenticated',false,now()),
('f7a10002-0000-4000-8000-000000000002','views-viewer@example.invalid','authenticated','authenticated',false,now()),
('f7a10003-0000-4000-8000-000000000003','views-other@example.invalid','authenticated','authenticated',false,now()),
('f7a10004-0000-4000-8000-000000000004','views-feed@example.invalid','authenticated','authenticated',false,now()),
('f7a10005-0000-4000-8000-000000000005','views-reel@example.invalid','authenticated','authenticated',false,now()),
('f7a10006-0000-4000-8000-000000000006','views-explore@example.invalid','authenticated','authenticated',false,now());

insert into public.posts (id,user_id,visibility,category,source_kind,title,output_url) values
('f7a20000-0000-4000-8000-000000000001','f7a10001-0000-4000-8000-000000000001','public','image','external','Viewed fixture','generated_images/views-1.png'),
('f7a20000-0000-4000-8000-000000000002','f7a10001-0000-4000-8000-000000000001','private','image','external','Private fixture','generated_images/views-2.png'),
('f7a20000-0000-4000-8000-000000000003','f7a10001-0000-4000-8000-000000000001','public','image','external','Archived fixture','generated_images/views-3.png'),
('f7a20000-0000-4000-8000-000000000004','f7a10001-0000-4000-8000-000000000001','public','image','external','Hidden fixture','generated_images/views-4.png'),
('f7a20000-0000-4000-8000-000000000005','f7a10001-0000-4000-8000-000000000001','public','image','external','Tombstoned fixture','generated_images/views-5.png'),
('f7a20000-0000-4000-8000-000000000006','f7a10001-0000-4000-8000-000000000001','public','image','external','Feed fixture','generated_images/views-6.png'),
('f7a20000-0000-4000-8000-000000000007','f7a10001-0000-4000-8000-000000000001','public','image','external','Network fixture','generated_images/views-7.png');

update public.posts set archived_at = now() where id = 'f7a20000-0000-4000-8000-000000000003';
update public.posts set review_status = 'hidden' where id = 'f7a20000-0000-4000-8000-000000000004';
update public.posts set tombstoned_at = now() where id = 'f7a20000-0000-4000-8000-000000000005';

-- ─── Shape and who may call what ────────────────────────────────────────────

select col_default_is('public', 'posts', 'view_count', '0', 'a post starts at no views');
select throws_ok(
  $$update public.posts set view_count = -1 where id = 'f7a20000-0000-4000-8000-000000000001'$$,
  '23514', null, 'a total is never negative'
);

select ok(
  not has_table_privilege('anon', 'public.post_view_marks', 'SELECT')
  and not has_table_privilege('authenticated', 'public.post_view_marks', 'SELECT')
  and not has_table_privilege('anon', 'public.post_view_days', 'SELECT')
  and not has_table_privilege('authenticated', 'public.post_view_days', 'SELECT'),
  'the Data API roles read neither the marks nor the days'
);
select ok(
  not has_table_privilege('service_role', 'public.post_view_marks', 'INSERT')
  and not has_table_privilege('service_role', 'public.post_view_marks', 'UPDATE')
  and not has_table_privilege('service_role', 'public.post_view_marks', 'DELETE')
  and not has_table_privilege('service_role', 'public.post_view_days', 'INSERT'),
  'the service role writes them only through the functions'
);
select ok(
  (select bool_and(not has_function_privilege(client_role, signature, 'EXECUTE'))
   from unnest(array['anon', 'authenticated']) as client_role,
        unnest(array[
          'public.record_post_view(uuid, uuid, text, text, text, timestamptz)',
          'public.record_post_views(uuid, text, text, jsonb)',
          'public.apply_post_view_marks(bigint[], timestamptz)',
          'public.rollup_post_views(timestamptz, integer)'
        ]) as signature),
  'no client may record, apply or roll up a view'
);
select ok(
  has_function_privilege('service_role', 'public.record_post_views(uuid, text, text, jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.rollup_post_views(timestamptz, integer)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.record_post_view(uuid, uuid, text, text, text, timestamptz)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.apply_post_view_marks(bigint[], timestamptz)', 'EXECUTE'),
  'the server calls the batch and the rollup, nothing beneath them'
);

-- ─── The route's views ──────────────────────────────────────────────────────

set local role service_role;

select is(
  public.record_post_views('f7a10002-0000-4000-8000-000000000002', null, null,
    '[{"postId": "f7a20000-0000-4000-8000-000000000001", "surface": "post-page"}]'),
  1, 'a signed-in viewer''s view of a public post counts'
);
select is(
  public.record_post_views('f7a10002-0000-4000-8000-000000000002', null, null,
    '[{"postId": "f7a20000-0000-4000-8000-000000000001", "surface": "reel"}]'),
  0, 'the same viewer again that day, anywhere, does not'
);
select is(
  public.record_post_views('f7a10003-0000-4000-8000-000000000003', null, null,
    '[{"postId": "f7a20000-0000-4000-8000-000000000001", "surface": "reel"}]'),
  1, 'another viewer does'
);
select is(
  public.record_post_views(null, repeat('ab', 32), repeat('ef', 32),
    '[{"postId": "f7a20000-0000-4000-8000-000000000001", "surface": "post-page"},
      {"postId": "f7a20000-0000-4000-8000-000000000001", "surface": "post-page"}]'),
  1, 'a guest counts once by its hashed key, even twice in one batch'
);
select is(
  public.record_post_views('f7a10001-0000-4000-8000-000000000001', null, null,
    '[{"postId": "f7a20000-0000-4000-8000-000000000001", "surface": "post-page"}]'),
  0, 'the creator''s own view never counts'
);
select is(
  public.record_post_views('f7a10002-0000-4000-8000-000000000002', null, null,
    '[{"postId": "f7a20000-0000-4000-8000-000000000002", "surface": "post-page"},
      {"postId": "f7a20000-0000-4000-8000-000000000003", "surface": "post-page"},
      {"postId": "f7a20000-0000-4000-8000-000000000004", "surface": "post-page"},
      {"postId": "f7a20000-0000-4000-8000-000000000005", "surface": "post-page"},
      {"postId": "f7a20000-0000-4000-8000-0000000000ff", "surface": "post-page"}]'),
  0, 'a private, archived, hidden, tombstoned or missing post counts nothing'
);
select is(
  public.record_post_views('f7a10002-0000-4000-8000-000000000002', null, null,
    '["f7a20000-0000-4000-8000-000000000006",
      {"postId": "not-a-post", "surface": "post-page"},
      {"postId": "f7a20000-0000-4000-8000-000000000006", "surface": "explore"},
      {"postId": "f7a20000-0000-4000-8000-000000000006"}]'),
  0, 'an entry that is not an object, names no uuid or no known surface is skipped, not refused'
);
select throws_ok(
  $$select public.record_post_views('f7a10002-0000-4000-8000-000000000002', null, null,
    (select jsonb_agg(jsonb_build_object('postId', 'f7a20000-0000-4000-8000-000000000001', 'surface', 'reel'))
     from generate_series(1, 26)))$$,
  '22023', 'At most 25 post views per call', 'a batch over 25 is refused'
);
select throws_ok(
  $$select public.record_post_views(null, null, null, '[]')$$,
  '22023', 'A post view needs exactly one viewer key', 'a view needs a viewer'
);
select throws_ok(
  $$select public.record_post_views('f7a10002-0000-4000-8000-000000000002', repeat('ab', 32), null, '[]')$$,
  '22023', 'A post view needs exactly one viewer key', 'and only one'
);
select throws_ok(
  $$select public.record_post_views(null, repeat('ab', 32), null, '[]')$$,
  '22023', 'A guest''s post view needs its network key', 'a guest''s view comes with its network'
);

-- A script that mints a fresh guest cookie per request is held to its
-- network's twenty a post a day; another network still counts.
select is(
  (select sum(public.record_post_views(null, md5(guest::text) || md5(guest::text), repeat('12', 32),
     '[{"postId": "f7a20000-0000-4000-8000-000000000007", "surface": "post-page"}]'))
   from generate_series(1, 21) as guest),
  20::bigint, 'twenty-one guests of one network: twenty count'
);
select is(
  public.record_post_views(null, repeat('9a', 32), repeat('34', 32),
    '[{"postId": "f7a20000-0000-4000-8000-000000000007", "surface": "post-page"}]'),
  1, 'a guest of another network counts'
);
select is(
  public.record_post_views('f7a10006-0000-4000-8000-000000000006', null, repeat('12', 32),
    '[{"postId": "f7a20000-0000-4000-8000-000000000007", "surface": "post-page"}]'),
  1, 'an account is never held to its network''s guests'
);

reset role;

select is(
  (select count(*) from public.post_view_marks
   where post_id = 'f7a20000-0000-4000-8000-000000000001' and surface in ('post-page', 'reel')),
  3::bigint, 'three viewers, three marks'
);
select is(
  (select count(*) from public.post_view_marks
   where viewer_user_id is not null and network_key_hash is not null),
  0::bigint, 'an account''s mark keeps no network'
);
select is(
  (select count(*) from public.post_view_marks where counted_at is not null), 0::bigint,
  'nothing is counted until the rollup'
);

-- ─── The feed's impressions ─────────────────────────────────────────────────

insert into public.feed_events (client_event_id, viewer_user_id, post_id, creator_user_id, event_type, source_surface, occurred_at) values
('views-home-1','f7a10004-0000-4000-8000-000000000004','f7a20000-0000-4000-8000-000000000006','f7a10001-0000-4000-8000-000000000001','impression','feed',now() - interval '3 days'),
('views-home-2','f7a10004-0000-4000-8000-000000000004','f7a20000-0000-4000-8000-000000000006','f7a10001-0000-4000-8000-000000000001','impression','feed',now()),
('views-reel-1','f7a10005-0000-4000-8000-000000000005','f7a20000-0000-4000-8000-000000000006','f7a10001-0000-4000-8000-000000000001','impression','showcase-reel',now()),
('views-grid-1','f7a10006-0000-4000-8000-000000000006','f7a20000-0000-4000-8000-000000000006','f7a10001-0000-4000-8000-000000000001','impression','showcase',now()),
('views-open-1','f7a10006-0000-4000-8000-000000000006','f7a20000-0000-4000-8000-000000000006','f7a10001-0000-4000-8000-000000000001','open','feed',now()),
('views-own-1','f7a10001-0000-4000-8000-000000000001','f7a20000-0000-4000-8000-000000000006','f7a10001-0000-4000-8000-000000000001','impression','feed',now());
insert into public.feed_events (client_event_id, anonymous_key_hash, post_id, creator_user_id, event_type, source_surface, occurred_at) values
('views-guest-1',repeat('cd', 32),'f7a20000-0000-4000-8000-000000000006','f7a10001-0000-4000-8000-000000000001','impression','feed',now());

select is(
  (select array_agg(viewer_user_id::text || ':' || surface order by surface, viewer_user_id)
   from public.post_view_marks where post_id = 'f7a20000-0000-4000-8000-000000000006'),
  array['f7a10004-0000-4000-8000-000000000004:feed', 'f7a10005-0000-4000-8000-000000000005:reel'],
  'Home and the feed reel count, once a day; Explore''s tiles, opens, the creator''s own impression and a guest''s impression do not'
);
select is(
  (select view_date from public.post_view_marks
   where post_id = 'f7a20000-0000-4000-8000-000000000006'
     and viewer_user_id = 'f7a10004-0000-4000-8000-000000000004'),
  (now() at time zone 'UTC')::date,
  'a mark''s day is the server''s, not the day the client says it saw the post'
);
select is(
  (select count(*) from public.feed_events where client_event_id like 'views-%'), 7::bigint,
  'every feed event is still stored, counted or not'
);

-- ─── The rollup ─────────────────────────────────────────────────────────────

-- A view of an earlier day, and one old enough to be pruned once counted.
select ok(
  public.record_post_view('f7a20000-0000-4000-8000-000000000001', 'f7a10002-0000-4000-8000-000000000002', null, null, 'reel', now() - interval '1 day'),
  'the same viewer counts again on another day'
);
select ok(
  public.record_post_view('f7a20000-0000-4000-8000-000000000001', 'f7a10003-0000-4000-8000-000000000003', null, null, 'feed', now() - interval '5 days'),
  'an old view, for the prune'
);
insert into public.post_view_days (post_id, view_date, views) values
('f7a20000-0000-4000-8000-000000000006', (now() at time zone 'UTC')::date - 401, 9);

set local role service_role;

create temporary table first_rollup on commit drop as
  select public.rollup_post_views(now(), 5000) as result;

select is((select (result->>'views_counted')::int from first_rollup), 29, 'every uncounted mark is counted');
select is((select (result->>'posts_counted')::int from first_rollup), 3, 'on its post');
select is((select (result->>'posts_failed')::int from first_rollup), 0, 'and no post refused');
select is((select (result->>'marks_pruned')::int from first_rollup), 1, 'the counted mark past its two days is pruned');
select is((select (result->>'days_pruned')::int from first_rollup), 1, 'a day older than 400 days is pruned');
select is((select (result->>'more')::boolean from first_rollup), false, 'the batch was not full');

reset role;

select is(
  (select view_count from public.posts where id = 'f7a20000-0000-4000-8000-000000000001'), 5::bigint,
  'the post page''s post: three viewers today, one yesterday, one five days ago'
);
select is(
  (select view_count from public.posts where id = 'f7a20000-0000-4000-8000-000000000006'), 2::bigint,
  'the feed''s post: Home and the reel'
);
select is(
  (select view_count from public.posts where id = 'f7a20000-0000-4000-8000-000000000007'), 22::bigint,
  'the network''s post: twenty guests of one network, one of another and an account'
);
select is(
  (select array_agg(views order by view_date)
   from public.post_view_days where post_id = 'f7a20000-0000-4000-8000-000000000001'),
  array[1, 1, 3]::bigint[],
  'the days keep each day''s views, the pruned mark''s included'
);
select is(
  (select count(*) from public.post_view_marks where counted_at is null), 0::bigint,
  'every mark left is stamped counted'
);

set local role service_role;
select is(
  (public.rollup_post_views(now(), 5000)->>'views_counted')::int, 0,
  'a second rollup counts nothing again'
);
reset role;
select is(
  (select view_count from public.posts where id = 'f7a20000-0000-4000-8000-000000000001'), 5::bigint,
  'and the total stands'
);

-- A full batch says so, and the rest waits for the next call.
select ok(public.record_post_view('f7a20000-0000-4000-8000-000000000006', 'f7a10002-0000-4000-8000-000000000002', null, null, 'reel', now()), 'fixture: one more view');
select ok(public.record_post_view('f7a20000-0000-4000-8000-000000000006', 'f7a10003-0000-4000-8000-000000000003', null, null, 'reel', now()), 'fixture: and another');
set local role service_role;
select is((public.rollup_post_views(now(), 1)->>'more')::boolean, true, 'a full batch reports more');
select is((public.rollup_post_views(now(), 1)->>'views_counted')::int, 1, 'and the next call takes the rest');
select throws_ok(
  $$select public.rollup_post_views(now(), 0)$$,
  '22023', 'Post view rollup limit must be between 1 and 50000', 'a batch has a size'
);
reset role;
select is(
  (select view_count from public.posts where id = 'f7a20000-0000-4000-8000-000000000006'), 4::bigint,
  'both views reached the total'
);

-- ─── Who is kept ────────────────────────────────────────────────────────────

delete from auth.users where id = 'f7a10005-0000-4000-8000-000000000005';
select is(
  (select count(*) from public.post_view_marks where viewer_user_id = 'f7a10005-0000-4000-8000-000000000005'), 0::bigint,
  'a deleted account''s marks go with it'
);
select is(
  (select view_count from public.posts where id = 'f7a20000-0000-4000-8000-000000000006'), 4::bigint,
  'and the totals it added stay'
);

select * from finish();
rollback;
