-- Behavioural coverage for threaded post comments.
--
-- The load-bearing properties: clients can never touch the table or its RPCs
-- directly, counters stay consistent with the number of active rows, replies
-- can never cross posts, and removal is authorised for exactly the comment
-- author and the post owner.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(32);

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

-- ─── One-level threads and account-deletion preservation ────────────────────

select public.create_post_comment(
  'd0000000-0000-4000-8000-000000000002'::uuid,
  'c1000000-0000-4000-8000-000000000001'::uuid,
  null,
  'account deletion parent'
);

select public.create_post_comment(
  'd0000000-0000-4000-8000-000000000002'::uuid,
  'c3000000-0000-4000-8000-000000000003'::uuid,
  (select id from public.post_comments where body = 'account deletion parent'),
  'surviving child reply'
);

select throws_ok(
  format(
    $$
      select public.create_post_comment(
        'd0000000-0000-4000-8000-000000000002'::uuid,
        'c2000000-0000-4000-8000-000000000002'::uuid,
        %L::uuid,
        'unrenderable nested reply'
      )
    $$,
    (select id from public.post_comments where body = 'surviving child reply')
  ),
  'P0001',
  'Replies can only target top-level comments',
  'the database rejects replies to replies'
);

select lives_ok(
  $$ delete from auth.users where id = 'c1000000-0000-4000-8000-000000000001'::uuid $$,
  'deleting a commenter preserves their conversation'
);

select is(
  (select status from public.post_comments where body = 'account deletion parent'),
  'removed_by_author',
  'account deletion soft-removes an active comment'
);

select is(
  (select user_id from public.post_comments where body = 'account deletion parent'),
  null::uuid,
  'account deletion anonymizes the retained comment author'
);

select is(
  (select count(*) from public.post_comments where body = 'surviving child reply'),
  1::bigint,
  'another user''s reply survives deletion of the parent author'
);

select is(
  (select comment_count from public.posts
   where id = 'd0000000-0000-4000-8000-000000000002'::uuid),
  1,
  'account deletion decrements the post counter only for the deleted author''s active rows'
);

select is(
  (select reply_count from public.post_comments where body = 'account deletion parent'),
  1,
  'account deletion preserves the active surviving-reply counter'
);

-- ─── Actionable comment moderation ──────────────────────────────────────────

insert into public.moderation_reports (
  id,
  reporter_user_id,
  target_type,
  comment_id,
  reason,
  source_surface
)
values
  (
    'e1000000-0000-4000-8000-000000000001'::uuid,
    'c2000000-0000-4000-8000-000000000002'::uuid,
    'comment',
    (select id from public.post_comments where body = 'surviving child reply'),
    'harassment',
    'comments'
  ),
  (
    'e2000000-0000-4000-8000-000000000002'::uuid,
    'c2000000-0000-4000-8000-000000000002'::uuid,
    'comment',
    (select id from public.post_comments where body = 'surviving child reply'),
    'harassment',
    'comments'
  );

create temporary table comment_moderation_result as
select public.resolve_subject_report_for_ops(
  'e1000000-0000-4000-8000-000000000001'::uuid,
  'c2000000-0000-4000-8000-000000000002'::uuid,
  'resolve'
) as result;

select is(
  (select result ->> 'status' from comment_moderation_result),
  'resolved',
  'comment moderation returns a resolved decision'
);

select is(
  (select (result ->> 'comment_removed')::boolean from comment_moderation_result),
  true,
  'resolving a confirmed comment report removes the active comment'
);

select is(
  (select (result ->> 'resolved_report_count')::integer from comment_moderation_result),
  2,
  'one enforcement action resolves duplicate reports for the same comment'
);

select is(
  (select status from public.post_comments where body = 'surviving child reply'),
  'removed_by_moderation',
  'the violating comment records its moderation removal status'
);

select is(
  (select comment_count from public.posts
   where id = 'd0000000-0000-4000-8000-000000000002'::uuid),
  0,
  'comment moderation decrements the post counter'
);

select is(
  (select reply_count from public.post_comments where body = 'account deletion parent'),
  0,
  'comment moderation decrements the parent reply counter'
);

select is(
  (select count(*) from public.moderation_reports
   where id in (
     'e1000000-0000-4000-8000-000000000001'::uuid,
     'e2000000-0000-4000-8000-000000000002'::uuid
   )
     and status = 'resolved'
     and reviewed_by = 'c2000000-0000-4000-8000-000000000002'::uuid),
  2::bigint,
  'duplicate comment reports retain the moderator audit record'
);

select * from finish();

rollback;
