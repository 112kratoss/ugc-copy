-- Regression coverage for audit Finding A: update_post_with_resource_bundle
-- raised on every call between 2026-08-06 and 2026-08-09 because its owner
-- guard referenced an undeclared `v_bundle` record. These tests pin the two
-- behaviours the guard must have: a plain owner edit succeeds (this is the
-- call that was impossible while broken), and a non-owner is still rejected
-- with the exact message the API layer maps to 404.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(5);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-4000-8000-00000000fa01'::uuid, 'owner-guard-owner@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-4000-8000-00000000fa02'::uuid, 'owner-guard-other@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

-- A bundle-less text post: exactly the shape that was broken end-to-end.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body)
values (
  'fa000000-0000-4000-8000-000000000001'::uuid,
  '00000000-0000-4000-8000-00000000fa01'::uuid,
  'public', 'image', 'external', 'text', 'Original body'
);

select lives_ok(
  $$select * from public.update_post_with_resource_bundle(
      'fa000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-00000000fa01'::uuid,
      '{"title": "Guarded title"}'::jsonb,
      false,
      null
    )$$,
  'owner metadata edit on a bundle-less post succeeds'
);

select is(
  (select title from public.posts where id = 'fa000000-0000-4000-8000-000000000001'::uuid),
  'Guarded title',
  'the patch was applied'
);

select is(
  (select r.bundle_id from public.update_post_with_resource_bundle(
     'fa000000-0000-4000-8000-000000000001'::uuid,
     '00000000-0000-4000-8000-00000000fa01'::uuid,
     '{}'::jsonb,
     false,
     null
   ) as r),
  null,
  'a bundle-less post reports no bundle rather than raising'
);

select throws_ok(
  $$select * from public.update_post_with_resource_bundle(
      'fa000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-00000000fa02'::uuid,
      '{"title": "Hijacked"}'::jsonb,
      false,
      null
    )$$,
  'P0001',
  'Post not found or not owned by user',
  'a non-owner is rejected'
);

select throws_ok(
  $$select * from public.update_post_with_resource_bundle(
      'fa000000-0000-4000-8000-0000000000ff'::uuid,
      '00000000-0000-4000-8000-00000000fa01'::uuid,
      '{}'::jsonb,
      false,
      null
    )$$,
  'P0001',
  'Post not found or not owned by user',
  'a missing post is rejected'
);

select * from finish();

rollback;
