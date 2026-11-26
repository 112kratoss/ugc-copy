-- Help & Support's Updates and Roadmap: no client role reads or writes them;
-- only a public post of the official account becomes an update; one reaction
-- per account on an update or a roadmap item, through the functions alone; a
-- locked post takes no new comment; an announced update alerts every
-- registered, active account once, never a guest, whatever retries; and a
-- shipped roadmap item tells everyone who reacted, once.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(62);

-- Row-level security.
select ok((select relrowsecurity from pg_class where oid = 'public.support_update_reactions'::regclass), 'support_update_reactions has row-level security enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.support_roadmap_items'::regclass), 'support_roadmap_items has row-level security enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.support_roadmap_reactions'::regclass), 'support_roadmap_reactions has row-level security enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.support_update_broadcasts'::regclass), 'support_update_broadcasts has row-level security enabled');
select has_index('public', 'posts', 'posts_support_updates_idx', 'updates are listed from their own index');

-- Privileges: no client role; the service role reads reactions and writes them only through the functions.
select ok(not has_table_privilege('anon', 'public.support_update_reactions', 'SELECT'), 'anon cannot read update reactions');
select ok(not has_table_privilege('authenticated', 'public.support_update_reactions', 'SELECT'), 'authenticated cannot read update reactions');
select ok(not has_table_privilege('authenticated', 'public.support_roadmap_items', 'SELECT'), 'authenticated cannot read the roadmap table');
select ok(not has_table_privilege('authenticated', 'public.support_roadmap_reactions', 'SELECT'), 'authenticated cannot read roadmap reactions');
select ok(not has_table_privilege('authenticated', 'public.support_update_broadcasts', 'SELECT'), 'authenticated cannot read broadcasts');
select ok(has_table_privilege('service_role', 'public.support_update_reactions', 'SELECT'), 'the service role reads update reactions');
select ok(not has_table_privilege('service_role', 'public.support_update_reactions', 'INSERT'), 'the service role writes update reactions only through the function');
select ok(not has_table_privilege('service_role', 'public.support_roadmap_reactions', 'INSERT'), 'the service role writes roadmap reactions only through the function');
select ok(has_table_privilege('service_role', 'public.support_roadmap_items', 'INSERT'), 'the service role keeps the roadmap');
select ok(has_table_privilege('service_role', 'public.support_update_broadcasts', 'INSERT'), 'the service role starts a broadcast');
select ok(not has_table_privilege('service_role', 'public.support_update_broadcasts', 'UPDATE'), 'a broadcast advances only through its batch function');

-- The functions: the service role's alone.
select ok(not has_function_privilege('authenticated', 'public.set_support_update(uuid, text, boolean)', 'EXECUTE'), 'authenticated cannot mark an update');
select ok(not has_function_privilege('authenticated', 'public.set_support_update_reaction(uuid, uuid, text)', 'EXECUTE'), 'authenticated cannot react to an update');
select ok(not has_function_privilege('authenticated', 'public.set_support_roadmap_reaction(uuid, uuid, text)', 'EXECUTE'), 'authenticated cannot react to a roadmap item');
select ok(not has_function_privilege('authenticated', 'public.support_update_alert_batch(uuid, integer)', 'EXECUTE'), 'authenticated cannot send alerts');
select ok(not has_function_privilege('anon', 'public.ship_support_roadmap_item(uuid, uuid, text, text)', 'EXECUTE'), 'anon cannot ship a roadmap item');
select ok(has_function_privilege('service_role', 'public.set_support_update(uuid, text, boolean)', 'EXECUTE'), 'the service role marks updates');
select ok(has_function_privilege('service_role', 'public.support_update_alert_batch(uuid, integer)', 'EXECUTE'), 'the service role sends alert batches');

-- Fixtures: the official account, another creator, two readers and a guest.
-- created_at is explicit: auth.users has no default for it.
insert into auth.users (id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at)
values
  ('a1000000-0000-4000-8000-000000000001'::uuid, 'hub-official@example.invalid', 'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'),
  ('a2000000-0000-4000-8000-000000000002'::uuid, 'hub-creator@example.invalid', 'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'),
  ('a3000000-0000-4000-8000-000000000003'::uuid, 'hub-reader-one@example.invalid', 'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'),
  ('a4000000-0000-4000-8000-000000000004'::uuid, 'hub-reader-two@example.invalid', 'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'),
  ('a5000000-0000-4000-8000-000000000005'::uuid, null, 'authenticated', 'authenticated', true, '{}'::jsonb, '{}'::jsonb, now() - interval '1 day'),
  ('a6000000-0000-4000-8000-000000000006'::uuid, 'hub-leaving@example.invalid', 'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'),
  ('a7000000-0000-4000-8000-000000000007'::uuid, 'hub-merged@example.invalid', 'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb, now() - interval '30 days');

update public.profiles set username = 'magicbooklet' where id = 'a1000000-0000-4000-8000-000000000001'::uuid;

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, title, body)
values
  ('b1000000-0000-4000-8000-000000000001'::uuid, 'a1000000-0000-4000-8000-000000000001'::uuid, 'public', 'text', 'external', 'text', 'Folders are here', 'Group your creations into folders.'),
  ('b2000000-0000-4000-8000-000000000002'::uuid, 'a2000000-0000-4000-8000-000000000002'::uuid, 'public', 'text', 'external', 'text', 'A creator post', 'Not an update.'),
  ('b3000000-0000-4000-8000-000000000003'::uuid, 'a1000000-0000-4000-8000-000000000001'::uuid, 'private', 'text', 'external', 'text', 'A draft', 'Private.');

select is(public.support_official_account_id(), 'a1000000-0000-4000-8000-000000000001'::uuid, 'the official account is the profile holding the reserved handle');

-- Only a public post of the official account becomes an update.
select is(public.set_support_update('b2000000-0000-4000-8000-000000000002'::uuid, 'announcement', null)->>'status', 'not_official', 'another account''s post cannot be an update');
select is(public.set_support_update('b3000000-0000-4000-8000-000000000003'::uuid, 'announcement', null)->>'status', 'not_public', 'a private post cannot be an update');
select is(public.set_support_update('b1000000-0000-4000-8000-000000000001'::uuid, 'news', null)->>'status', 'invalid', 'an update is an announcement or shipped');
select is(public.set_support_update('b1000000-0000-4000-8000-000000000001'::uuid, 'announcement', null)->>'status', 'set', 'the official account''s public post is marked an update');
select is((select support_update_kind from public.posts where id = 'b1000000-0000-4000-8000-000000000001'::uuid), 'announcement', 'the post carries its kind');

-- One reaction per account on an update.
select is(public.set_support_update_reaction('a3000000-0000-4000-8000-000000000003'::uuid, 'b1000000-0000-4000-8000-000000000001'::uuid, '👍')->'reactions', '{"👍": 1}'::jsonb, 'a reaction is counted');
select is(public.set_support_update_reaction('a3000000-0000-4000-8000-000000000003'::uuid, 'b1000000-0000-4000-8000-000000000001'::uuid, '❤️')->'reactions', '{"❤️": 1}'::jsonb, 'a second reaction replaces the first');
select is(public.set_support_update_reaction('a4000000-0000-4000-8000-000000000004'::uuid, 'b1000000-0000-4000-8000-000000000001'::uuid, '👍')->'reactions', '{"❤️": 1, "👍": 1}'::jsonb, 'each account has its own reaction');
select is(public.set_support_update_reaction('a3000000-0000-4000-8000-000000000003'::uuid, 'b2000000-0000-4000-8000-000000000002'::uuid, '👍')->>'status', 'not_found', 'a post that is not an update takes no reaction');
select is(public.set_support_update_reaction('a3000000-0000-4000-8000-000000000003'::uuid, 'b1000000-0000-4000-8000-000000000001'::uuid, '🎃')->>'status', 'invalid', 'a reaction is one of the quick reactions');
select is(public.set_support_update_reaction('a3000000-0000-4000-8000-000000000003'::uuid, 'b1000000-0000-4000-8000-000000000001'::uuid, null)->'reactions', '{"👍": 1}'::jsonb, 'a cleared reaction leaves the count');
select is(
  (select reactions from public.support_update_reactions_for(array['b1000000-0000-4000-8000-000000000001'::uuid, 'b2000000-0000-4000-8000-000000000002'::uuid], 'a4000000-0000-4000-8000-000000000004'::uuid) where post_id = 'b1000000-0000-4000-8000-000000000001'::uuid),
  '{"👍": 1}'::jsonb,
  'a page of updates reads its counts in one call'
);
select is(
  (select my_reaction from public.support_update_reactions_for(array['b1000000-0000-4000-8000-000000000001'::uuid], 'a4000000-0000-4000-8000-000000000004'::uuid)),
  '👍',
  'with the reader''s own reaction'
);

-- A locked post takes no new comment; unlocked, it does again.
select is(public.set_support_update('b1000000-0000-4000-8000-000000000001'::uuid, 'announcement', true)->>'commentsLocked', 'true', 'the console locks an update''s comments');
select throws_ok(
  $$ select * from public.create_post_comment('b1000000-0000-4000-8000-000000000001'::uuid, 'a3000000-0000-4000-8000-000000000003'::uuid, null, 'hello') $$,
  'P0001',
  'Comments are locked on this post',
  'a locked post takes no new comment'
);
select is(public.set_support_update('b1000000-0000-4000-8000-000000000001'::uuid, 'announcement', false)->>'commentsLocked', 'false', 'the console unlocks them');
select lives_ok(
  $$ select * from public.create_post_comment('b1000000-0000-4000-8000-000000000001'::uuid, 'a3000000-0000-4000-8000-000000000003'::uuid, null, 'hello') $$,
  'an unlocked update takes comments'
);

-- One account is being deleted, another was merged into a reader: neither is told anything.
update public.profiles set identity_state = 'deleting' where id = 'a6000000-0000-4000-8000-000000000006'::uuid;
update public.profiles
set merged_into_user_id = 'a3000000-0000-4000-8000-000000000003'::uuid,
    merged_at = now(),
    identity_state = 'merged'
where id = 'a7000000-0000-4000-8000-000000000007'::uuid;

-- An announced update alerts every registered, active account once.
insert into public.support_update_broadcasts (post_id, title, body)
values ('b1000000-0000-4000-8000-000000000001'::uuid, 'Folders are here', 'Group your creations into folders.');

-- Taken down, the update pauses its broadcast: nothing is sent and nothing ends.
update public.posts set archived_at = now() where id = 'b1000000-0000-4000-8000-000000000001'::uuid;
select is(public.support_update_alert_batch('b1000000-0000-4000-8000-000000000001'::uuid, 3)->>'status', 'paused', 'a taken-down update pauses its broadcast');
select ok((select finished_at is null and sent_count = 0 from public.support_update_broadcasts where post_id = 'b1000000-0000-4000-8000-000000000001'::uuid), 'a paused broadcast is not finished and has sent nothing');
update public.posts set archived_at = null where id = 'b1000000-0000-4000-8000-000000000001'::uuid;

select is(public.support_update_alert_batch('b1000000-0000-4000-8000-000000000001'::uuid, 3)->>'status', 'continuing', 'a full batch leaves more to send');
select is(public.support_update_alert_batch('b1000000-0000-4000-8000-000000000001'::uuid, 3)->>'status', 'finished', 'a short batch ends the broadcast');
select is((public.support_update_alert_batch('b1000000-0000-4000-8000-000000000001'::uuid, 3)->>'told')::integer, 0, 'a finished broadcast writes nothing');
select is(
  (select count(*)::integer from public.mobile_notifications where type = 'support_update' and object_id = 'b1000000-0000-4000-8000-000000000001'),
  3,
  'the three registered accounts other than the official one are told'
);
select is(
  (select count(*)::integer from public.mobile_notifications where type = 'support_update' and user_id = 'a1000000-0000-4000-8000-000000000001'::uuid),
  0,
  'the official account is not told about its own update'
);
select is(
  (select count(*)::integer from public.mobile_notifications where type = 'support_update' and user_id = 'a5000000-0000-4000-8000-000000000005'::uuid),
  0,
  'a guest is not told'
);
select is(
  (select count(*)::integer from public.mobile_notifications
   where type = 'support_update' and user_id in ('a6000000-0000-4000-8000-000000000006'::uuid, 'a7000000-0000-4000-8000-000000000007'::uuid)),
  0,
  'an account being deleted, or merged into another, is not told'
);

-- A retry from the start writes no second alert.
update public.support_update_broadcasts set next_after_user_id = null, finished_at = null where post_id = 'b1000000-0000-4000-8000-000000000001'::uuid;
select is((public.support_update_alert_batch('b1000000-0000-4000-8000-000000000001'::uuid, 10)->>'told')::integer, 0, 'a retry writes no alert twice');

-- The roadmap: one reaction per account; an archived item takes none.
insert into public.support_roadmap_items (id, title, summary, status, position)
values
  ('c1000000-0000-4000-8000-000000000001'::uuid, 'Folders for creations', 'Group what you make.', 'building', 0),
  ('c2000000-0000-4000-8000-000000000002'::uuid, 'Old idea', '', 'exploring', 1),
  ('c3000000-0000-4000-8000-000000000003'::uuid, 'Another idea', '', 'exploring', 2);
update public.support_roadmap_items set archived_at = now() where id = 'c2000000-0000-4000-8000-000000000002'::uuid;

select is(public.set_support_roadmap_reaction('a3000000-0000-4000-8000-000000000003'::uuid, 'c1000000-0000-4000-8000-000000000001'::uuid, '🙏')->>'status', 'reacted', 'a reader reacts to a roadmap item');
select is(public.set_support_roadmap_reaction('a4000000-0000-4000-8000-000000000004'::uuid, 'c1000000-0000-4000-8000-000000000001'::uuid, '👍')->'reactions', '{"👍": 1, "🙏": 1}'::jsonb, 'each reaction is one person''s');
select is(public.set_support_roadmap_reaction('a3000000-0000-4000-8000-000000000003'::uuid, 'c2000000-0000-4000-8000-000000000002'::uuid, '👍')->>'status', 'not_found', 'an archived item takes no reaction');

-- Shipping tells everyone who reacted and is still active, once.
select is(
  public.ship_support_roadmap_item('c2000000-0000-4000-8000-000000000002'::uuid, 'b1000000-0000-4000-8000-000000000001'::uuid, 'You asked, it''s live', 'Done.')->>'status',
  'not_found',
  'an archived item does not ship'
);
insert into public.support_roadmap_reactions (item_id, user_id, emoji)
values ('c1000000-0000-4000-8000-000000000001'::uuid, 'a6000000-0000-4000-8000-000000000006'::uuid, '👍');
select is(
  (public.ship_support_roadmap_item('c1000000-0000-4000-8000-000000000001'::uuid, 'b1000000-0000-4000-8000-000000000001'::uuid, 'You asked, it''s live', 'Folders are here.')->>'told')::integer,
  2,
  'both people who reacted and are still active are told'
);
select is(
  (select count(*)::integer from public.mobile_notifications
   where type = 'support_roadmap_shipped' and user_id = 'a6000000-0000-4000-8000-000000000006'::uuid),
  0,
  'a reactor whose account is being deleted is not told'
);
select ok(
  (select status = 'shipped' and shipped_at is not null and shipped_update_post_id = 'b1000000-0000-4000-8000-000000000001'::uuid
   from public.support_roadmap_items where id = 'c1000000-0000-4000-8000-000000000001'::uuid),
  'the item is shipped with the update that announced it'
);
select is(
  (public.ship_support_roadmap_item('c1000000-0000-4000-8000-000000000001'::uuid, 'b1000000-0000-4000-8000-000000000001'::uuid, 'You asked, it''s live', 'Folders are here.')->>'told')::integer,
  0,
  'shipping again tells no one twice'
);
select is(
  public.ship_support_roadmap_item('c3000000-0000-4000-8000-000000000003'::uuid, 'b2000000-0000-4000-8000-000000000002'::uuid, 'You asked, it''s live', 'Done.')->>'status',
  'update_not_found',
  'an item ships only with an update'
);
update public.posts set review_status = 'hidden' where id = 'b1000000-0000-4000-8000-000000000001'::uuid;
select is(
  public.ship_support_roadmap_item('c3000000-0000-4000-8000-000000000003'::uuid, 'b1000000-0000-4000-8000-000000000001'::uuid, 'You asked, it''s live', 'Done.')->>'status',
  'update_not_found',
  'an update hidden by review ships nothing'
);
update public.posts set review_status = 'visible' where id = 'b1000000-0000-4000-8000-000000000001'::uuid;
select throws_ok(
  $$ insert into public.support_roadmap_items (title, status) values ('Shipped without a date', 'shipped') $$,
  '23514',
  null,
  'a shipped item carries its shipping time'
);

select * from finish();
rollback;
