-- A remix post carries its credit (20261105150143_remix_posts_carry_their_credit.sql,
-- backfilled by 20261105150200), and a remix's alerts name the remixer only while
-- they may (20261105150333_unname_remix_alerts_across_blocks_and_deletion.sql).
--
-- A (cora) posts; B (maya) remixes A's post, re-runs her remix and posts both;
-- C (lee) remixes B's post. The credit names the post remixed, its creator and
-- the chain's first creator, survives the remixer deleting their creation, and no
-- update changes it. Fixtures roll back.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

select ok(
  (select bool_and(
       procedures.prosecdef
       and procedures.proconfig @> array['search_path=public, pg_temp']
       and not has_function_privilege('authenticated', procedures.oid, 'EXECUTE')
       and not has_function_privilege('anon', procedures.oid, 'EXECUTE'))
   from pg_catalog.pg_proc as procedures
   where procedures.oid in (
     'public.remix_credit_for_generation(uuid)'::regprocedure,
     'public.copy_generation_remix_credit_to_post()'::regprocedure,
     'public.backfill_remix_post_credit()'::regprocedure
   )),
  'the credit functions run as their owner with no client grants'
);

-- ─── Fixture ────────────────────────────────────────────────────────────────

insert into auth.users (id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at) values
  ('e3a00000-0000-4000-8000-000000000001', 'remix-credit-cora@example.invalid', 'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('e3a00000-0000-4000-8000-000000000002', 'remix-credit-maya@example.invalid', 'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('e3a00000-0000-4000-8000-000000000003', 'remix-credit-lee@example.invalid', 'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('e3a00000-0000-4000-8000-000000000004', 'remix-credit-dan@example.invalid', 'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('e3a00000-0000-4000-8000-000000000005', 'remix-credit-kai@example.invalid', 'authenticated', 'authenticated', false, '{}', '{}', now());

create function pg_temp.credit(p_post_id uuid) returns table (parent_post_id uuid, parent_user_id uuid, origin_user_id uuid)
language sql as $$
  select remix_parent_post_id, remix_parent_user_id, remix_origin_user_id from public.posts where id = p_post_id
$$;

-- A's creation and its public post.
insert into public.generations (id, user_id, prediction_id, status, cost, category, model, output_url, is_public) values
  ('e3b00000-0000-4000-8000-000000000001', 'e3a00000-0000-4000-8000-000000000001',
   'remix-credit-a', 'succeeded', 1, 'image', 'test', 'https://example.invalid/a.png', true);
insert into public.posts (id, user_id, visibility, category, source_kind, generation_id, output_url, title) values
  ('e3c00000-0000-4000-8000-000000000001', 'e3a00000-0000-4000-8000-000000000001', 'public', 'image',
   'magicbooklet', 'e3b00000-0000-4000-8000-000000000001', 'https://example.invalid/a.png', 'Sunset beach');

select results_eq(
  $$ select * from pg_temp.credit('e3c00000-0000-4000-8000-000000000001') $$,
  $$ values (null::uuid, null::uuid, null::uuid) $$,
  'a post of a creation that remixed nothing carries no credit'
);

-- ─── B remixes A's post and posts it ────────────────────────────────────────

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, source_generation_id) values
  ('e3b00000-0000-4000-8000-000000000002', 'e3a00000-0000-4000-8000-000000000002',
   'remix-credit-b', 'processing', 1, 'image', 'test', 'e3b00000-0000-4000-8000-000000000001');
update public.generations
set status = 'succeeded', output_url = 'https://example.invalid/b.png', is_public = true
where id = 'e3b00000-0000-4000-8000-000000000002';
insert into public.posts (id, user_id, visibility, category, source_kind, generation_id, output_url, title) values
  ('e3c00000-0000-4000-8000-000000000002', 'e3a00000-0000-4000-8000-000000000002', 'public', 'image',
   'magicbooklet', 'e3b00000-0000-4000-8000-000000000002', 'https://example.invalid/b.png', 'Sunset, again');

select results_eq(
  $$ select * from pg_temp.credit('e3c00000-0000-4000-8000-000000000002') $$,
  $$ values ('e3c00000-0000-4000-8000-000000000001'::uuid, 'e3a00000-0000-4000-8000-000000000001'::uuid,
             'e3a00000-0000-4000-8000-000000000001'::uuid) $$,
  'a remix post names the post it remixed, that post''s creator, and them as the original'
);

-- ─── B re-runs her remix and posts the re-run ───────────────────────────────

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, source_generation_id) values
  ('e3b00000-0000-4000-8000-000000000003', 'e3a00000-0000-4000-8000-000000000002',
   'remix-credit-b-rerun', 'processing', 1, 'image', 'test', 'e3b00000-0000-4000-8000-000000000002');
update public.generations
set status = 'succeeded', output_url = 'https://example.invalid/b-rerun.png', is_public = true
where id = 'e3b00000-0000-4000-8000-000000000003';

select ok(
  not exists (select 1 from public.completed_post_remixes where generation_id = 'e3b00000-0000-4000-8000-000000000003'),
  'a re-run of one''s own remix is not a remix of one''s own post'
);

insert into public.posts (id, user_id, visibility, category, source_kind, generation_id, output_url) values
  ('e3c00000-0000-4000-8000-000000000003', 'e3a00000-0000-4000-8000-000000000002', 'public', 'image',
   'magicbooklet', 'e3b00000-0000-4000-8000-000000000003', 'https://example.invalid/b-rerun.png');

select results_eq(
  $$ select * from pg_temp.credit('e3c00000-0000-4000-8000-000000000003') $$,
  $$ values ('e3c00000-0000-4000-8000-000000000001'::uuid, 'e3a00000-0000-4000-8000-000000000001'::uuid,
             'e3a00000-0000-4000-8000-000000000001'::uuid) $$,
  'a post of the re-run credits the post the remix came from'
);

-- ─── A remixes her own post ─────────────────────────────────────────────────

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, source_generation_id) values
  ('e3b00000-0000-4000-8000-000000000004', 'e3a00000-0000-4000-8000-000000000001',
   'remix-credit-a-self', 'processing', 1, 'image', 'test', 'e3b00000-0000-4000-8000-000000000001');
update public.generations
set status = 'succeeded', output_url = 'https://example.invalid/a-self.png', is_public = true
where id = 'e3b00000-0000-4000-8000-000000000004';
insert into public.posts (id, user_id, visibility, category, source_kind, generation_id, output_url) values
  ('e3c00000-0000-4000-8000-000000000004', 'e3a00000-0000-4000-8000-000000000001', 'public', 'image',
   'magicbooklet', 'e3b00000-0000-4000-8000-000000000004', 'https://example.invalid/a-self.png');

select results_eq(
  $$ select * from pg_temp.credit('e3c00000-0000-4000-8000-000000000004') $$,
  $$ values (null::uuid, null::uuid, null::uuid) $$,
  'a post of a remix of one''s own post credits no one'
);

-- ─── C remixes B's post ─────────────────────────────────────────────────────

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, source_generation_id) values
  ('e3b00000-0000-4000-8000-000000000005', 'e3a00000-0000-4000-8000-000000000003',
   'remix-credit-c', 'processing', 1, 'image', 'test', 'e3b00000-0000-4000-8000-000000000002');
update public.generations
set status = 'succeeded', output_url = 'https://example.invalid/c.png', is_public = true
where id = 'e3b00000-0000-4000-8000-000000000005';
insert into public.posts (id, user_id, visibility, category, source_kind, generation_id, output_url) values
  ('e3c00000-0000-4000-8000-000000000005', 'e3a00000-0000-4000-8000-000000000003', 'public', 'image',
   'magicbooklet', 'e3b00000-0000-4000-8000-000000000005', 'https://example.invalid/c.png');

select results_eq(
  $$ select * from pg_temp.credit('e3c00000-0000-4000-8000-000000000005') $$,
  $$ values ('e3c00000-0000-4000-8000-000000000002'::uuid, 'e3a00000-0000-4000-8000-000000000002'::uuid,
             'e3a00000-0000-4000-8000-000000000001'::uuid) $$,
  'a remix of a remix names the post it remixed and the chain''s first creator'
);

-- ─── The credit stays ───────────────────────────────────────────────────────

update public.posts
set remix_parent_post_id = null,
    remix_parent_user_id = 'e3a00000-0000-4000-8000-000000000003',
    remix_origin_user_id = 'e3a00000-0000-4000-8000-000000000003'
where id = 'e3c00000-0000-4000-8000-000000000005';
update public.posts set title = 'Renamed' where id = 'e3c00000-0000-4000-8000-000000000005';

select results_eq(
  $$ select * from pg_temp.credit('e3c00000-0000-4000-8000-000000000005') $$,
  $$ values ('e3c00000-0000-4000-8000-000000000002'::uuid, 'e3a00000-0000-4000-8000-000000000002'::uuid,
             'e3a00000-0000-4000-8000-000000000001'::uuid) $$,
  'an update neither clears nor changes a credit'
);

delete from public.generations where id = 'e3b00000-0000-4000-8000-000000000002';

select is(
  (select generation_id from public.posts where id = 'e3c00000-0000-4000-8000-000000000002'),
  null::uuid,
  'deleting the remixer''s creation leaves her post'
);
select results_eq(
  $$ select * from pg_temp.credit('e3c00000-0000-4000-8000-000000000002') $$,
  $$ values ('e3c00000-0000-4000-8000-000000000001'::uuid, 'e3a00000-0000-4000-8000-000000000001'::uuid,
             'e3a00000-0000-4000-8000-000000000001'::uuid) $$,
  'and the post keeps its credit'
);

-- ─── The post remixed is gone before the remix is posted ────────────────────

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, output_url, is_public) values
  ('e3b00000-0000-4000-8000-000000000006', 'e3a00000-0000-4000-8000-000000000001',
   'remix-credit-a-gone', 'succeeded', 1, 'image', 'test', 'https://example.invalid/a-gone.png', true);
insert into public.posts (id, user_id, visibility, category, source_kind, generation_id, output_url) values
  ('e3c00000-0000-4000-8000-000000000006', 'e3a00000-0000-4000-8000-000000000001', 'public', 'image',
   'magicbooklet', 'e3b00000-0000-4000-8000-000000000006', 'https://example.invalid/a-gone.png');
insert into public.generations (id, user_id, prediction_id, status, cost, category, model, source_generation_id) values
  ('e3b00000-0000-4000-8000-000000000007', 'e3a00000-0000-4000-8000-000000000002',
   'remix-credit-b-gone', 'processing', 1, 'image', 'test', 'e3b00000-0000-4000-8000-000000000006');
update public.generations
set status = 'succeeded', output_url = 'https://example.invalid/b-gone.png', is_public = true
where id = 'e3b00000-0000-4000-8000-000000000007';
delete from public.posts where id = 'e3c00000-0000-4000-8000-000000000006';
insert into public.posts (id, user_id, visibility, category, source_kind, generation_id, output_url) values
  ('e3c00000-0000-4000-8000-000000000007', 'e3a00000-0000-4000-8000-000000000002', 'public', 'image',
   'magicbooklet', 'e3b00000-0000-4000-8000-000000000007', 'https://example.invalid/b-gone.png');

select results_eq(
  $$ select * from pg_temp.credit('e3c00000-0000-4000-8000-000000000007') $$,
  $$ values (null::uuid, null::uuid, 'e3a00000-0000-4000-8000-000000000001'::uuid) $$,
  'with the post remixed deleted, the chain''s first creator is still credited'
);

-- ─── Backfill ───────────────────────────────────────────────────────────────

-- C remixes A's post, and the post is written as one made before the credit was.
insert into public.generations (id, user_id, prediction_id, status, cost, category, model, source_generation_id) values
  ('e3b00000-0000-4000-8000-000000000008', 'e3a00000-0000-4000-8000-000000000003',
   'remix-credit-c-old', 'processing', 1, 'image', 'test', 'e3b00000-0000-4000-8000-000000000001');
update public.generations
set status = 'succeeded', output_url = 'https://example.invalid/c-old.png', is_public = true
where id = 'e3b00000-0000-4000-8000-000000000008';
-- Triggers set aside for the one insert (ALTER TABLE … DISABLE TRIGGER is refused
-- while the inserts above hold deferred trigger events).
set local session_replication_role = replica;
insert into public.posts (id, user_id, visibility, category, source_kind, generation_id, output_url) values
  ('e3c00000-0000-4000-8000-000000000008', 'e3a00000-0000-4000-8000-000000000003', 'public', 'image',
   'magicbooklet', 'e3b00000-0000-4000-8000-000000000008', 'https://example.invalid/c-old.png');
set local session_replication_role = origin;

select results_eq(
  $$ select * from pg_temp.credit('e3c00000-0000-4000-8000-000000000008') $$,
  $$ values (null::uuid, null::uuid, null::uuid) $$,
  'a post made before the credit has none'
);

select lives_ok($$ select public.backfill_remix_post_credit() $$, 'the backfill runs');
select results_eq(
  $$ select * from pg_temp.credit('e3c00000-0000-4000-8000-000000000008') $$,
  $$ values ('e3c00000-0000-4000-8000-000000000001'::uuid, 'e3a00000-0000-4000-8000-000000000001'::uuid,
             'e3a00000-0000-4000-8000-000000000001'::uuid) $$,
  'and fills its credit'
);
select results_eq(
  $$ select * from pg_temp.credit('e3c00000-0000-4000-8000-000000000001') $$,
  $$ values (null::uuid, null::uuid, null::uuid) $$,
  'and leaves a post that remixed nothing without one'
);
select lives_ok($$ select public.backfill_remix_post_credit() $$, 'a second run changes nothing');

select is(
  (select count(*)::integer from public.posts
   where remix_parent_post_id = 'e3c00000-0000-4000-8000-000000000001'),
  3,
  'A''s post has three remix posts: B''s, B''s re-run and C''s'
);

-- ─── Remix alerts ───────────────────────────────────────────────────────────

set local role service_role;

create function pg_temp.alert(p_id uuid) returns text language sql as $$
  select title || ' · ' || coalesce(deep_link, '(no link)') from public.mobile_notifications where id = p_id
$$;
create function pg_temp.write_remix_alert(
  p_id uuid, p_owner uuid, p_remixer uuid, p_title text, p_deep_link text, p_post uuid
) returns void language sql as $$
  insert into public.mobile_notifications (id, user_id, actor_user_id, type, category, title, body, deep_link, object_type, object_id, dedupe_key)
  values (p_id, p_owner, p_remixer, 'post_remixed', 'social', p_title, 'They finished a new creation from it.',
          p_deep_link, 'post', p_post::text, 'remix-alert-test:' || p_id::text)
$$;

-- What the server writes when B's remix finishes and when she posts it.
select pg_temp.write_remix_alert('e3e00000-0000-4000-8000-000000000001',
  'e3a00000-0000-4000-8000-000000000001', 'e3a00000-0000-4000-8000-000000000002',
  '@maya remixed your post', '/creators/maya', 'e3c00000-0000-4000-8000-000000000001');
select pg_temp.write_remix_alert('e3e00000-0000-4000-8000-000000000002',
  'e3a00000-0000-4000-8000-000000000001', 'e3a00000-0000-4000-8000-000000000002',
  '@maya posted a remix of your post', '/showcase/e3c00000-0000-4000-8000-000000000002',
  'e3c00000-0000-4000-8000-000000000001');

select is(pg_temp.alert('e3e00000-0000-4000-8000-000000000001'),
  '@maya remixed your post · /creators/maya',
  'a finished remix between accounts with no block names the remixer and opens her page');
select is(pg_temp.alert('e3e00000-0000-4000-8000-000000000002'),
  '@maya posted a remix of your post · /showcase/e3c00000-0000-4000-8000-000000000002',
  'a posted remix names her and opens her post');

-- 3. Written across a block: kai blocked A before kai's remix finished.
insert into public.user_blocks (blocker_user_id, blocked_user_id) values
  ('e3a00000-0000-4000-8000-000000000005', 'e3a00000-0000-4000-8000-000000000001');
select pg_temp.write_remix_alert('e3e00000-0000-4000-8000-000000000003',
  'e3a00000-0000-4000-8000-000000000001', 'e3a00000-0000-4000-8000-000000000005',
  '@kai remixed your post', '/creators/kai', 'e3c00000-0000-4000-8000-000000000001');
select is(pg_temp.alert('e3e00000-0000-4000-8000-000000000003'),
  'Someone remixed your post · /showcase/e3c00000-0000-4000-8000-000000000001',
  'a remix alert written across a block names no one and opens the post remixed');
select is((select actor_user_id from public.mobile_notifications where id = 'e3e00000-0000-4000-8000-000000000003'),
  'e3a00000-0000-4000-8000-000000000005'::uuid, 'and keeps its remixer, as its dedupe record');

-- 2. A block made after: A blocks B.
insert into public.user_blocks (blocker_user_id, blocked_user_id) values
  ('e3a00000-0000-4000-8000-000000000001', 'e3a00000-0000-4000-8000-000000000002');
select is(pg_temp.alert('e3e00000-0000-4000-8000-000000000001'),
  'Someone remixed your post · /showcase/e3c00000-0000-4000-8000-000000000001',
  'a block made afterwards takes the name and the page out of the finished alert');
select is(pg_temp.alert('e3e00000-0000-4000-8000-000000000002'),
  'Someone posted a remix of your post · /showcase/e3c00000-0000-4000-8000-000000000001',
  'and the name and the remix out of the posted one, which opens the post remixed');

-- 1. The remixer's account deleted.
select pg_temp.write_remix_alert('e3e00000-0000-4000-8000-000000000004',
  'e3a00000-0000-4000-8000-000000000003', 'e3a00000-0000-4000-8000-000000000004',
  '@dan remixed your post', '/creators/dan', 'e3c00000-0000-4000-8000-000000000005');
select pg_temp.write_remix_alert('e3e00000-0000-4000-8000-000000000005',
  'e3a00000-0000-4000-8000-000000000003', 'e3a00000-0000-4000-8000-000000000004',
  'Someone remixed your post', '/showcase/e3c00000-0000-4000-8000-000000000005', 'e3c00000-0000-4000-8000-000000000005');
reset role;
select lives_ok($$ delete from auth.users where id = 'e3a00000-0000-4000-8000-000000000004' $$,
  'deleting a remixer''s account succeeds');
set local role service_role;
select is(pg_temp.alert('e3e00000-0000-4000-8000-000000000004'),
  'Someone remixed your post · /showcase/e3c00000-0000-4000-8000-000000000005',
  'and her name and page leave the alert');
select is(pg_temp.alert('e3e00000-0000-4000-8000-000000000005'),
  'Someone remixed your post · /showcase/e3c00000-0000-4000-8000-000000000005',
  'an alert that named no one is left as it was');

select is((select title || ' · ' || deep_link from public.unnamed_remix_alert_words(
  '@maya saved your post', '/showcase/p1', 'p1')),
  '@maya saved your post · /showcase/p1',
  'the words function leaves another alert''s words as they are');

reset role;
select ok(not has_function_privilege('authenticated', 'public.unnamed_remix_alert_words(text, text, text)', 'EXECUTE'),
  'no signed-in account can call the remix words function');
select ok(not has_function_privilege('anon', 'public.unnamed_remix_alert_words(text, text, text)', 'EXECUTE'),
  'nor anon');
select ok(not has_function_privilege('authenticated', 'public.unname_remix_alert_that_cannot_name()', 'EXECUTE'),
  'nor the remix alert trigger''s function');

select * from finish();
rollback;
