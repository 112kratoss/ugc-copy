-- A follow's alert names its follower, and opens their page, only while it may
-- (20261020072851): written across a block, either way round, it is stored
-- without the name and the page; a block made after it, either way round,
-- takes them out and leaves the alert; so does the follower's account being
-- deleted. Alerts that name no one, alerts naming anyone else, and other alert
-- types keep their words. Fixtures roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- The creator cora, and followers maya, lee, ana, sam, kai, tom and noor.
insert into auth.users (id,email,aud,role,is_anonymous,created_at) values
('f0a10001-0000-4000-8000-000000000001','follow-alert-cora@example.invalid','authenticated','authenticated',false,now()),
('f0a10002-0000-4000-8000-000000000002','follow-alert-maya@example.invalid','authenticated','authenticated',false,now()),
('f0a10003-0000-4000-8000-000000000003','follow-alert-lee@example.invalid','authenticated','authenticated',false,now()),
('f0a10004-0000-4000-8000-000000000004','follow-alert-ana@example.invalid','authenticated','authenticated',false,now()),
('f0a10005-0000-4000-8000-000000000005','follow-alert-sam@example.invalid','authenticated','authenticated',false,now()),
('f0a10006-0000-4000-8000-000000000006','follow-alert-kai@example.invalid','authenticated','authenticated',false,now()),
('f0a10007-0000-4000-8000-000000000007','follow-alert-tom@example.invalid','authenticated','authenticated',false,now()),
('f0a10008-0000-4000-8000-000000000008','follow-alert-noor@example.invalid','authenticated','authenticated',false,now());

set local role service_role;

-- What the server writes for a follow (notifyCreatorFollowed in
-- src/lib/mobile-notifications.ts), to the account followed, with the
-- follower as actor.
create temporary table follow_alert (id uuid, follower uuid, followed uuid, body text, deep_link text) on commit drop;
insert into follow_alert values
('f0a14000-0000-4000-8000-000000000001','f0a10002-0000-4000-8000-000000000002','f0a10001-0000-4000-8000-000000000001','@maya followed you.','/creators/maya'),
('f0a14000-0000-4000-8000-000000000002','f0a10003-0000-4000-8000-000000000003','f0a10001-0000-4000-8000-000000000001','@lee followed you.','/creators/lee'),
-- The other way round: cora followed lee.
('f0a14000-0000-4000-8000-000000000003','f0a10001-0000-4000-8000-000000000001','f0a10003-0000-4000-8000-000000000003','@cora followed you.','/creators/cora'),
('f0a14000-0000-4000-8000-000000000006','f0a10006-0000-4000-8000-000000000006','f0a10001-0000-4000-8000-000000000001','@kai followed you.','/creators/kai'),
-- Written before named alerts opened the follower's page (#453, 2026-10-15).
('f0a14000-0000-4000-8000-000000000007','f0a10006-0000-4000-8000-000000000006','f0a10003-0000-4000-8000-000000000003','@kai followed you.','/studio'),
('f0a14000-0000-4000-8000-000000000008','f0a10007-0000-4000-8000-000000000007','f0a10001-0000-4000-8000-000000000001','@tom followed you.','/creators/tom'),
-- A follower with no handle: the alert already names no one.
('f0a14000-0000-4000-8000-000000000009','f0a10008-0000-4000-8000-000000000008','f0a10001-0000-4000-8000-000000000001','Someone followed your creator profile.','/studio');

create function pg_temp.write_follow_alert(p_id uuid) returns void language sql as $$
  insert into public.mobile_notifications (id,user_id,actor_user_id,type,category,title,body,deep_link,object_type,object_id,dedupe_key,last_event_at)
  select id, followed, follower, 'creator_followed', 'social', 'New follower', body, deep_link,
         'profile', follower::text, 'creator-follow:' || follower::text || ':' || followed::text,
         now() - interval '1 day'
  from follow_alert where id = p_id
$$;

create function pg_temp.alert(p_id uuid) returns text language sql as $$
  select title || ' · ' || body || ' · ' || coalesce(deep_link, '(no link)') from public.mobile_notifications where id = p_id
$$;

select pg_temp.write_follow_alert(id) from follow_alert;

select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000001'),
  'New follower · @maya followed you. · /creators/maya',
  'a follow between accounts with no block names its follower and opens their page');
select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000009'),
  'New follower · Someone followed your creator profile. · /studio',
  'a follower with no handle is named by no one, and the alert opens Alerts');

-- 1. Written across a block, either way round: the follow went in before the
-- block, and its alert after.
insert into public.user_blocks (blocker_user_id, blocked_user_id) values
('f0a10004-0000-4000-8000-000000000004','f0a10001-0000-4000-8000-000000000001'),
('f0a10001-0000-4000-8000-000000000001','f0a10005-0000-4000-8000-000000000005');
insert into follow_alert values
('f0a14000-0000-4000-8000-000000000004','f0a10004-0000-4000-8000-000000000004','f0a10001-0000-4000-8000-000000000001','@ana followed you.','/creators/ana'),
('f0a14000-0000-4000-8000-000000000005','f0a10005-0000-4000-8000-000000000005','f0a10001-0000-4000-8000-000000000001','@sam followed you.','/creators/sam');
select pg_temp.write_follow_alert('f0a14000-0000-4000-8000-000000000004');
select pg_temp.write_follow_alert('f0a14000-0000-4000-8000-000000000005');

select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000004'),
  'New follower · Someone followed your creator profile. · /studio',
  'a follow alert written after the follower blocked the creator is stored without the name or the page');
select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000005'),
  'New follower · Someone followed your creator profile. · /studio',
  'and so is one written after the creator blocked the follower');
select is((select actor_user_id from public.mobile_notifications where id='f0a14000-0000-4000-8000-000000000004'),
  'f0a10004-0000-4000-8000-000000000004'::uuid, 'and it keeps its follower, as an alert with no handle to name does');

-- 2. A block made after the alert, either way round.
insert into public.user_blocks (blocker_user_id, blocked_user_id) values
('f0a10001-0000-4000-8000-000000000001','f0a10003-0000-4000-8000-000000000003'),
('f0a10001-0000-4000-8000-000000000001','f0a10008-0000-4000-8000-000000000008');
select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000002'),
  'New follower · Someone followed your creator profile. · /studio',
  'the creator blocking the follower afterwards takes the name and the page out');
select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000003'),
  'New follower · Someone followed your creator profile. · /studio',
  'and out of the alert that named the creator to the follower');
select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000001'),
  'New follower · @maya followed you. · /creators/maya',
  'and leaves the alerts naming anyone else');
select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000009'),
  'New follower · Someone followed your creator profile. · /studio',
  'an alert that named no one is left as it was');
select is((select count(*) from public.mobile_notifications
           where id in ('f0a14000-0000-4000-8000-000000000002','f0a14000-0000-4000-8000-000000000003')),
  2::bigint, 'a block keeps both alerts, the record that each follow was announced');

insert into public.user_blocks (blocker_user_id, blocked_user_id) values
('f0a10002-0000-4000-8000-000000000002','f0a10001-0000-4000-8000-000000000001');
select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000001'),
  'New follower · Someone followed your creator profile. · /studio',
  'the follower blocking the creator afterwards takes them out too');

-- 3. The follower's account deleted. An alert of another type keeps its words,
-- even words a follow alert would lose.
insert into public.mobile_notifications (id,user_id,actor_user_id,type,category,title,body,deep_link,object_type,object_id) values
('f0a14000-0000-4000-8000-000000000010','f0a10001-0000-4000-8000-000000000001','f0a10006-0000-4000-8000-000000000006',
 'post_remixed','social','Someone remixed your post','@kai followed you.','/creators/kai','post','p1');
reset role;
select lives_ok($$ delete from auth.users where id='f0a10006-0000-4000-8000-000000000006' $$,
  'deleting a follower''s account succeeds');
set local role service_role;
select is((select actor_user_id from public.mobile_notifications where id='f0a14000-0000-4000-8000-000000000006'),
  null::uuid, 'the foreign key clears the follower from their follow''s alert');
select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000006'),
  'New follower · Someone followed your creator profile. · /studio',
  'and the name and the page go with them');
select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000007'),
  'New follower · Someone followed your creator profile. · /studio',
  'from an alert written before alerts opened the follower''s page too');
select is((select last_event_at from public.mobile_notifications where id='f0a14000-0000-4000-8000-000000000006'),
  now() - interval '1 day', 'the alert keeps its place and its age in the inbox');
select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000008'),
  'New follower · @tom followed you. · /creators/tom',
  'an alert naming a follower whose account stands keeps the name');
select is(pg_temp.alert('f0a14000-0000-4000-8000-000000000010'),
  'Someone remixed your post · @kai followed you. · /creators/kai',
  'another alert type is not this migration''s to change');

-- The words function returns an alert that names no one unchanged.
select is((select body || ' · ' || deep_link from public.unnamed_follow_alert_words(
  'Someone followed your creator profile.', '/studio')),
  'Someone followed your creator profile. · /studio',
  'words that name no one come back as they are');
select is((select body || ' · ' || deep_link from public.unnamed_follow_alert_words(
  'Someone followed your creator profile.', '/creators/maya')),
  'Someone followed your creator profile. · /studio',
  'a link to a follower''s page names them on its own');
select is((select body || ' · ' || deep_link from public.unnamed_follow_alert_words(
  '@maya saved your post', '/showcase/p1')),
  '@maya saved your post · /showcase/p1',
  'and another alert''s words come back as they are');

-- Still one trigger on blocks (post_save_alerts.test.sql counts it too), and
-- nothing here is callable through the Data API.
reset role;
select is(
  (select count(*) from pg_trigger
    where tgrelid = 'public.user_blocks'::regclass and not tgisinternal),
  1::bigint, 'one trigger on blocks does all of it');
select ok(not has_function_privilege('anon', 'public.unnamed_follow_alert_words(text, text)', 'EXECUTE'),
  'anon cannot call the words function');
select ok(not has_function_privilege('authenticated', 'public.unnamed_follow_alert_words(text, text)', 'EXECUTE'),
  'nor can a signed-in account');
select ok(not has_function_privilege('authenticated', 'public.unname_follow_alert_that_cannot_name()', 'EXECUTE'),
  'nor the alert trigger''s function');
select ok(not has_function_privilege('authenticated', 'public.remove_follows_for_user_block()', 'EXECUTE'),
  'nor the block trigger''s function');

select * from finish();
rollback;
