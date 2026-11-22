-- Help & support conversations: no client role reads or writes them; the
-- service role adds messages and changes them only through the support
-- functions; a send moves read receipts, unread counts and typing; a reply
-- quotes a message of its own conversation; an edit lasts 15 minutes and a
-- delete for everyone 48 hours, each the author's own; one reaction per side;
-- a person writing again reopens a resolved conversation; a photo is kept in
-- the account's own folder of a private bucket, and a delete names its copies
-- for Storage; and the account's deletion takes the conversation with it.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(108);

-- Row-level security and indexes.
select ok((select relrowsecurity from pg_class where oid = 'public.support_conversations'::regclass), 'support_conversations has row-level security enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.support_messages'::regclass), 'support_messages has row-level security enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.support_message_reactions'::regclass), 'support_message_reactions has row-level security enabled');
select has_index('public', 'support_conversations', 'support_conversations_inbox_idx', 'the console inbox is indexed by status and activity');
select has_index('public', 'support_messages', 'support_messages_conversation_created_idx', 'a thread is read in order from its index');

-- Privileges: no client role; the service role adds messages and reads reactions, and changes neither by hand.
select ok(not has_table_privilege('anon', 'public.support_conversations', 'SELECT'), 'anon cannot read conversations');
select ok(not has_table_privilege('authenticated', 'public.support_conversations', 'SELECT'), 'authenticated cannot read conversations');
select ok(not has_table_privilege('authenticated', 'public.support_conversations', 'INSERT'), 'authenticated cannot open conversations');
select ok(not has_table_privilege('anon', 'public.support_messages', 'SELECT'), 'anon cannot read messages');
select ok(not has_table_privilege('authenticated', 'public.support_messages', 'SELECT'), 'authenticated cannot read messages');
select ok(not has_table_privilege('authenticated', 'public.support_messages', 'INSERT'), 'authenticated cannot write messages');
select ok(not has_table_privilege('authenticated', 'public.support_message_reactions', 'SELECT'), 'authenticated cannot read reactions');
select ok(has_table_privilege('service_role', 'public.support_conversations', 'UPDATE'), 'the service role resolves conversations');
select ok(not has_table_privilege('service_role', 'public.support_conversations', 'DELETE'), 'the service role cannot delete a conversation');
select ok(has_table_privilege('service_role', 'public.support_messages', 'SELECT'), 'the service role reads messages');
select ok(has_table_privilege('service_role', 'public.support_messages', 'INSERT'), 'the service role adds messages');
select ok(not has_table_privilege('service_role', 'public.support_messages', 'UPDATE'), 'the service role changes a message only through the functions');
select ok(not has_table_privilege('service_role', 'public.support_messages', 'DELETE'), 'the service role never deletes a message row');
select ok(has_table_privilege('service_role', 'public.support_message_reactions', 'SELECT'), 'the service role reads reactions');
select ok(not has_table_privilege('service_role', 'public.support_message_reactions', 'INSERT'), 'the service role writes reactions only through the function');

-- The functions: the service role's alone.
select ok(not has_function_privilege('authenticated', 'public.send_support_message(uuid, text, text, text, uuid, jsonb)', 'EXECUTE'), 'authenticated cannot send');
select ok(not has_function_privilege('authenticated', 'public.edit_support_message(uuid, text, uuid, text)', 'EXECUTE'), 'authenticated cannot edit');
select ok(not has_function_privilege('authenticated', 'public.delete_support_message(uuid, text, uuid)', 'EXECUTE'), 'authenticated cannot delete');
select ok(not has_function_privilege('authenticated', 'public.set_support_message_reaction(uuid, text, uuid, text)', 'EXECUTE'), 'authenticated cannot react');
select ok(not has_function_privilege('authenticated', 'public.mark_support_conversation_read(uuid, text)', 'EXECUTE'), 'authenticated cannot mark read');
select ok(not has_function_privilege('authenticated', 'public.set_support_conversation_typing(uuid, text, boolean)', 'EXECUTE'), 'authenticated cannot say typing');
select ok(not has_function_privilege('anon', 'public.support_message_payload(uuid)', 'EXECUTE'), 'anon cannot read a message payload');
select ok(has_function_privilege('service_role', 'public.send_support_message(uuid, text, text, text, uuid, jsonb)', 'EXECUTE'), 'the service role sends');
select ok(has_function_privilege('service_role', 'public.edit_support_message(uuid, text, uuid, text)', 'EXECUTE'), 'the service role edits');
select ok(has_function_privilege('service_role', 'public.delete_support_message(uuid, text, uuid)', 'EXECUTE'), 'the service role deletes');
select ok(has_function_privilege('service_role', 'public.set_support_message_reaction(uuid, text, uuid, text)', 'EXECUTE'), 'the service role reacts');
select ok(has_function_privilege('service_role', 'public.mark_support_conversation_read(uuid, text)', 'EXECUTE'), 'the service role marks read');
select ok(has_function_privilege('service_role', 'public.set_support_conversation_typing(uuid, text, boolean)', 'EXECUTE'), 'the service role says typing');

-- created_at is explicit: auth.users has no default for it.
insert into auth.users (id, email, aud, role, is_anonymous, created_at, updated_at, raw_app_meta_data, raw_user_meta_data) values
  ('5c100000-0000-4000-8000-000000000001'::uuid, 'support-writer@example.invalid', 'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb),
  ('5c200000-0000-4000-8000-000000000002'::uuid, 'support-other@example.invalid', 'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb);

-- The first message opens the conversation.
select is(
  public.send_support_message('5c100000-0000-4000-8000-000000000001', 'user', '  My credits did not come back.  ', 'd5100000-0000-4000-8000-000000000001')->>'status',
  'sent',
  'an account''s first message is sent'
);
select is(
  (select body from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
   where c.user_id = '5c100000-0000-4000-8000-000000000001'),
  'My credits did not come back.',
  'the message is kept trimmed'
);
select is(
  public.send_support_message('5c100000-0000-4000-8000-000000000001', 'user', 'My credits did not come back.', 'd5100000-0000-4000-8000-000000000001')->>'status',
  'duplicate',
  'a retried send is answered as the copy already kept'
);
select is(
  (select count(*)::int from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
   where c.user_id = '5c100000-0000-4000-8000-000000000001'),
  1,
  'a retried send adds nothing'
);
select is(
  (select staff_unread_count from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  1,
  'support has one unread message'
);
select ok(
  (select awaiting_reply from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  'the account''s message waits on support'
);
select is(
  public.send_support_message('5c200000-0000-4000-8000-000000000002', 'staff', 'Hello?')->>'status',
  'not_found',
  'support cannot open a conversation the account never started'
);

-- Support says typing, then replies quoting the account's message.
select is(
  public.set_support_conversation_typing('5c100000-0000-4000-8000-000000000001', 'staff', true)->>'status',
  'ok',
  'support says it is typing'
);
select ok(
  (select staff_typing_until > clock_timestamp() from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  'support is typing for a few seconds'
);
select is(
  public.send_support_message(
    '5c100000-0000-4000-8000-000000000001', 'staff', 'Sorry about that. They are back.', 'd5100000-0000-4000-8000-000000000002',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'user')
  )#>>'{message,reply_to,body}',
  'My credits did not come back.',
  'a reply quotes the message it answers'
);
select is(
  (select staff_typing_until from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  null,
  'sending ends support''s typing'
);
select is(
  (select staff_unread_count from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  0,
  'writing is reading: support has nothing unread'
);
select is(
  (select user_unread_count from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  1,
  'the account has one unread reply'
);
select ok(
  not (select awaiting_reply from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  'an answered conversation no longer waits on support'
);

-- A reply may not quote a message of another conversation.
select public.send_support_message('5c200000-0000-4000-8000-000000000002', 'user', 'Another account', 'd5200000-0000-4000-8000-000000000001');
select is(
  public.send_support_message(
    '5c100000-0000-4000-8000-000000000001', 'user', 'Quoting across', null,
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c200000-0000-4000-8000-000000000002')
  )->>'status',
  'reply_not_found',
  'a reply to another conversation''s message is refused'
);

-- The account reads the thread.
select is(
  public.mark_support_conversation_read('5c100000-0000-4000-8000-000000000001', 'user')->>'status',
  'read',
  'the account reads its thread'
);
select is(
  (select user_unread_count from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  0,
  'reading clears the account''s unread count'
);
select ok(
  (select user_last_read_at >= last_staff_message_at from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  'the account''s read time is past support''s reply: two ticks'
);
select is(
  public.mark_support_conversation_read('5c300000-0000-4000-8000-000000000003', 'user')->>'status',
  'not_found',
  'no conversation, nothing read'
);

-- Edits: the author's own, within 15 minutes.
select is(
  public.edit_support_message(
    '5c100000-0000-4000-8000-000000000001', 'staff',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
    ' Sorry about that. All 40 are back. '
  )->>'status',
  'edited',
  'support edits its own reply'
);
select ok(
  (select m.body = 'Sorry about that. All 40 are back.' and m.edited_at is not null
   from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
   where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
  'the edit is kept trimmed, marked edited'
);
select is(
  public.edit_support_message(
    '5c100000-0000-4000-8000-000000000001', 'staff',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
    'Sorry about that. All 40 are back.'
  )->>'status',
  'unchanged',
  'the same text is no edit'
);
select is(
  public.edit_support_message(
    '5c100000-0000-4000-8000-000000000001', 'user',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
    'Rewritten'
  )->>'status',
  'not_yours',
  'the account cannot edit support''s message'
);
select is(
  public.edit_support_message(
    '5c200000-0000-4000-8000-000000000002', 'user',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'user'),
    'Across'
  )->>'status',
  'not_found',
  'a message of another conversation cannot be edited'
);
update public.support_messages m set created_at = clock_timestamp() - interval '16 minutes'
from public.support_conversations c
where c.id = m.conversation_id and c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'user';
select is(
  public.edit_support_message(
    '5c100000-0000-4000-8000-000000000001', 'user',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'user'),
    'Too late'
  )->>'status',
  'too_late',
  'an edit after 15 minutes is refused'
);

-- Reactions: one per side, from the quick set.
select is(
  public.set_support_message_reaction(
    '5c100000-0000-4000-8000-000000000001', 'user',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
    '🙏'
  )->>'status',
  'reacted',
  'the account reacts to support''s reply'
);
select is(
  public.set_support_message_reaction(
    '5c100000-0000-4000-8000-000000000001', 'user',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
    '❤️'
  )#>>'{message,reactions,0,emoji}',
  '❤️',
  'a second reaction replaces the first'
);
select public.set_support_message_reaction(
  '5c100000-0000-4000-8000-000000000001', 'staff',
  (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
   where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
  '👍'
);
select is(
  (select count(*)::int from public.support_message_reactions r join public.support_messages m on m.id = r.message_id
   join public.support_conversations c on c.id = m.conversation_id
   where c.user_id = '5c100000-0000-4000-8000-000000000001'),
  2,
  'each side keeps one reaction'
);
select is(
  public.set_support_message_reaction(
    '5c100000-0000-4000-8000-000000000001', 'user',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
    '🤡'
  )->>'status',
  'invalid',
  'a reaction outside the quick set is refused'
);
select is(
  jsonb_array_length(public.set_support_message_reaction(
    '5c100000-0000-4000-8000-000000000001', 'user',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
    null
  )->'message'->'reactions'),
  1,
  'null takes the account''s reaction away and leaves support''s'
);
select throws_ok(
  $$ insert into public.support_message_reactions (message_id, author, emoji)
     select m.id, 'user', '🎉' from public.support_messages m limit 1 $$,
  '23514',
  null,
  'the table itself keeps only the quick set'
);

-- Deletes for everyone: the author's own, within 48 hours.
select is(
  public.delete_support_message(
    '5c100000-0000-4000-8000-000000000001', 'user',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff')
  )->>'status',
  'not_yours',
  'the account cannot delete support''s message'
);
select is(
  public.delete_support_message(
    '5c100000-0000-4000-8000-000000000001', 'staff',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff')
  )->>'status',
  'deleted',
  'support deletes its own reply for everyone'
);
select ok(
  (select m.body is null and m.deleted_at is not null
   from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
   where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
  'a deleted message keeps its place with no text'
);
select is(
  (select count(*)::int from public.support_message_reactions r join public.support_messages m on m.id = r.message_id
   join public.support_conversations c on c.id = m.conversation_id
   where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
  0,
  'its reactions go with its text'
);
select is(
  (select last_message_preview from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  null,
  'the latest message deleted leaves no preview'
);
select is(
  public.delete_support_message(
    '5c100000-0000-4000-8000-000000000001', 'staff',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff')
  )->>'status',
  'deleted',
  'deleting it again answers it as it is'
);
select is(
  public.edit_support_message(
    '5c100000-0000-4000-8000-000000000001', 'staff',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
    'Back from the dead'
  )->>'status',
  'deleted',
  'a deleted message cannot be edited'
);
select is(
  public.set_support_message_reaction(
    '5c100000-0000-4000-8000-000000000001', 'user',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff'),
    '👍'
  )->>'status',
  'deleted',
  'a deleted message cannot be reacted to'
);
select is(
  public.send_support_message(
    '5c100000-0000-4000-8000-000000000001', 'user', 'Replying to it anyway', null,
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.author = 'staff')
  )->>'status',
  'reply_not_found',
  'a deleted message cannot be quoted'
);
update public.support_messages m set created_at = clock_timestamp() - interval '49 hours'
from public.support_conversations c
where c.id = m.conversation_id and c.user_id = '5c100000-0000-4000-8000-000000000001' and m.body = 'My credits did not come back.';
select is(
  public.delete_support_message(
    '5c100000-0000-4000-8000-000000000001', 'user',
    (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
     where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.body = 'My credits did not come back.')
  )->>'status',
  'too_late',
  'a delete after 48 hours is refused'
);
select throws_ok(
  $$ insert into public.support_messages (conversation_id, author, body, deleted_at)
     select id, 'user', 'Both', now() from public.support_conversations limit 1 $$,
  '23514',
  null,
  'a deleted message may not keep text'
);
select throws_ok(
  $$ insert into public.support_messages (conversation_id, author, body)
     select id, 'user', null from public.support_conversations limit 1 $$,
  '23514',
  null,
  'a kept message must have text'
);

-- Resolving and reopening.
update public.support_conversations set status = 'resolved', resolved_at = now()
where user_id = '5c100000-0000-4000-8000-000000000001';
select public.send_support_message('5c100000-0000-4000-8000-000000000001', 'staff', 'Anything else?');
select is(
  (select status from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  'resolved',
  'support writing leaves a resolved conversation resolved'
);
select public.send_support_message('5c100000-0000-4000-8000-000000000001', 'user', 'Yes, one more thing.');
select is(
  (select status from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  'open',
  'the account writing again reopens it'
);
select is(
  (select resolved_at from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  null,
  'a reopened conversation has no resolved time'
);
select is(
  (select last_message_preview from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  'Yes, one more thing.',
  'the preview follows the latest message'
);
select throws_ok(
  $$ update public.support_conversations set status = 'resolved', resolved_at = null
     where user_id = '5c100000-0000-4000-8000-000000000001' $$,
  '23514',
  null,
  'a resolved conversation needs its resolved time'
);

-- Refusals of what is not a message.
select is(
  public.send_support_message('5c100000-0000-4000-8000-000000000001', 'user', '   ')->>'status',
  'invalid',
  'an empty message is refused'
);
select is(
  public.send_support_message('5c100000-0000-4000-8000-000000000001', 'user', repeat('a', 2001))->>'status',
  'invalid',
  'a message over 2,000 characters is refused'
);
select is(
  public.send_support_message('5c100000-0000-4000-8000-000000000001', 'robot', 'Hi')->>'status',
  'invalid',
  'only the account or support writes'
);
select is(
  public.set_support_conversation_typing('5c300000-0000-4000-8000-000000000003', 'user', true)->>'status',
  'not_found',
  'no conversation, no-one to tell about typing'
);

-- Photos: kept in the account's own folder of a private bucket.
select ok((select not public from storage.buckets where id = 'support_attachments'), 'the photo bucket is private');
select is((select allowed_mime_types from storage.buckets where id = 'support_attachments'), array['image/webp']::text[], 'the server writes WebP alone to it');
select is(
  public.send_support_message('5c200000-0000-4000-8000-000000000002', 'user', '  ', 'd5200000-0000-4000-8000-000000000010', null,
    jsonb_build_object('kind', 'image', 'path', '5c200000-0000-4000-8000-000000000002/photo-1.webp', 'preview_path', '5c200000-0000-4000-8000-000000000002/photo-1.preview.webp', 'width', 1080, 'height', 1920, 'bytes', 123456, 'thumbhash', 'hash='))->>'status',
  'sent',
  'a photo goes without a caption'
);
select is(
  (select row(m.body, m.attachment_kind, m.attachment_width, m.attachment_height, m.attachment_bytes)::text
   from public.support_messages m where m.client_message_id = 'd5200000-0000-4000-8000-000000000010'),
  row(null::text, 'image', 1080, 1920, 123456)::text,
  'its message keeps the photo and no text'
);
select is(
  public.support_message_payload((select id from public.support_messages where client_message_id = 'd5200000-0000-4000-8000-000000000010'))->'attachment'->>'preview_path',
  '5c200000-0000-4000-8000-000000000002/photo-1.preview.webp',
  'the payload names the preview to the server'
);
select ok(
  (select last_message_has_photo and last_message_preview is null from public.support_conversations where user_id = '5c200000-0000-4000-8000-000000000002'),
  'the console''s list says the latest message is a photo'
);
select is(
  public.send_support_message('5c200000-0000-4000-8000-000000000002', 'user', 'x', 'd5200000-0000-4000-8000-000000000011', null,
    jsonb_build_object('kind', 'image', 'path', '5c100000-0000-4000-8000-000000000001/stolen.webp', 'preview_path', '5c100000-0000-4000-8000-000000000001/stolen.preview.webp', 'width', 1080, 'height', 1920, 'bytes', 123456, 'thumbhash', 'hash='))->>'status',
  'invalid',
  'a photo in another account''s folder is refused'
);
select is(
  public.send_support_message('5c200000-0000-4000-8000-000000000002', 'user', 'x', 'd5200000-0000-4000-8000-000000000012', null,
    jsonb_build_object('kind', 'image', 'path', '5c200000-0000-4000-8000-000000000002/../5c100000-0000-4000-8000-000000000001/stolen.webp', 'preview_path', '5c200000-0000-4000-8000-000000000002/../5c100000-0000-4000-8000-000000000001/stolen.preview.webp', 'width', 1080, 'height', 1920, 'bytes', 123456, 'thumbhash', 'hash='))->>'status',
  'invalid',
  'a photo path that climbs out of the folder is refused'
);
select is(
  public.send_support_message('5c200000-0000-4000-8000-000000000002', 'user', 'x', 'd5200000-0000-4000-8000-000000000013', null,
    jsonb_build_object('kind', 'image', 'path', '5c200000-0000-4000-8000-000000000002/huge.webp', 'preview_path', '5c200000-0000-4000-8000-000000000002/huge.preview.webp', 'width', 1080, 'height', 1920, 'bytes', 123456, 'thumbhash', 'hash=', 'width', 30000))->>'status',
  'invalid',
  'a photo past 20000 px a side is refused'
);
select is(
  public.send_support_message('5c200000-0000-4000-8000-000000000002', 'user', 'x', 'd5200000-0000-4000-8000-000000000014', null,
    jsonb_build_object('kind', 'image', 'path', '5c200000-0000-4000-8000-000000000002/clip.webp', 'preview_path', '5c200000-0000-4000-8000-000000000002/clip.preview.webp', 'width', 1080, 'height', 1920, 'bytes', 123456, 'thumbhash', 'hash=', 'kind', 'video'))->>'status',
  'invalid',
  'only a picture is a photo'
);
select is(
  (select count(*)::int from public.support_messages where client_message_id in (
    'd5200000-0000-4000-8000-000000000011', 'd5200000-0000-4000-8000-000000000012',
    'd5200000-0000-4000-8000-000000000013', 'd5200000-0000-4000-8000-000000000014')),
  0,
  'a refused photo writes nothing'
);
select is(
  public.send_support_message('5c200000-0000-4000-8000-000000000002', 'staff', 'Which screen is this?', 'd5200000-0000-4000-8000-000000000015',
    (select id from public.support_messages where client_message_id = 'd5200000-0000-4000-8000-000000000010'))->'message'->'reply_to'->>'attachment_kind',
  'image',
  'a reply''s quote says it quotes a photo'
);
select throws_ok(
  $$insert into public.support_messages (conversation_id, author, body)
    select id, 'user', null from public.support_conversations where user_id = '5c200000-0000-4000-8000-000000000002'$$,
  '23514',
  null,
  'a message with neither text nor a photo is refused'
);
select throws_ok(
  $$insert into public.support_messages (conversation_id, author, body, attachment_kind)
    select id, 'user', 'x', 'image' from public.support_conversations where user_id = '5c200000-0000-4000-8000-000000000002'$$,
  '23514',
  null,
  'a photo without its copies is refused'
);
select is(
  public.delete_support_message('5c200000-0000-4000-8000-000000000002', 'user',
    (select id from public.support_messages where client_message_id = 'd5200000-0000-4000-8000-000000000010'))->'removed_paths',
  jsonb_build_array('5c200000-0000-4000-8000-000000000002/photo-1.webp', '5c200000-0000-4000-8000-000000000002/photo-1.preview.webp'),
  'deleting a photo names both copies for Storage to remove'
);
select ok(
  (select deleted_at is not null and body is null and attachment_kind is null and attachment_path is null and attachment_preview_path is null
   from public.support_messages where client_message_id = 'd5200000-0000-4000-8000-000000000010'),
  'and the message keeps neither'
);
select ok(
  position('support_message' in (select pg_get_constraintdef(oid) from pg_constraint where conname = 'media_upload_intents_consumed_by_check')) > 0,
  'a support send may consume a staged upload'
);
select ok(
  position('support_attachments' in pg_get_functiondef('public.prepare_account_deletion(uuid)'::regprocedure)) > 0,
  'the account''s erasure lists the photo bucket'
);

-- The reply alert's type is allowed.
select lives_ok(
  $$ insert into public.mobile_notifications (user_id, type, title, body, deep_link, category, object_type, object_id, dedupe_key)
     values ('5c100000-0000-4000-8000-000000000001', 'support_reply', 'Support replied', 'Anything else?', '/support', 'system',
             'support_conversation', (select id::text from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
             'support-reply:test') $$,
  'a support_reply alert can be written'
);

-- Deleting the account takes its conversation, messages and reactions.
select public.set_support_message_reaction(
  '5c100000-0000-4000-8000-000000000001', 'staff',
  (select m.id from public.support_messages m join public.support_conversations c on c.id = m.conversation_id
   where c.user_id = '5c100000-0000-4000-8000-000000000001' and m.body = 'Yes, one more thing.'),
  '👍'
);
delete from auth.users where id = '5c100000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.support_conversations where user_id = '5c100000-0000-4000-8000-000000000001'),
  0,
  'the conversation goes with the account'
);
select is(
  (select count(*)::int from public.support_messages m left join public.support_conversations c on c.id = m.conversation_id where c.id is null),
  0,
  'its messages go with it'
);
select is(
  (select count(*)::int from public.support_message_reactions r left join public.support_messages m on m.id = r.message_id where m.id is null),
  0,
  'and its reactions'
);
select is(
  (select count(*)::int from public.support_conversations where user_id = '5c200000-0000-4000-8000-000000000002'),
  1,
  'another account''s conversation stays'
);

select * from finish();
rollback;
