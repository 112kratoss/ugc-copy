-- Behavioural coverage for threaded post comments.
--
-- The load-bearing properties: clients can never touch the table or its RPCs
-- directly, counters stay consistent with the number of active rows, replies
-- can never cross posts, and removal is authorised for exactly the comment
-- author and the post owner.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(18);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('c1000000-0000-4000-8000-000000000001'::uuid, 'comment-author@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('c2000000-0000-4000-8000-000000000002'::uuid, 'comment-post-owner@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('c3000000-0000-4000-8000-000000000003'::uuid, 'comment-stranger@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body)
values
  ('d0000000-0000-4000-8000-000000000001'::uuid, 'c2000000-0000-4000-8000-000000000002'::uuid,
   'public', 'text', 'external', 'text', 'commentable public post'),
  ('d0000000-0000-4000-8000-000000000002'::uuid, 'c2000000-0000-4000-8000-000000000002'::uuid,
   'public', 'text', 'external', 'text', 'second commentable public post'),
  ('d0000000-0000-4000-8000-000000000003'::uuid, 'c2000000-0000-4000-8000-000000000002'::uuid,
   'private', 'text', 'external', 'text', 'private post');

-- ─── Client boundaries ───────────────────────────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub": "c1000000-0000-4000-8000-000000000001", "role": "authenticated"}',
  true
);

select throws_ok(
  $$ select id from public.post_comments $$,
  '42501',
  null,
  'an authenticated client cannot read post comments directly'
);

select throws_ok(
  $$
    insert into public.post_comments (post_id, user_id, body)
    values ('d0000000-0000-4000-8000-000000000001'::uuid,
            'c1000000-0000-4000-8000-000000000001'::uuid, 'forged')
  $$,
  '42501',
  null,
  'an authenticated client cannot insert post comments directly'
);

select throws_ok(
  $$
    select public.create_post_comment(
      'd0000000-0000-4000-8000-000000000001'::uuid,
      'c1000000-0000-4000-8000-000000000001'::uuid,
      null,
      'forged through the rpc'
    )
  $$,
  '42501',
  null,
  'an authenticated client cannot execute the comment rpc'
);

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$ select id from public.post_comments $$,
  '42501',
  null,
  'an anonymous client cannot read post comments directly'
);

-- ─── Backend behaviour ───────────────────────────────────────────────────────

reset role;
select set_config('request.jwt.claims', null, true);

select lives_ok(
  $$
    select public.create_post_comment(
      'd0000000-0000-4000-8000-000000000001'::uuid,
      'c1000000-0000-4000-8000-000000000001'::uuid,
      null,
      'the first comment'
    )
  $$,
  'the backend can create a top-level comment'
);

select is(
  (select comment_count from public.posts
   where id = 'd0000000-0000-4000-8000-000000000001'::uuid),
  1,
  'creating a comment increments the denormalized post counter'
);

select throws_ok(
  $$
    select public.create_post_comment(
      'd0000000-0000-4000-8000-000000000003'::uuid,
      'c1000000-0000-4000-8000-000000000001'::uuid,
      null,
      'comment on a private post'
    )
  $$,
  'P0001',
  'Post is private or not found',
  'comments are rejected on posts that are not publicly visible'
);

select throws_ok(
  $$
    select public.create_post_comment(
      'd0000000-0000-4000-8000-000000000001'::uuid,
      'c1000000-0000-4000-8000-000000000001'::uuid,
      null,
      '   '
    )
  $$,
  'P0001',
  'Comment body is required',
  'blank comment bodies are rejected'
);

-- Reply to the first comment.
select public.create_post_comment(
  'd0000000-0000-4000-8000-000000000001'::uuid,
  'c3000000-0000-4000-8000-000000000003'::uuid,
  (select id from public.post_comments
   where post_id = 'd0000000-0000-4000-8000-000000000001'::uuid
     and parent_comment_id is null),
  'the first reply'
);

select is(
  (select reply_count from public.post_comments
   where post_id = 'd0000000-0000-4000-8000-000000000001'::uuid
     and parent_comment_id is null),
  1,
  'replying increments the parent reply counter'
);

select is(
  (select comment_count from public.posts
   where id = 'd0000000-0000-4000-8000-000000000001'::uuid),
  2,
  'replies count toward the post comment total'
);

select throws_ok(
  format(
    $$
      select public.create_post_comment(
        'd0000000-0000-4000-8000-000000000002'::uuid,
        'c1000000-0000-4000-8000-000000000001'::uuid,
        %L::uuid,
        'a reply that crosses posts'
      )
    $$,
    (select id from public.post_comments
     where post_id = 'd0000000-0000-4000-8000-000000000001'::uuid
       and parent_comment_id is null)
  ),
  'P0001',
  'Parent comment not found',
  'a reply cannot attach to a parent on a different post'
);

-- ─── Removal authorisation ───────────────────────────────────────────────────

select throws_ok(
  format(
    $$ select public.set_post_comment_status(%L::uuid, 'c3000000-0000-4000-8000-000000000003'::uuid, 'removed_by_author') $$,
    (select id from public.post_comments
     where post_id = 'd0000000-0000-4000-8000-000000000001'::uuid
       and parent_comment_id is null)
  ),
  'P0001',
  'Only the comment author can delete this comment',
  'a stranger cannot delete another user''s comment'
);

select throws_ok(
  format(
    $$ select public.set_post_comment_status(%L::uuid, 'c3000000-0000-4000-8000-000000000003'::uuid, 'removed_by_owner') $$,
    (select id from public.post_comments
     where post_id = 'd0000000-0000-4000-8000-000000000001'::uuid
       and parent_comment_id is null)
  ),
  'P0001',
  'Only the post owner can remove this comment',
  'a stranger cannot remove a comment as if they owned the post'
);

select is(
  (select changed from public.set_post_comment_status(
    (select id from public.post_comments
     where post_id = 'd0000000-0000-4000-8000-000000000001'::uuid
       and parent_comment_id is not null),
    'c3000000-0000-4000-8000-000000000003'::uuid,
    'removed_by_author'
  )),
  true,
  'the comment author can soft-delete their own reply'
);

select is(
  (select reply_count from public.post_comments
   where post_id = 'd0000000-0000-4000-8000-000000000001'::uuid
     and parent_comment_id is null),
  0,
  'removing a reply decrements the parent reply counter'
);

select is(
  (select changed from public.set_post_comment_status(
    (select id from public.post_comments
     where post_id = 'd0000000-0000-4000-8000-000000000001'::uuid
       and parent_comment_id is not null),
    'c3000000-0000-4000-8000-000000000003'::uuid,
    'removed_by_author'
  )),
  false,
  'removing an already removed comment is idempotent'
);

select is(
  (select comment_count from public.posts
   where id = 'd0000000-0000-4000-8000-000000000001'::uuid),
  1,
  'an idempotent removal does not double-decrement the post counter'
);

select is(
  (select changed from public.set_post_comment_status(
    (select id from public.post_comments
     where post_id = 'd0000000-0000-4000-8000-000000000001'::uuid
       and parent_comment_id is null),
    'c2000000-0000-4000-8000-000000000002'::uuid,
    'removed_by_owner'
  )),
  true,
  'the post owner can remove a comment left on their post'
);

select * from finish();

rollback;
