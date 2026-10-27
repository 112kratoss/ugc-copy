-- A sale's alert names its buyer only while it may (20261020053858): written
-- across a block, either way round, it is stored without the name; a block made
-- after it, either way round, takes the name out; so does the buyer's account
-- being deleted. Alerts that name no one, alerts naming anyone else, and other
-- alert types keep their words. Fixtures roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- The seller, and buyers maya, lee, ana, sam and kai.
insert into auth.users (id,email,aud,role,is_anonymous,created_at) values
('b4990001-0000-4000-8000-000000000001','sale-alert-seller@example.invalid','authenticated','authenticated',false,now()),
('b4990002-0000-4000-8000-000000000002','sale-alert-maya@example.invalid','authenticated','authenticated',false,now()),
('b4990003-0000-4000-8000-000000000003','sale-alert-lee@example.invalid','authenticated','authenticated',false,now()),
('b4990004-0000-4000-8000-000000000004','sale-alert-ana@example.invalid','authenticated','authenticated',false,now()),
('b4990005-0000-4000-8000-000000000005','sale-alert-sam@example.invalid','authenticated','authenticated',false,now()),
('b4990006-0000-4000-8000-000000000006','sale-alert-kai@example.invalid','authenticated','authenticated',false,now());

set local role service_role;

-- What the server writes for a buyer with a handle (sellerUnlockWords in
-- src/lib/mobile-notifications.ts), to the seller, with the buyer as actor.
create temporary table sale_alert (id uuid, buyer uuid, title text, body text, post text) on commit drop;
insert into sale_alert values
('b4994000-0000-4000-8000-000000000001','b4990002-0000-4000-8000-000000000002','You made a sale','@maya bought the resources attached to your post.','p1'),
('b4994000-0000-4000-8000-000000000002','b4990003-0000-4000-8000-000000000003','@lee opened your free resources','They can view the prompt, files, or workflow now.','p1'),
('b4994000-0000-4000-8000-000000000005','b4990006-0000-4000-8000-000000000006','You made a sale','@kai bought the resources attached to your post.','p1'),
('b4994000-0000-4000-8000-000000000006','b4990006-0000-4000-8000-000000000006','@kai opened your free resources','They can view the prompt, files, or workflow now.','p2'),
-- A buyer with no handle: the words already name no one.
('b4994000-0000-4000-8000-000000000007','b4990002-0000-4000-8000-000000000002','You made a sale','A creator bought the resources attached to your post.','p3');

create function pg_temp.write_sale_alert(p_id uuid) returns void language sql as $$
  insert into public.mobile_notifications (id,user_id,actor_user_id,type,category,title,body,object_type,object_id,dedupe_key)
  select id, 'b4990001-0000-4000-8000-000000000001', buyer, 'post_resource_unlocked', 'commerce', title, body,
         'post', post, 'post-resource-sale:' || post || ':' || buyer::text
  from sale_alert where id = p_id
$$;

create function pg_temp.words(p_id uuid) returns text language sql as $$
  select title || ' · ' || body from public.mobile_notifications where id = p_id
$$;

select pg_temp.write_sale_alert(id) from sale_alert
where id in ('b4994000-0000-4000-8000-000000000001','b4994000-0000-4000-8000-000000000002',
             'b4994000-0000-4000-8000-000000000005','b4994000-0000-4000-8000-000000000006',
             'b4994000-0000-4000-8000-000000000007');

select is(pg_temp.words('b4994000-0000-4000-8000-000000000001'),
  'You made a sale · @maya bought the resources attached to your post.',
  'a sale between accounts with no block names its buyer');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000002'),
  '@lee opened your free resources · They can view the prompt, files, or workflow now.',
  'and so does a free open');

-- 1. Written across a block, either way round.
insert into public.user_blocks (blocker_user_id, blocked_user_id) values
('b4990004-0000-4000-8000-000000000004','b4990001-0000-4000-8000-000000000001'),
('b4990001-0000-4000-8000-000000000001','b4990005-0000-4000-8000-000000000005');
insert into sale_alert values
('b4994000-0000-4000-8000-000000000003','b4990004-0000-4000-8000-000000000004','You made a sale','@ana bought the resources attached to your post.','p1'),
('b4994000-0000-4000-8000-000000000004','b4990005-0000-4000-8000-000000000005','@sam opened your free resources','They can view the prompt, files, or workflow now.','p1');
select pg_temp.write_sale_alert('b4994000-0000-4000-8000-000000000003');
select pg_temp.write_sale_alert('b4994000-0000-4000-8000-000000000004');

select is(pg_temp.words('b4994000-0000-4000-8000-000000000003'),
  'You made a sale · A creator bought the resources attached to your post.',
  'a sale written after the buyer blocked the seller is stored without the name');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000004'),
  'Someone opened your free resources · A creator opened the resources attached to your post.',
  'a free open written after the seller blocked the buyer is stored without the name');
select is((select actor_user_id from public.mobile_notifications where id='b4994000-0000-4000-8000-000000000003'),
  'b4990004-0000-4000-8000-000000000004'::uuid, 'and keeps its buyer, as an alert with no handle to name does');

-- 2. A block made after the alert, either way round.
insert into public.user_blocks (blocker_user_id, blocked_user_id) values
('b4990001-0000-4000-8000-000000000001','b4990003-0000-4000-8000-000000000003');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000002'),
  'Someone opened your free resources · A creator opened the resources attached to your post.',
  'the seller blocking the buyer afterwards takes the name out of a free open');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000001'),
  'You made a sale · @maya bought the resources attached to your post.',
  'and leaves the alerts naming anyone else');

insert into public.user_blocks (blocker_user_id, blocked_user_id) values
('b4990002-0000-4000-8000-000000000002','b4990001-0000-4000-8000-000000000001');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000001'),
  'You made a sale · A creator bought the resources attached to your post.',
  'the buyer blocking the seller afterwards takes the name out of a sale');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000007'),
  'You made a sale · A creator bought the resources attached to your post.',
  'an alert that named no one is left as it was');

-- 3. The buyer's account deleted. An alert of another type naming them keeps
-- its words, even words a sale's alert would lose.
insert into public.mobile_notifications (id,user_id,actor_user_id,type,category,title,body,object_type,object_id) values
('b4994000-0000-4000-8000-000000000008','b4990001-0000-4000-8000-000000000001','b4990006-0000-4000-8000-000000000006',
 'post_remixed','social','Someone remixed your post','@kai bought the resources attached to your post.','post','p1');
reset role;
select lives_ok($$ delete from auth.users where id='b4990006-0000-4000-8000-000000000006' $$,
  'deleting a buyer''s account succeeds');
set local role service_role;
select is((select actor_user_id from public.mobile_notifications where id='b4994000-0000-4000-8000-000000000005'),
  null::uuid, 'the foreign key clears the buyer from their sale''s alert');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000005'),
  'You made a sale · A creator bought the resources attached to your post.',
  'and the name goes with them from a sale');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000006'),
  'Someone opened your free resources · A creator opened the resources attached to your post.',
  'and from a free open');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000008'),
  'Someone remixed your post · @kai bought the resources attached to your post.',
  'another alert type is not this migration''s to change');

-- 4. The words written since 2026-10-27 (20261027180743) name the recipe; a
-- block takes the name out of them as it did of the old words, which rows
-- written before keep (above).
insert into sale_alert values
('b4994000-0000-4000-8000-000000000009','b4990004-0000-4000-8000-000000000004','You made a sale','@ana bought your recipe.','p4'),
('b4994000-0000-4000-8000-000000000010','b4990005-0000-4000-8000-000000000005','@sam got your free recipe','They have the prompt and files now.','p4'),
('b4994000-0000-4000-8000-000000000011','b4990002-0000-4000-8000-000000000002','You made a sale','@maya bought your recipe.','p5');
select pg_temp.write_sale_alert('b4994000-0000-4000-8000-000000000009');
select pg_temp.write_sale_alert('b4994000-0000-4000-8000-000000000010');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000009'),
  'You made a sale · A creator bought your recipe.',
  'a sale in the recipe words, written across a block, is stored without the name');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000010'),
  'Someone got your free recipe · A creator got the free recipe on your post.',
  'and so is a free open in the recipe words');

-- Between accounts with no block (maya's block of the seller is removed first).
delete from public.user_blocks
where blocker_user_id = 'b4990002-0000-4000-8000-000000000002' and blocked_user_id = 'b4990001-0000-4000-8000-000000000001';
select pg_temp.write_sale_alert('b4994000-0000-4000-8000-000000000011');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000011'),
  'You made a sale · @maya bought your recipe.',
  'a sale in the recipe words between accounts with no block names its buyer');
insert into public.user_blocks (blocker_user_id, blocked_user_id) values
('b4990002-0000-4000-8000-000000000002','b4990001-0000-4000-8000-000000000001');
select is(pg_temp.words('b4994000-0000-4000-8000-000000000011'),
  'You made a sale · A creator bought your recipe.',
  'and a block made afterwards takes the name out of it');

-- The words function returns words that name no one unchanged.
select is((select title || ' · ' || body from public.unnamed_sale_alert_words(
  'You made a sale', 'A creator bought the resources attached to your post.')),
  'You made a sale · A creator bought the resources attached to your post.',
  'words that name no one come back as they are');
select is((select title || ' · ' || body from public.unnamed_sale_alert_words(
  '@maya saved your post', 'It is in their saved media now.')),
  '@maya saved your post · It is in their saved media now.',
  'and so do another alert''s words');
select is((select title || ' · ' || body from public.unnamed_sale_alert_words(
  'You made a sale', 'A creator bought your recipe.')),
  'You made a sale · A creator bought your recipe.',
  'and the recipe words that name no one');
select is((select title || ' · ' || body from public.unnamed_sale_alert_words(
  '@lee got your free recipe', 'They have the prompt and files now.')),
  'Someone got your free recipe · A creator got the free recipe on your post.',
  'a free open in the recipe words loses its name through the function itself');

-- Nothing here is callable through the Data API.
reset role;
select ok(not has_function_privilege('anon', 'public.unnamed_sale_alert_words(text, text)', 'EXECUTE'),
  'anon cannot call the words function');
select ok(not has_function_privilege('authenticated', 'public.unnamed_sale_alert_words(text, text)', 'EXECUTE'),
  'nor can a signed-in account');
select ok(not has_function_privilege('authenticated', 'public.unname_sale_alert_that_cannot_name()', 'EXECUTE'),
  'nor the alert trigger''s function');
select ok(not has_function_privilege('authenticated', 'public.remove_follows_for_user_block()', 'EXECUTE'),
  'nor the block trigger''s function');

select * from finish();
rollback;
