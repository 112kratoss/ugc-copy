-- A named save's alert follows its save: written only while the save stands,
-- taken back only once it is gone, hidden rather than deleted, and brought
-- back by a save made again. Fixtures roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id,email,aud,role,is_anonymous,created_at) values
('e6100001-0000-4000-8000-000000000001','save-alert-creator@example.invalid','authenticated','authenticated',false,now()),
('e6100002-0000-4000-8000-000000000002','save-alert-saver@example.invalid','authenticated','authenticated',false,now());
insert into auth.sessions (id,user_id,created_at,updated_at) values
('e6200000-0000-4000-8000-000000000001','e6100001-0000-4000-8000-000000000001',now(),now()),
('e6200000-0000-4000-8000-000000000002','e6100002-0000-4000-8000-000000000002',now(),now());
insert into public.posts (id,user_id,visibility,category,source_kind,title,output_url) values
('e6300000-0000-4000-8000-000000000001','e6100001-0000-4000-8000-000000000001','public','image','external','Saved fixture','generated_images/save-alert.png');

set local role service_role;

select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002',true)),
  'the saver saves the post');

select is((public.create_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000001',
  '@maya saved your post','It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
)->>'created')::boolean, true, 'a named alert is written while the save stands');
select is((public.create_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000001',
  '@maya saved your post','It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
)->>'created')::boolean, false, 'a second write while it stands writes nothing new');
select is(public.withdraw_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000001'),
  0, 'a take-back while the save stands takes nothing back');

select is((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002',false)), false,
  'the saver unsaves the post');
select is(public.withdraw_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000001'),
  1, 'once the save is gone, its alert is taken back');
select isnt((select withdrawn_at from public.mobile_notifications
  where user_id='e6100001-0000-4000-8000-000000000001'
    and dedupe_key='post-save:e6100002-0000-4000-8000-000000000002:e6300000-0000-4000-8000-000000000001'),
  null, 'taken back by hiding it, not deleting it');
select is((public.create_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000001',
  '@maya saved your post','It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
)->>'created')::boolean, false, 'no named alert is written for a save already gone');

select ok((select is_saved from public.set_post_save_state(
  'e6300000-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002',true)),
  'the saver saves the post again');
select is((public.create_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000001',
  '@maya saved your post','It is in their saved media now.','/showcase/e6300000-0000-4000-8000-000000000001'
)->>'created')::boolean, true, 'a save made again brings the alert back as new');
select is((select count(*) from public.mobile_notifications
  where user_id='e6100001-0000-4000-8000-000000000001' and withdrawn_at is null and is_read = false),
  1::bigint, 'one unread alert, shown again');

select is(public.withdraw_post_save_alerts_between(
  'e6100002-0000-4000-8000-000000000002','e6100001-0000-4000-8000-000000000001'),
  1, 'a block between the two takes the alert naming the saver back');

reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e6100001-0000-4000-8000-000000000001","role":"authenticated","session_id":"e6200000-0000-4000-8000-000000000001","is_anonymous":false}',true);
select is((select count(*) from public.mobile_notifications where withdrawn_at is null),
  0::bigint, 'the creator''s inbox read, filtered as the API filters it, shows no taken-back alert');
select throws_ok($$ select public.create_post_save_alert(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002','e6300000-0000-4000-8000-000000000001','forged','forged',null) $$,
  '42501', null, 'a signed-in account cannot write a named alert');
select throws_ok($$ select public.withdraw_post_save_alerts_between(
  'e6100001-0000-4000-8000-000000000001','e6100002-0000-4000-8000-000000000002') $$,
  '42501', null, 'a signed-in account cannot take alerts back');
select throws_ok($$ update public.profiles set saver_notice_seen_at = now()
  where id='e6100001-0000-4000-8000-000000000001' $$,
  '42501', null, 'an account cannot put a telling on record through the Data API');

reset role;
set local role service_role;
select ok((public.prune_mobile_notification_retention(now() + interval '1 day', now() - interval '1 day', 100)
  ->>'notificationsDeleted')::integer >= 1,
  'retention deletes a taken-back alert once its deliveries are past retention');
select is((select count(*) from public.mobile_notifications where user_id='e6100001-0000-4000-8000-000000000001'),
  0::bigint, 'and nothing of it is left');

select * from finish();
rollback;
