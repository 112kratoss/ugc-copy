-- A remix of a creation made as a guest, posted by the account the guest was
-- linked to (20261030022210_remix_credit_follows_linked_guest_creations.sql).
--
-- Publish files the post under the account while the generation keeps the
-- guest's id. A completed remix of it is counted on the post and recorded for
-- the creator's alert, as for the account's own creation; a post whose owner
-- the guest is not linked to is still not credited.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(9);

select ok(
  (select procedures.prosecdef
     and procedures.proconfig @> array['search_path=public, pg_temp']
     and not has_function_privilege('authenticated', procedures.oid, 'EXECUTE')
     and not has_function_privilege('anon', procedures.oid, 'EXECUTE')
   from pg_catalog.pg_proc as procedures
   where procedures.oid = 'public.record_completed_post_remix()'::regprocedure),
  'the remix credit keeps its trusted owner, search path and no client grants'
);

-- ─── Fixture ─────────────────────────────────────────────────────────────────
-- G (…01) is a guest that made a creation and then registered as T (…02).
-- H (…03) is a guest linked to U (…04), not to T. R (…05) remixes.

insert into auth.users (
  id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at
) values
  ('c7a00000-0000-4000-8000-000000000001', null,
   'authenticated', 'authenticated', true, '{}', '{}', now()),
  ('c7a00000-0000-4000-8000-000000000002', 'linked-remix-owner@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('c7a00000-0000-4000-8000-000000000003', null,
   'authenticated', 'authenticated', true, '{}', '{}', now()),
  ('c7a00000-0000-4000-8000-000000000004', 'linked-remix-other@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('c7a00000-0000-4000-8000-000000000005', 'linked-remix-reader@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now());

select is(
  public.merge_guest_account(
    'c7a00000-0000-4000-8000-000000000001',
    'c7a00000-0000-4000-8000-000000000002',
    'mobile'
  ) ->> 'status',
  'merged',
  'the guest registers and is linked to its account'
);
select is(
  public.merge_guest_account(
    'c7a00000-0000-4000-8000-000000000003',
    'c7a00000-0000-4000-8000-000000000004',
    'mobile'
  ) ->> 'status',
  'merged',
  'another guest is linked to another account'
);

-- GA was made by G and GB by H. T posts both publicly: GA as publish files it,
-- GB as no publish could, to show the link is what counts.
insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, output_url, is_public
) values
  ('c7b00000-0000-4000-8000-000000000001', 'c7a00000-0000-4000-8000-000000000001',
   'linked-remix-source-a', 'succeeded', 1, 'image', 'test',
   'https://example.invalid/linked-a.png', true),
  ('c7b00000-0000-4000-8000-000000000002', 'c7a00000-0000-4000-8000-000000000003',
   'linked-remix-source-b', 'succeeded', 1, 'image', 'test',
   'https://example.invalid/linked-b.png', true);
insert into public.posts (id, user_id, visibility, category, source_kind, generation_id, output_url) values
  ('c7c00000-0000-4000-8000-000000000001', 'c7a00000-0000-4000-8000-000000000002', 'public', 'image',
   'magicbooklet', 'c7b00000-0000-4000-8000-000000000001', 'https://example.invalid/linked-a.png'),
  ('c7c00000-0000-4000-8000-000000000002', 'c7a00000-0000-4000-8000-000000000002', 'public', 'image',
   'magicbooklet', 'c7b00000-0000-4000-8000-000000000002', 'https://example.invalid/linked-b.png');

-- ─── A remix of the account's guest-made creation ───────────────────────────

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, source_generation_id) values
  ('c7b00000-0000-4000-8000-000000000003', 'c7a00000-0000-4000-8000-000000000005',
   'linked-remix-output-a', 'processing', 1, 'video', 'test', 'c7b00000-0000-4000-8000-000000000001');
select is(
  (select remix_count from public.posts where id = 'c7c00000-0000-4000-8000-000000000001'),
  0,
  'a remix still running is not counted'
);

update public.generations
set status = 'succeeded', output_url = 'https://example.invalid/linked-a-remix.mp4'
where id = 'c7b00000-0000-4000-8000-000000000003';
select is(
  (select remix_count from public.posts where id = 'c7c00000-0000-4000-8000-000000000001'),
  1,
  'a completed remix of a creation the account made as a guest counts on its post'
);
select results_eq(
  $$ select post_id, actor_user_id, notification_eligible
     from public.completed_post_remixes
     where generation_id = 'c7b00000-0000-4000-8000-000000000003' $$,
  $$ values ('c7c00000-0000-4000-8000-000000000001'::uuid, 'c7a00000-0000-4000-8000-000000000005'::uuid, true) $$,
  'and is recorded for the creator''s alert'
);

update public.generations
set status = 'succeeded', output_url = 'https://example.invalid/linked-a-remix.mp4'
where id = 'c7b00000-0000-4000-8000-000000000003';
select is(
  (select remix_count from public.posts where id = 'c7c00000-0000-4000-8000-000000000001'),
  1,
  'a replayed completion cannot count it twice'
);

-- ─── A remix of a guest's creation the post owner is not linked to ──────────

insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, source_generation_id, output_url
) values
  ('c7b00000-0000-4000-8000-000000000004', 'c7a00000-0000-4000-8000-000000000005',
   'linked-remix-output-b', 'succeeded', 1, 'image', 'test', 'c7b00000-0000-4000-8000-000000000002',
   'https://example.invalid/linked-b-remix.png');
select is(
  (select remix_count from public.posts where id = 'c7c00000-0000-4000-8000-000000000002'),
  0,
  'a post whose owner the guest is not linked to is not credited'
);
select is(
  (select count(*) from public.completed_post_remixes
   where generation_id = 'c7b00000-0000-4000-8000-000000000004'),
  0::bigint,
  'and no alert is recorded for it'
);

select * from finish();
rollback;
