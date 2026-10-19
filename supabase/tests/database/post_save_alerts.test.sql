-- A named save's alert belongs to its save: written only while the save
-- stands, to the post's owner, naming only a saver told on record by a handle
-- they chose; gone with the save (unsave, toggle, the saver's account, the
-- post deleted or tombstoned), never written or kept across a block either
-- way round; and its push delivery outlives it for the receipt, never to be
-- retried. Fixtures roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id,email,aud,role,is_anonymous,created_at) values
('e6100001-0000-4000-8000-000000000001','save-alert-creator@example.invalid','authenticated','authenticated',false,now()),
('e6100002-0000-4000-8000-000000000002','save-alert-saver@example.invalid','authenticated','authenticated',false,now()),
('e6100003-0000-4000-8000-000000000003','save-alert-other@example.invalid','authenticated','authenticated',false,now()),
('e6100004-0000-4000-8000-000000000004','save-alert-third@example.invalid','authenticated','authenticated',false,now());
insert into auth.sessions (id,user_id,created_at,updated_at) values
('e6200000-0000-4000-8000-000000000001','e6100001-0000-4000-8000-000000000001',now(),now()),
('e6200000-0000-4000-8000-000000000002','e6100002-0000-4000-8000-000000000002',now(),now());
insert into public.posts (id,user_id,visibility,category,source_kind,title,output_url) values
('e6300000-0000-4000-8000-000000000001','e6100001-0000-4000-8000-000000000001','public','image','external','Saved fixture','generated_images/save-alert.png'),
('e6300000-0000-4000-8000-000000000002','e6100001-0000-4000-8000-000000000001','public','image','external','Second fixture','generated_images/save-alert-2.png'),
('e6300000-0000-4000-8000-000000000003','e6100003-0000-4000-8000-000000000003','public','image','external','Other fixture','generated_images/save-alert-3.png'),
('e6300000-0000-4000-8000-000000000004','e6100001-0000-4000-8000-000000000001','public','image','external','Hidden fixture','generated_images/save-alert-4.png'),
('e6300000-0000-4000-8000-000000000005','e6100001-0000-4000-8000-000000000001','public','image','external','Tombstone fixture','generated_images/save-alert-5.png');

-- The saver chose a handle and was told on record; the third account was told
-- by the placeholder every account starts with; the other account chose one
-- and was never told.
update public.profiles set username = 'maya', saver_notice_seen_at = now()
where id = 'e6100002-0000-4000-8000-000000000002';
update public.profiles set username = 'creator-0a1b2c3d', saver_notice_seen_at = now()
where id = 'e6100004-0000-4000-8000-000000000004';
update public.profiles set username = 'lee', saver_notice_seen_at = null
where id = 'e6100003-0000-4000-8000-000000000003';

set local role service_role;

-- What the server reads back (src/lib/mobile-notifications.ts): nameable,
-- wasCreated and the written row under notification.
select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002',true)),
  'the saver saves the post');
create temporary table first_write on commit drop as
  select public.create_post_save_alert(
    'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002',
    'It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
  ) as result;
select is((select (result->>'nameable')::boolean from first_write), true, 'a saver told on record, by a handle they chose, may be named');
select is((select (result->>'wasCreated')::boolean from first_write), true, 'a named alert is written while the save stands');
select is((select result->'notification'->>'title' from first_write), '@maya saved your post',
  'its title is built from the handle on record, not taken from the caller');
select is((select result->'notification'->>'user_id' from first_write)::uuid, 'e6100001-0000-4000-8000-000000000001'::uuid,
  'and it goes to the post''s owner');
select is((select result->'notification'->>'id' from first_write)::uuid,
  (select id from public.mobile_notifications
    where save_user_id='e6100002-0000-4000-8000-000000000002' and save_post_id='e6300000-0000-4000-8000-000000000001'),
  'and it is the row that belongs to the save');
select is((public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002',
  'It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
)->>'wasCreated')::boolean, false, 'a second write while it stands writes nothing new');

-- Who may not be named: the caller falls back to "Someone".
select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000001','e6100003-0000-4000-8000-000000000003',true)), 'the other account saves too');
select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000001','e6100004-0000-4000-8000-000000000004',true)), 'and so does the third');
select is(public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000001','e6100003-0000-4000-8000-000000000003','b',null),
  '{"nameable": false, "wasCreated": false, "notification": null}'::jsonb,
  'a saver never told on record is not named, whatever handle they chose');
select is(public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000001','e6100004-0000-4000-8000-000000000004','b',null),
  '{"nameable": false, "wasCreated": false, "notification": null}'::jsonb,
  'nor one told, by the placeholder handle they never chose');
select is((public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000001','e6100001-0000-4000-8000-000000000001','b',null)->>'wasCreated')::boolean,
  false, 'nobody is told of their own save');
select is((select count(*) from public.mobile_notifications where save_user_id is not null), 1::bigint,
  'none of those wrote anything');

-- Its push delivery, as the first send reserves it, with a retry still due.
insert into public.mobile_push_deliveries (id,notification_id,user_id,expo_push_token,platform,send_status,receipt_status,attempt_count)
select 'e6400000-0000-4000-8000-000000000001', id, 'e6100001-0000-4000-8000-000000000001','ExponentPushToken[save-alert]','ios','error','error',1
from public.mobile_notifications where save_post_id='e6300000-0000-4000-8000-000000000001';

reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e6100001-0000-4000-8000-000000000001","role":"authenticated","session_id":"e6200000-0000-4000-8000-000000000001","is_anonymous":false}',true);
select is((select count(*) from public.mobile_notifications), 1::bigint, 'the creator reads the named alert, unfiltered');

reset role;
set local role service_role;
select is((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002',false)), false,
  'the saver unsaves the post');
select is((select count(*) from public.mobile_notifications where user_id='e6100001-0000-4000-8000-000000000001'),
  0::bigint, 'the unsave removes the alert in its own transaction');
select is((select count(*) from public.mobile_push_deliveries where id='e6400000-0000-4000-8000-000000000001'),
  1::bigint, 'its delivery stays, for the receipt');
select is((select notification_id from public.mobile_push_deliveries where id='e6400000-0000-4000-8000-000000000001'),
  null, 'with no alert left');
select is(public.claim_mobile_push_retry('e6400000-0000-4000-8000-000000000001', 1), null::uuid,
  'and a retry of it can no longer be claimed');
select is((select attempt_count from public.mobile_push_deliveries where id='e6400000-0000-4000-8000-000000000001'),
  1, 'nor spend an attempt');

reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e6100001-0000-4000-8000-000000000001","role":"authenticated","session_id":"e6200000-0000-4000-8000-000000000001","is_anonymous":false}',true);
select is((select count(*) from public.mobile_notifications), 0::bigint,
  'and the creator, reading unfiltered through the Data API, finds nothing of it');

reset role;
set local role service_role;
select is((public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002',
  'It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
)->>'wasCreated')::boolean, false, 'no named alert is written for a save already gone');
select is((select count(*) from public.mobile_notifications where user_id='e6100001-0000-4000-8000-000000000001'),
  0::bigint, 'not even one that would fail later');

-- A retry of a delivery whose alert stands is claimed as ever.
select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002',true)),
  'the saver saves the post again');
select is((public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002',
  'It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
)->>'wasCreated')::boolean, true, 'a save made again is announced again');
insert into public.mobile_push_deliveries (id,notification_id,user_id,expo_push_token,platform,send_status,receipt_status,attempt_count)
select 'e6400000-0000-4000-8000-000000000002', id, 'e6100001-0000-4000-8000-000000000001','ExponentPushToken[save-alert]','ios','error','error',1
from public.mobile_notifications where save_post_id='e6300000-0000-4000-8000-000000000001';
select isnt(public.claim_mobile_push_retry('e6400000-0000-4000-8000-000000000002', 1), null::uuid,
  'a retry whose alert stands is claimed');

-- An unsave through the legacy toggle takes the alert too.
select is(public.toggle_post_save('e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002'),
  false, 'a toggle takes the save off');
select is((select count(*) from public.mobile_notifications where user_id='e6100001-0000-4000-8000-000000000001'),
  0::bigint, 'and the alert with it');
select is(public.toggle_post_save('e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002'),
  true, 'a toggle saves it again');

-- A block, either way round, removes the alerts naming one to the other, and
-- none is written across it; alerts between other accounts stand.
select is((public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','b',null)->>'wasCreated')::boolean,
  true, 'the save made by toggle is announced');
select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000003','e6100002-0000-4000-8000-000000000002',true)),
  'the saver saves the other account''s post as well');
select is((public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000003','e6100002-0000-4000-8000-000000000002','b',null)->>'wasCreated')::boolean,
  true, 'and that account is told of it');
insert into public.user_blocks (blocker_user_id, blocked_user_id)
values ('e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002');
select is((select count(*) from public.mobile_notifications where user_id='e6100001-0000-4000-8000-000000000001'),
  0::bigint, 'the creator blocking the saver removes the alert naming the saver');
select is((select count(*) from public.mobile_notifications where user_id='e6100003-0000-4000-8000-000000000003'),
  1::bigint, 'and leaves the alert naming them to a third account');
select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000002','e6100002-0000-4000-8000-000000000002',true)),
  'a save made across the block stands');
select is((public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000002','e6100002-0000-4000-8000-000000000002','b',null)->>'wasCreated')::boolean,
  false, 'but no alert names the saver to the creator across it');
delete from public.user_blocks
where blocker_user_id='e6100001-0000-4000-8000-000000000001' and blocked_user_id='e6100002-0000-4000-8000-000000000002';

select is((public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000002','e6100002-0000-4000-8000-000000000002','b',null)->>'wasCreated')::boolean,
  true, 'once unblocked, a save that stands may be announced');
insert into public.user_blocks (blocker_user_id, blocked_user_id)
values ('e6100002-0000-4000-8000-000000000002','e6100001-0000-4000-8000-000000000001');
select is((select count(*) from public.mobile_notifications where user_id='e6100001-0000-4000-8000-000000000001'),
  0::bigint, 'the saver blocking the creator removes it the other way round');
select is((public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','b',null)->>'wasCreated')::boolean,
  false, 'and none is written across that block either');
delete from public.user_blocks
where blocker_user_id='e6100002-0000-4000-8000-000000000002' and blocked_user_id='e6100001-0000-4000-8000-000000000001';

-- A post out of public view: the save comes off all the same, and the alert
-- with it; saving it still needs it public.
select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000004','e6100002-0000-4000-8000-000000000002',true)),
  'the saver saves a post');
select is((public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000004','e6100002-0000-4000-8000-000000000002','b',null)->>'wasCreated')::boolean,
  true, 'and the creator is told');
reset role;
update public.posts set visibility = 'private' where id = 'e6300000-0000-4000-8000-000000000004';
set local role service_role;
select is((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000004','e6100002-0000-4000-8000-000000000002',false)), false,
  'the saver takes the save off the post made private');
select is((select count(*) from public.mobile_notifications where save_post_id='e6300000-0000-4000-8000-000000000004'),
  0::bigint, 'and the alert naming them goes with it');
select is((select save_count from public.posts where id='e6300000-0000-4000-8000-000000000004'), 0,
  'the post''s count with it');
select throws_ok($$ select * from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000004','e6100002-0000-4000-8000-000000000002',true) $$,
  'P0001', 'Post is private or not found', 'a private post still cannot be saved');
select throws_ok($$ select public.toggle_post_save(
  'e6300000-0000-4000-8000-000000000004','e6100002-0000-4000-8000-000000000002') $$,
  'P0001', 'Post is private or not found', 'nor toggled into a save');

-- A post deleted but kept for its buyers loses its saves, and their alerts.
select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000005','e6100002-0000-4000-8000-000000000002',true)),
  'the saver saves the post its creator will delete');
select is((public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000005','e6100002-0000-4000-8000-000000000002','b',null)->>'wasCreated')::boolean,
  true, 'and the creator is told');
reset role;
-- As post-delete-service.ts tombstones it.
update public.posts
set tombstoned_at = now(), archived_at = now(),
  archived_by_user_id = 'e6100001-0000-4000-8000-000000000001', visibility = 'private'
where id = 'e6300000-0000-4000-8000-000000000005';
set local role service_role;
select is((select count(*) from public.post_saves where post_id='e6300000-0000-4000-8000-000000000005'),
  0::bigint, 'tombstoning a post takes its saves');
select is((select count(*) from public.mobile_notifications where save_post_id='e6300000-0000-4000-8000-000000000005'),
  0::bigint, 'and the alerts naming its savers');
select is((select save_count from public.posts where id='e6300000-0000-4000-8000-000000000005'), 0,
  'and its count');

-- The saver's account going, and the post going, take the alert with the save.
select is((public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','b',null)->>'wasCreated')::boolean,
  true, 'once unblocked again, a save that stands may be announced');
delete from public.posts where id='e6300000-0000-4000-8000-000000000002';
select is((select count(*) from public.mobile_notifications
  where save_post_id='e6300000-0000-4000-8000-000000000002'), 0::bigint,
  'deleting a post removes its save and the alert with it');
select is((select count(*) from public.mobile_notifications
  where save_post_id='e6300000-0000-4000-8000-000000000001'), 1::bigint,
  'and leaves the alert of another post alone');

-- The recipient's account going takes their alerts and their deliveries in
-- one statement: the key on the account and the key on the alert both act.
insert into public.mobile_push_deliveries (id,notification_id,user_id,expo_push_token,platform,send_status,receipt_status,attempt_count)
select 'e6400000-0000-4000-8000-000000000003', id, 'e6100003-0000-4000-8000-000000000003','ExponentPushToken[other]','ios','error','error',1
from public.mobile_notifications where user_id='e6100003-0000-4000-8000-000000000003';
reset role;
select lives_ok($$ delete from auth.users where id='e6100003-0000-4000-8000-000000000003' $$,
  'deleting an account that holds a named alert with a delivery succeeds');
select is((select count(*) from public.mobile_notifications where user_id='e6100003-0000-4000-8000-000000000003'),
  0::bigint, 'its alerts go');
select is((select count(*) from public.mobile_push_deliveries where id='e6400000-0000-4000-8000-000000000003'),
  0::bigint, 'and its deliveries');

delete from auth.users where id='e6100002-0000-4000-8000-000000000002';
set local role service_role;
select is((select count(*) from public.mobile_notifications where save_user_id is not null),
  0::bigint, 'deleting the saver''s account removes every alert naming them');

-- A grouped "Someone" row keeps no actor, whatever its caller passes.
select is((public.upsert_mobile_notification(
  'e6100001-0000-4000-8000-000000000001','e6100004-0000-4000-8000-000000000004','post_saved','social',
  'Someone saved your post','It is in their saved media now.',null,'post','e6300000-0000-4000-8000-000000000001',
  null,'post-social:post_saved:e6100001-0000-4000-8000-000000000001:e6300000-0000-4000-8000-000000000001:1'
)->'notification'->>'actor_user_id'), null, 'a grouped save row stores no actor, even when passed one');
select is((public.upsert_mobile_notification(
  'e6100001-0000-4000-8000-000000000001','e6100004-0000-4000-8000-000000000004','post_saved','social',
  'Someone saved your post','It is in their saved media now.',null,'post','e6300000-0000-4000-8000-000000000001',
  null,'post-social:post_saved:e6100001-0000-4000-8000-000000000001:e6300000-0000-4000-8000-000000000001:1'
)->'notification'->>'actor_user_id'), null, 'nor when it groups a later save');

-- The pair lock comes before what it guards, in the live definitions, and it
-- is the one lock a block takes.
select ok(
  position('pg_advisory_xact_lock' in pg_get_functiondef('public.create_post_save_alert(uuid,uuid,text,text)'::regprocedure))
    < position('user_blocks' in pg_get_functiondef('public.create_post_save_alert(uuid,uuid,text,text)'::regprocedure)),
  'the alert writer takes the pair lock before it reads blocks');
select ok(
  position('''follow-block:''' in pg_get_functiondef('public.create_post_save_alert(uuid,uuid,text,text)'::regprocedure)) > 0,
  'by the key a block takes');
select ok(
  position('pg_advisory_xact_lock' in pg_get_functiondef('public.remove_follows_for_user_block()'::regprocedure))
    < position('DELETE FROM public.mobile_notifications' in pg_get_functiondef('public.remove_follows_for_user_block()'::regprocedure)),
  'the block trigger takes it before it removes alerts');
select is(
  (select count(*) from pg_trigger
    where tgrelid = 'public.user_blocks'::regclass and not tgisinternal),
  1::bigint, 'one trigger on blocks does all of it');
select is(
  (select confdeltype::text from pg_constraint where conname = 'mobile_push_deliveries_notification_id_fkey'),
  'n', 'a delivery''s alert going sets it to NULL rather than deleting it');
select ok(
  (select convalidated from pg_constraint where conname = 'mobile_push_deliveries_notification_id_fkey'),
  'and that key is checked for every row');
select is(
  (select count(*) from pg_constraint
    where conrelid = 'public.mobile_push_deliveries'::regclass and contype = 'f'
      and confrelid = 'public.mobile_notifications'::regclass),
  1::bigint, 'and that is the only key from deliveries to alerts');

reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e6100001-0000-4000-8000-000000000001","role":"authenticated","session_id":"e6200000-0000-4000-8000-000000000001","is_anonymous":false}',true);
select throws_ok($$ select public.create_post_save_alert(
  'e6300000-0000-4000-8000-000000000001','e6100004-0000-4000-8000-000000000004','forged',null) $$,
  '42501', null, 'a signed-in account cannot write a named alert');
select throws_ok($$ update public.profiles set saver_notice_seen_at = now()
  where id='e6100001-0000-4000-8000-000000000001' $$,
  '42501', null, 'an account cannot put a telling on record through the Data API');

select * from finish();
rollback;
