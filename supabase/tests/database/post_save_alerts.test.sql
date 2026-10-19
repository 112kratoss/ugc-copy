-- A named save's alert belongs to its save: written only while the save
-- stands, gone with it (unsave, the saver's account, the post), never written
-- or kept across a block, and its push delivery outlives it for the receipt.
-- Fixtures roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id,email,aud,role,is_anonymous,created_at) values
('e6100001-0000-4000-8000-000000000001','save-alert-creator@example.invalid','authenticated','authenticated',false,now()),
('e6100002-0000-4000-8000-000000000002','save-alert-saver@example.invalid','authenticated','authenticated',false,now()),
('e6100003-0000-4000-8000-000000000003','save-alert-other@example.invalid','authenticated','authenticated',false,now());
insert into auth.sessions (id,user_id,created_at,updated_at) values
('e6200000-0000-4000-8000-000000000001','e6100001-0000-4000-8000-000000000001',now(),now()),
('e6200000-0000-4000-8000-000000000002','e6100002-0000-4000-8000-000000000002',now(),now());
insert into public.posts (id,user_id,visibility,category,source_kind,title,output_url) values
('e6300000-0000-4000-8000-000000000001','e6100001-0000-4000-8000-000000000001','public','image','external','Saved fixture','generated_images/save-alert.png'),
('e6300000-0000-4000-8000-000000000002','e6100001-0000-4000-8000-000000000001','public','image','external','Second fixture','generated_images/save-alert-2.png');

set local role service_role;

-- What the server reads back (src/lib/mobile-notifications.ts): wasCreated and
-- the written row under notification.
select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002',true)),
  'the saver saves the post');
create temporary table first_write on commit drop as
  select public.create_post_save_alert(
    'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000001',
    '@maya saved your post','It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
  ) as result;
select is((select (result->>'wasCreated')::boolean from first_write), true, 'a named alert is written while the save stands');
select is((select result->'notification'->>'title' from first_write), '@maya saved your post',
  'the written row comes back under notification');
select is((select result->'notification'->>'id' from first_write)::uuid,
  (select id from public.mobile_notifications
    where save_user_id='e6100002-0000-4000-8000-000000000002' and save_post_id='e6300000-0000-4000-8000-000000000001'),
  'and it is the row that belongs to the save');
select is((public.create_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000001',
  '@maya saved your post','It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
)->>'wasCreated')::boolean, false, 'a second write while it stands writes nothing new');

-- Its push delivery, as the first send reserves it.
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
select is((select notification_id from public.mobile_push_deliveries where id='e6400000-0000-4000-8000-000000000001'),
  null, 'its delivery stays, for the receipt, with no alert left to retry');

reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e6100001-0000-4000-8000-000000000001","role":"authenticated","session_id":"e6200000-0000-4000-8000-000000000001","is_anonymous":false}',true);
select is((select count(*) from public.mobile_notifications), 0::bigint,
  'and the creator, reading unfiltered through the Data API, finds nothing of it');

reset role;
set local role service_role;
select is((public.create_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000001',
  '@maya saved your post','It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
)->>'wasCreated')::boolean, false, 'no named alert is written for a save already gone');
select is((select count(*) from public.mobile_notifications where user_id='e6100001-0000-4000-8000-000000000001'),
  0::bigint, 'not even one that would fail later');

select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002',true)),
  'the saver saves the post again');
select is((public.create_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000001',
  '@maya saved your post','It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
)->>'wasCreated')::boolean, true, 'a save made again is announced again');

-- A block, either way round, removes the alerts naming one to the other, and
-- none is written across it.
insert into public.user_blocks (blocker_user_id, blocked_user_id)
values ('e6100002-0000-4000-8000-000000000002','e6100001-0000-4000-8000-000000000001');
select is((select count(*) from public.mobile_notifications where user_id='e6100001-0000-4000-8000-000000000001'),
  0::bigint, 'the saver blocking the creator removes the alert naming the saver');
select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000002','e6100002-0000-4000-8000-000000000002',true)),
  'a save made across the block stands');
select is((public.create_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000002',
  '@maya saved your post','It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000002'
)->>'wasCreated')::boolean, false, 'but no alert names the saver across it');
delete from public.user_blocks
where blocker_user_id='e6100002-0000-4000-8000-000000000002' and blocked_user_id='e6100001-0000-4000-8000-000000000001';

-- The saver's account going, and the post going, take the alert with the save.
select is((public.create_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000001',
  '@maya saved your post','It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
)->>'wasCreated')::boolean, true, 'once unblocked, a save that stands may be announced again');
select is((public.create_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000002',
  '@maya saved your post','It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000002'
)->>'wasCreated')::boolean, true, 'the save made across the block too');
delete from public.posts where id='e6300000-0000-4000-8000-000000000002';
select is((select count(*) from public.mobile_notifications
  where save_post_id='e6300000-0000-4000-8000-000000000002'), 0::bigint,
  'deleting a post removes its save and the alert with it');
select is((select count(*) from public.mobile_notifications
  where save_post_id='e6300000-0000-4000-8000-000000000001'), 1::bigint,
  'and leaves the alert of another post alone');
reset role;
delete from auth.users where id='e6100002-0000-4000-8000-000000000002';
set local role service_role;
select is((select count(*) from public.mobile_notifications where user_id='e6100001-0000-4000-8000-000000000001'),
  0::bigint, 'deleting the saver''s account removes every alert naming them');

-- A grouped "Someone" row keeps no actor, whatever its caller passes.
select is((public.upsert_mobile_notification(
  'e6100001-0000-4000-8000-000000000001','e6100003-0000-4000-8000-000000000003','post_saved','social',
  'Someone saved your post','It is in their saved media now.',null,'post','e6300000-0000-4000-8000-000000000001',
  null,'post-social:post_saved:e6100001-0000-4000-8000-000000000001:e6300000-0000-4000-8000-000000000001:1'
)->'notification'->>'actor_user_id'), null, 'a grouped save row stores no actor, even when passed one');
select is((public.upsert_mobile_notification(
  'e6100001-0000-4000-8000-000000000001','e6100003-0000-4000-8000-000000000003','post_saved','social',
  'Someone saved your post','It is in their saved media now.',null,'post','e6300000-0000-4000-8000-000000000001',
  null,'post-social:post_saved:e6100001-0000-4000-8000-000000000001:e6300000-0000-4000-8000-000000000001:1'
)->'notification'->>'actor_user_id'), null, 'nor when it groups a later save');

-- The pair lock comes before what it guards, in the live definitions.
select ok(
  position('pg_advisory_xact_lock' in pg_get_functiondef('public.create_post_save_alert(uuid,uuid,uuid,text,text,text)'::regprocedure))
    < position('user_blocks' in pg_get_functiondef('public.create_post_save_alert(uuid,uuid,uuid,text,text,text)'::regprocedure)),
  'the alert writer takes the pair lock before it reads blocks');
select ok(
  position('pg_advisory_xact_lock' in pg_get_functiondef('public.remove_post_save_alerts_for_user_block()'::regprocedure))
    < position('DELETE FROM' in pg_get_functiondef('public.remove_post_save_alerts_for_user_block()'::regprocedure)),
  'the block trigger takes it before it removes alerts');
select is(
  (select confdeltype::text from pg_constraint where conname = 'mobile_push_deliveries_notification_id_fkey'),
  'n', 'a delivery''s alert going sets it to NULL rather than deleting it');
select is(
  (select count(*) from pg_constraint
    where conrelid = 'public.mobile_push_deliveries'::regclass and contype = 'f'
      and confrelid = 'public.mobile_notifications'::regclass),
  1::bigint, 'and that is the only key from deliveries to alerts');

reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e6100001-0000-4000-8000-000000000001","role":"authenticated","session_id":"e6200000-0000-4000-8000-000000000001","is_anonymous":false}',true);
select throws_ok($$ select public.create_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100003-0000-4000-8000-000000000003','e6300000-0000-4000-8000-000000000001','forged','forged',null) $$,
  '42501', null, 'a signed-in account cannot write a named alert');
select throws_ok($$ update public.profiles set saver_notice_seen_at = now()
  where id='e6100001-0000-4000-8000-000000000001' $$,
  '42501', null, 'an account cannot put a telling on record through the Data API');

select * from finish();
rollback;
