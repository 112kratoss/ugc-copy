-- Likes and dislikes, the creator's heart, the pinned comment and edits.
--
-- The load-bearing properties: clients can never touch the new tables or
-- functions directly; a comment's counts are the number of reaction rows,
-- also after a reader's account is deleted; a heart and a pin are the post
-- owner's alone and never outlive the comment's removal; a post holds one pin;
-- an edit is the author's alone, keeps the words it replaced and takes the
-- heart off.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(50);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values
  ('e1000000-0000-4000-8000-000000000001'::uuid, 'reaction-author@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'),
  ('e2000000-0000-4000-8000-000000000002'::uuid, 'reaction-post-owner@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'),
  ('e3000000-0000-4000-8000-000000000003'::uuid, 'reaction-reader@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'),
  ('e4000000-0000-4000-8000-000000000004'::uuid, 'reaction-leaver@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() - interval '30 days');

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body)
values
  ('f0000000-0000-4000-8000-000000000001'::uuid, 'e2000000-0000-4000-8000-000000000002'::uuid,
   'public', 'text', 'external', 'text', 'post with a thread'),
  ('f0000000-0000-4000-8000-000000000002'::uuid, 'e2000000-0000-4000-8000-000000000002'::uuid,
   'private', 'text', 'external', 'text', 'private post');

insert into public.post_comments (id, post_id, user_id, parent_comment_id, body)
values
  ('a1000000-0000-4000-8000-000000000001'::uuid, 'f0000000-0000-4000-8000-000000000001'::uuid,
   'e1000000-0000-4000-8000-000000000001'::uuid, null, 'first comment'),
  ('a1000000-0000-4000-8000-000000000002'::uuid, 'f0000000-0000-4000-8000-000000000001'::uuid,
   'e1000000-0000-4000-8000-000000000001'::uuid, null, 'second comment'),
  ('a1000000-0000-4000-8000-000000000003'::uuid, 'f0000000-0000-4000-8000-000000000001'::uuid,
   'e3000000-0000-4000-8000-000000000003'::uuid, 'a1000000-0000-4000-8000-000000000001'::uuid, 'a reply'),
  ('a1000000-0000-4000-8000-000000000004'::uuid, 'f0000000-0000-4000-8000-000000000001'::uuid,
   'e2000000-0000-4000-8000-000000000002'::uuid, null, 'the owner''s own comment'),
  ('a1000000-0000-4000-8000-000000000005'::uuid, 'f0000000-0000-4000-8000-000000000002'::uuid,
   'e1000000-0000-4000-8000-000000000001'::uuid, null, 'comment on a private post');

-- ─── Client boundaries ───────────────────────────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub": "e3000000-0000-4000-8000-000000000003", "role": "authenticated"}',
  true
);

select throws_ok(
  $$ select comment_id from public.post_comment_reactions $$,
  '42501', null,
  'an authenticated client cannot read reactions directly'
);

select throws_ok(
  $$
    insert into public.post_comment_reactions (comment_id, user_id, reaction)
    values ('a1000000-0000-4000-8000-000000000001'::uuid,
            'e3000000-0000-4000-8000-000000000003'::uuid, 'like')
  $$,
  '42501', null,
  'an authenticated client cannot write reactions directly'
);

select throws_ok(
  $$ select previous_body from public.post_comment_edits $$,
  '42501', null,
  'an authenticated client cannot read the edit history'
);

select throws_ok(
  $$ select * from public.set_post_comment_reaction(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e3000000-0000-4000-8000-000000000003'::uuid, 'like') $$,
  '42501', null,
  'an authenticated client cannot call set_post_comment_reaction'
);

select throws_ok(
  $$ select * from public.edit_post_comment(
       'a1000000-0000-4000-8000-000000000003'::uuid,
       'e3000000-0000-4000-8000-000000000003'::uuid, 'forged') $$,
  '42501', null,
  'an authenticated client cannot call edit_post_comment'
);

select throws_ok(
  $$ select * from public.set_post_comment_heart(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e3000000-0000-4000-8000-000000000003'::uuid, true) $$,
  '42501', null,
  'an authenticated client cannot call set_post_comment_heart'
);

select throws_ok(
  $$ select * from public.set_post_comment_pin(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e3000000-0000-4000-8000-000000000003'::uuid, true) $$,
  '42501', null,
  'an authenticated client cannot call set_post_comment_pin'
);

reset role;

select is(
  has_table_privilege('service_role', 'public.post_comment_edits', 'UPDATE')
    or has_table_privilege('service_role', 'public.post_comment_edits', 'DELETE'),
  false,
  'the edit history is append-only for the service role too'
);

-- ─── Reactions and their counts ──────────────────────────────────────────────

select results_eq(
  $$ select like_count, viewer_reaction from public.set_post_comment_reaction(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e3000000-0000-4000-8000-000000000003'::uuid, 'like') $$,
  $$ values (1, 'like'::text) $$,
  'a like counts once and answers the reader''s reaction'
);

select results_eq(
  $$ select like_count, viewer_reaction from public.set_post_comment_reaction(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e3000000-0000-4000-8000-000000000003'::uuid, 'like') $$,
  $$ values (1, 'like'::text) $$,
  'the same like again changes nothing'
);

select lives_ok(
  $$ select * from public.set_post_comment_reaction(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e4000000-0000-4000-8000-000000000004'::uuid, 'like') $$,
  'a second reader likes the same comment'
);

select results_eq(
  $$ select like_count, dislike_count from public.post_comments
     where id = 'a1000000-0000-4000-8000-000000000001'::uuid $$,
  $$ values (2, 0) $$,
  'two readers, two likes'
);

select results_eq(
  $$ select like_count, viewer_reaction from public.set_post_comment_reaction(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e3000000-0000-4000-8000-000000000003'::uuid, 'dislike') $$,
  $$ values (1, 'dislike'::text) $$,
  'a like turned into a dislike leaves one like'
);

select results_eq(
  $$ select like_count, dislike_count from public.post_comments
     where id = 'a1000000-0000-4000-8000-000000000001'::uuid $$,
  $$ values (1, 1) $$,
  'and moves to the dislike count, which no function answers'
);

select results_eq(
  $$ select like_count, viewer_reaction from public.set_post_comment_reaction(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e3000000-0000-4000-8000-000000000003'::uuid, 'none') $$,
  $$ values (1, null::text) $$,
  'taking a reaction back answers no reaction'
);

select results_eq(
  $$ select like_count, dislike_count,
            (select count(*)::integer from public.post_comment_reactions
             where comment_id = 'a1000000-0000-4000-8000-000000000001'::uuid)
     from public.post_comments
     where id = 'a1000000-0000-4000-8000-000000000001'::uuid $$,
  $$ values (1, 0, 1) $$,
  'the counts are the rows'
);

select throws_ok(
  $$ select * from public.set_post_comment_reaction(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e3000000-0000-4000-8000-000000000003'::uuid, 'love') $$,
  'P0001', 'Unsupported comment reaction',
  'only like, dislike and none are reactions'
);

select throws_ok(
  $$ select * from public.set_post_comment_reaction(
       'a1000000-0000-4000-8000-000000000005'::uuid,
       'e3000000-0000-4000-8000-000000000003'::uuid, 'like') $$,
  'P0001', 'Post is private or not found',
  'a comment on a post that takes no comments takes no reactions'
);

-- A reader's account deletion takes their reactions, and the count with them.
delete from auth.users where id = 'e4000000-0000-4000-8000-000000000004'::uuid;

select results_eq(
  $$ select like_count,
            (select count(*)::integer from public.post_comment_reactions
             where comment_id = 'a1000000-0000-4000-8000-000000000001'::uuid)
     from public.post_comments
     where id = 'a1000000-0000-4000-8000-000000000001'::uuid $$,
  $$ values (0, 0) $$,
  'a deleted account''s like leaves the count'
);

-- ─── The creator's heart ─────────────────────────────────────────────────────

select throws_ok(
  $$ select * from public.set_post_comment_heart(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e3000000-0000-4000-8000-000000000003'::uuid, true) $$,
  'P0001', 'Only the post owner can heart this comment',
  'a reader cannot heart'
);

select throws_ok(
  $$ select * from public.set_post_comment_heart(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e1000000-0000-4000-8000-000000000001'::uuid, true) $$,
  'P0001', 'Only the post owner can heart this comment',
  'the comment''s own author cannot heart it'
);

select throws_ok(
  $$ select * from public.set_post_comment_heart(
       'a1000000-0000-4000-8000-000000000004'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, true) $$,
  'P0001', 'A creator cannot heart their own comment',
  'the post owner cannot heart their own comment'
);

select results_eq(
  $$ select hearted from public.set_post_comment_heart(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, true) $$,
  $$ values (true) $$,
  'the post owner hearts a reader''s comment'
);

select results_eq(
  $$ select hearted from public.set_post_comment_heart(
       'a1000000-0000-4000-8000-000000000003'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, true) $$,
  $$ values (true) $$,
  'and a reply'
);

select results_eq(
  $$ select hearted from public.set_post_comment_heart(
       'a1000000-0000-4000-8000-000000000003'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, false) $$,
  $$ values (false) $$,
  'and takes it back'
);

select is(
  (select hearted_at from public.post_comments where id = 'a1000000-0000-4000-8000-000000000003'::uuid),
  null,
  'a heart taken back leaves no stamp'
);

-- ─── Edits ───────────────────────────────────────────────────────────────────

select throws_ok(
  $$ select * from public.edit_post_comment(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, 'the owner rewrites it') $$,
  'P0001', 'Only the comment author can edit this comment',
  'the post owner cannot edit someone else''s comment'
);

select throws_ok(
  $$ select * from public.edit_post_comment(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e1000000-0000-4000-8000-000000000001'::uuid, '   ') $$,
  'P0001', 'Comment body is required',
  'an edit needs words'
);

select results_eq(
  $$ select body, edited_at is null, changed from public.edit_post_comment(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e1000000-0000-4000-8000-000000000001'::uuid, '  first comment  ') $$,
  $$ values ('first comment'::text, true, false) $$,
  'saving the same words is not an edit'
);

select isnt(
  (select hearted_at from public.post_comments where id = 'a1000000-0000-4000-8000-000000000001'::uuid),
  null,
  'and keeps the heart'
);

select results_eq(
  $$ select body, edited_at is not null, changed from public.edit_post_comment(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e1000000-0000-4000-8000-000000000001'::uuid, 'first comment, reworded') $$,
  $$ values ('first comment, reworded'::text, true, true) $$,
  'the author edits their comment'
);

select results_eq(
  $$ select body, edited_at is not null, hearted_at is null from public.post_comments
     where id = 'a1000000-0000-4000-8000-000000000001'::uuid $$,
  $$ values ('first comment, reworded'::text, true, true) $$,
  'the edit is stamped and takes the heart off'
);

select results_eq(
  $$ select previous_body from public.post_comment_edits
     where comment_id = 'a1000000-0000-4000-8000-000000000001'::uuid $$,
  $$ values ('first comment'::text) $$,
  'the words the edit replaced are kept, once'
);

-- ─── The pin ─────────────────────────────────────────────────────────────────

select throws_ok(
  $$ select * from public.set_post_comment_pin(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e1000000-0000-4000-8000-000000000001'::uuid, true) $$,
  'P0001', 'Only the post owner can pin this comment',
  'a comment''s author cannot pin it'
);

select throws_ok(
  $$ select * from public.set_post_comment_pin(
       'a1000000-0000-4000-8000-000000000003'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, true) $$,
  'P0001', 'Only a top-level comment can be pinned',
  'a reply cannot be pinned'
);

select results_eq(
  $$ select pinned, unpinned_comment_id from public.set_post_comment_pin(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, true) $$,
  $$ values (true, null::uuid) $$,
  'the post owner pins a comment'
);

select results_eq(
  $$ select pinned, unpinned_comment_id from public.set_post_comment_pin(
       'a1000000-0000-4000-8000-000000000002'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, true) $$,
  $$ values (true, 'a1000000-0000-4000-8000-000000000001'::uuid) $$,
  'pinning another moves the pin and names the one it left'
);

select results_eq(
  $$ select id from public.post_comments
     where post_id = 'f0000000-0000-4000-8000-000000000001'::uuid and pinned_at is not null $$,
  $$ values ('a1000000-0000-4000-8000-000000000002'::uuid) $$,
  'a post holds one pin'
);

select throws_ok(
  $$ update public.post_comments set pinned_at = now()
     where id = 'a1000000-0000-4000-8000-000000000001'::uuid $$,
  '23505', null,
  'a second pin on one post is refused by the table itself'
);

select throws_ok(
  $$ update public.post_comments set pinned_at = now()
     where id = 'a1000000-0000-4000-8000-000000000003'::uuid $$,
  '23514', null,
  'a pinned reply is refused by the table itself'
);

select results_eq(
  $$ select pinned, unpinned_comment_id from public.set_post_comment_pin(
       'a1000000-0000-4000-8000-000000000002'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, false) $$,
  $$ values (false, null::uuid) $$,
  'the post owner unpins'
);

-- ─── Removal clears the marks ────────────────────────────────────────────────

select lives_ok(
  $$ select * from public.set_post_comment_pin(
       'a1000000-0000-4000-8000-000000000002'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, true) $$,
  'pinned again'
);

select lives_ok(
  $$ select * from public.set_post_comment_heart(
       'a1000000-0000-4000-8000-000000000002'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, true) $$,
  'and hearted'
);

select lives_ok(
  $$ select * from public.set_post_comment_status(
       'a1000000-0000-4000-8000-000000000002'::uuid,
       'e1000000-0000-4000-8000-000000000001'::uuid, 'removed_by_author') $$,
  'its author deletes it'
);

select results_eq(
  $$ select status, pinned_at is null, hearted_at is null from public.post_comments
     where id = 'a1000000-0000-4000-8000-000000000002'::uuid $$,
  $$ values ('removed_by_author'::text, true, true) $$,
  'a removed comment keeps neither its pin nor its heart'
);

select throws_ok(
  $$ select * from public.set_post_comment_pin(
       'a1000000-0000-4000-8000-000000000002'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, true) $$,
  'P0001', 'Comment is not available',
  'a removed comment cannot be pinned'
);

select throws_ok(
  $$ select * from public.set_post_comment_reaction(
       'a1000000-0000-4000-8000-000000000002'::uuid,
       'e3000000-0000-4000-8000-000000000003'::uuid, 'like') $$,
  'P0001', 'Comment is not available',
  'or liked'
);

select throws_ok(
  $$ select * from public.edit_post_comment(
       'a1000000-0000-4000-8000-000000000002'::uuid,
       'e1000000-0000-4000-8000-000000000001'::uuid, 'back from the dead') $$,
  'P0001', 'Comment is not available',
  'or edited'
);

-- An account deletion removes the author's comments the same way.
select lives_ok(
  $$ select * from public.set_post_comment_pin(
       'a1000000-0000-4000-8000-000000000001'::uuid,
       'e2000000-0000-4000-8000-000000000002'::uuid, true) $$,
  'the first comment is pinned'
);

delete from auth.users where id = 'e1000000-0000-4000-8000-000000000001'::uuid;

select results_eq(
  $$ select status, pinned_at is null from public.post_comments
     where id = 'a1000000-0000-4000-8000-000000000001'::uuid $$,
  $$ values ('removed_by_author'::text, true) $$,
  'a deleted account''s pinned comment is removed and unpinned'
);

select * from finish();
rollback;
