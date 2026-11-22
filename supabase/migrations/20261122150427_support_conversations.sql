-- Help & support conversations. Until now an account reached support only by
-- email: the app's Help screen opened a mail to info@, and the web's contact
-- form landed in contact_messages, which holds no account and is answered by
-- mailto. Here an account writes to support from inside the product and the
-- operator answers from /admin/support, so the question, the answer and the
-- account stay together.
--
-- One conversation per account, open or resolved; a person writing again
-- reopens a resolved one. It works as a chat app does (owner, 2026-11-22:
-- "make the functionalities close to whatsapp as much as possible"): read
-- receipts and unread counts on both sides, a typing indicator, a reply that
-- quotes the message it answers, one reaction per side on a message, an edit
-- within 15 minutes and a delete for everyone within 48 hours of sending.
--
-- A message may carry one photo, with or without a caption (owner, 2026-11-22:
-- "Yes, build photos"). The server keeps two WebP copies of it, re-encoded so
-- nothing of the original file's metadata (a phone photo's location) survives:
-- the picture at up to 2560 px and a 720 px preview for the thread. Both live
-- in the private support_attachments bucket under the account's own folder,
-- whichever side sent them, so the account's deletion takes them with its
-- folder; clients only ever see short-lived signed links to them. A delete for
-- everyone takes the photo too: the function answers the two paths and the
-- service removes them from Storage.
--
-- The API is the only door. The account's routes read and write as the service
-- role after admitting a registered account (src/lib/route-identity-policy.ts),
-- and the console's after the operator's session (admin-auth.ts). No client
-- role is granted anything here, so no table carries the
-- authenticated_identity_active policy. Every change to a message goes through
-- one of the functions below; the service role itself may only read messages
-- and add them. Deleting the account deletes its conversation (ON DELETE
-- CASCADE from auth.users).

-- The locks this takes are on tables written all day (auth.users for the
-- foreign keys, mobile_notifications and media_upload_intents for their
-- checks): a release waits at most five seconds for one, and fails rather
-- than queueing every write behind it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.support_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  last_user_message_at timestamptz,
  last_staff_message_at timestamptz,
  -- The start of the latest message and who wrote it, for the console's list.
  -- NULL once that message was deleted.
  last_message_preview text CHECK (last_message_preview IS NULL OR char_length(last_message_preview) <= 200),
  last_message_author text CHECK (last_message_author IS NULL OR last_message_author IN ('user', 'staff')),
  -- The latest message is a photo: the list says "Photo" before its caption.
  last_message_has_photo boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  -- Read receipts: how far each side has read. A message the other side wrote
  -- at or before this time shows as read to its author.
  user_last_read_at timestamptz,
  staff_last_read_at timestamptz,
  -- Unread badges: the other side's messages since this side last read.
  user_unread_count integer NOT NULL DEFAULT 0 CHECK (user_unread_count >= 0),
  staff_unread_count integer NOT NULL DEFAULT 0 CHECK (staff_unread_count >= 0),
  -- "typing…": a side is writing until this time, a few seconds past its
  -- latest keystroke.
  user_typing_until timestamptz,
  staff_typing_until timestamptz,
  -- True while the account's latest message has no reply after it: the
  -- console's "Waiting on us" and the count on its menu.
  awaiting_reply boolean GENERATED ALWAYS AS (
    status = 'open'
    AND last_user_message_at IS NOT NULL
    AND (last_staff_message_at IS NULL OR last_user_message_at > last_staff_message_at)
  ) STORED,
  CONSTRAINT support_conversations_resolved_at_matches_status
    CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

COMMENT ON TABLE public.support_conversations IS
  'One help & support conversation per account. Written only through the support functions and the console''s resolve.';

-- The console's lists: open or resolved, newest activity first; and the
-- conversations waiting on support, oldest first.
CREATE INDEX support_conversations_inbox_idx
  ON public.support_conversations (status, last_message_at DESC);
CREATE INDEX support_conversations_awaiting_idx
  ON public.support_conversations (last_user_message_at)
  WHERE awaiting_reply;

CREATE TABLE public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.support_conversations(id) ON DELETE CASCADE,
  author text NOT NULL CHECK (author IN ('user', 'staff')),
  -- NULL once its author deleted it for everyone: only "This message was
  -- deleted" is left. A photo's caption, or NULL for a photo without one.
  body text,
  -- A client's own id for a message, so a send retried after a lost answer is
  -- kept once (send_support_message answers the first copy as a duplicate).
  client_message_id text CHECK (client_message_id IS NULL OR char_length(client_message_id) BETWEEN 8 AND 100),
  -- The message this one answers, always in the same conversation.
  reply_to_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  -- The photo the message carries, if any: its two copies in the
  -- support_attachments bucket (paths inside it, under the account's folder),
  -- the picture's size as it is drawn, the full copy's bytes, and the
  -- thumbhash a client draws while the preview loads.
  attachment_kind text CHECK (attachment_kind IS NULL OR attachment_kind = 'image'),
  attachment_path text,
  attachment_preview_path text,
  attachment_width integer,
  attachment_height integer,
  attachment_bytes integer,
  attachment_thumbhash text,
  CONSTRAINT support_messages_client_message_id_key UNIQUE (conversation_id, client_message_id),
  CONSTRAINT support_messages_reply_to_fkey FOREIGN KEY (reply_to_message_id)
    REFERENCES public.support_messages(id) ON DELETE SET NULL,
  -- Text, a photo, or both while the message stands; nothing once deleted.
  CONSTRAINT support_messages_content CHECK (
    (deleted_at IS NULL
      AND (body IS NOT NULL OR attachment_kind IS NOT NULL)
      AND (body IS NULL OR char_length(body) BETWEEN 1 AND 2000))
    OR (deleted_at IS NOT NULL AND body IS NULL AND attachment_kind IS NULL)
  ),
  CONSTRAINT support_messages_attachment_whole CHECK (
    (attachment_kind IS NULL
      AND attachment_path IS NULL AND attachment_preview_path IS NULL
      AND attachment_width IS NULL AND attachment_height IS NULL
      AND attachment_bytes IS NULL AND attachment_thumbhash IS NULL)
    OR (attachment_kind IS NOT NULL
      AND attachment_path IS NOT NULL AND attachment_preview_path IS NOT NULL
      AND attachment_path <> attachment_preview_path
      AND attachment_width BETWEEN 1 AND 20000
      AND attachment_height BETWEEN 1 AND 20000
      AND attachment_bytes BETWEEN 1 AND 10485760
      AND (attachment_thumbhash IS NULL OR char_length(attachment_thumbhash) <= 200))
  )
);

COMMENT ON TABLE public.support_messages IS
  'The messages of a support conversation, oldest first. Added by send_support_message; edited, deleted for everyone or reacted to only through the support functions.';

CREATE INDEX support_messages_conversation_created_idx
  ON public.support_messages (conversation_id, created_at, id);

-- A reply points at the message it quotes: deleting messages (an account's
-- deletion takes its whole conversation) clears those pointers through this
-- index rather than a scan of every message per row.
CREATE INDEX support_messages_reply_to_idx
  ON public.support_messages (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

-- One reaction per side on a message, from the quick set the clients offer.
CREATE TABLE public.support_message_reactions (
  message_id uuid NOT NULL REFERENCES public.support_messages(id) ON DELETE CASCADE,
  author text NOT NULL CHECK (author IN ('user', 'staff')),
  emoji text NOT NULL CHECK (emoji IN ('👍', '❤️', '😂', '😮', '😢', '🙏')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, author)
);

COMMENT ON TABLE public.support_message_reactions IS
  'Reactions on support messages: one per side per message, set and removed only through set_support_message_reaction.';

ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_message_reactions ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.support_conversations FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.support_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.support_message_reactions FROM PUBLIC, anon, authenticated;

-- New tables are born with the service role's full grant set. A conversation
-- is never deleted by hand (only with its account); a message is added by the
-- service role but changed only by the functions below, and a reaction is
-- written only by them.
REVOKE DELETE, TRUNCATE ON TABLE public.support_conversations FROM service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.support_messages FROM service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.support_message_reactions FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.support_conversations TO service_role;
GRANT SELECT, INSERT ON TABLE public.support_messages TO service_role;
GRANT SELECT ON TABLE public.support_message_reactions TO service_role;

-- The photos' two copies. Private, with no policy on storage.objects for any
-- client role: only the service role writes them and signs links to them. The
-- server writes WebP only, and a full copy stays well under the limit.
INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'support_attachments',
  'support_attachments',
  false,
  10485760,
  ARRAY['image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- A message as the functions answer it: the API's shape, with its photo, the
-- message it replies to and its reactions. The photo's paths go to the server
-- only, which answers clients with signed links instead, and the client's own
-- id only to the side that wrote the message, which settles its copy on the
-- way by it.
CREATE OR REPLACE FUNCTION public.support_message_payload(p_message_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', m.id,
    'author', m.author,
    'client_message_id', m.client_message_id,
    'body', m.body,
    'created_at', m.created_at,
    'edited_at', m.edited_at,
    'deleted_at', m.deleted_at,
    'attachment', CASE WHEN m.attachment_kind IS NULL THEN NULL ELSE jsonb_build_object(
      'kind', m.attachment_kind,
      'path', m.attachment_path,
      'preview_path', m.attachment_preview_path,
      'width', m.attachment_width,
      'height', m.attachment_height,
      'bytes', m.attachment_bytes,
      'thumbhash', m.attachment_thumbhash
    ) END,
    'reply_to', CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', r.id,
      'author', r.author,
      'body', r.body,
      'deleted_at', r.deleted_at,
      'attachment_kind', r.attachment_kind
    ) END,
    'reactions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('author', x.author, 'emoji', x.emoji) ORDER BY x.created_at)
      FROM public.support_message_reactions x
      WHERE x.message_id = m.id
    ), '[]'::jsonb)
  )
  FROM public.support_messages m
  LEFT JOIN public.support_messages r ON r.id = m.reply_to_message_id
  WHERE m.id = p_message_id
$$;

REVOKE ALL ON FUNCTION public.support_message_payload(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_message_payload(uuid) TO service_role;

-- Adds a message to an account's conversation, in one transaction with the
-- conversation's times, preview, status, read receipts and unread counts.
--   p_author 'user'  : the account itself. Opens the conversation on its first
--                      message and reopens a resolved one.
--   p_author 'staff' : the operator's reply. The conversation must exist, and
--                      its status is left as it is.
-- A message is 1 to 2000 characters once its leading and trailing whitespace
-- is trimmed; a photo's caption may also be empty. A repeated
-- p_client_message_id answers the message already kept, as 'duplicate', and
-- changes nothing. p_reply_to_message_id names a message of the same
-- conversation that is not deleted. p_attachment is the photo the server has
-- just stored: {kind: 'image', path, preview_path, width, height, bytes,
-- thumbhash}, both paths inside the account's own folder of
-- support_attachments, whichever side sends it.
CREATE OR REPLACE FUNCTION public.send_support_message(
  p_user_id uuid,
  p_author text,
  p_body text,
  p_client_message_id text DEFAULT NULL,
  p_reply_to_message_id uuid DEFAULT NULL,
  p_attachment jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_body text := btrim(coalesce(p_body, ''), E' \t\r\n');
  v_client_message_id text := nullif(btrim(coalesce(p_client_message_id, '')), '');
  v_attachment jsonb := CASE
    WHEN p_attachment IS NULL OR jsonb_typeof(p_attachment) = 'null' THEN NULL
    ELSE p_attachment
  END;
  v_folder text := p_user_id::text || '/';
  v_attachment_path text;
  v_attachment_preview_path text;
  v_attachment_width integer;
  v_attachment_height integer;
  v_attachment_bytes integer;
  v_attachment_thumbhash text;
  -- The wall clock, not the transaction's start: a thread is read in this
  -- order, and two messages written in one transaction must not tie. Taken
  -- again once the conversation is locked (below).
  v_now timestamptz := clock_timestamp();
  v_conversation public.support_conversations%ROWTYPE;
  v_message public.support_messages%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_author IS NULL OR p_author NOT IN ('user', 'staff') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'an account and an author of user or staff are required');
  END IF;

  IF v_attachment IS NULL AND (char_length(v_body) < 1 OR char_length(v_body) > 2000) THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'a message is 1 to 2000 characters');
  END IF;

  IF v_attachment IS NOT NULL THEN
    IF char_length(v_body) > 2000 THEN
      RETURN jsonb_build_object('status', 'invalid', 'error', 'a caption is at most 2000 characters');
    END IF;

    v_attachment_path := CASE WHEN jsonb_typeof(v_attachment) = 'object' THEN v_attachment->>'path' END;
    v_attachment_preview_path := CASE WHEN jsonb_typeof(v_attachment) = 'object' THEN v_attachment->>'preview_path' END;
    v_attachment_thumbhash := CASE WHEN jsonb_typeof(v_attachment) = 'object' THEN nullif(v_attachment->>'thumbhash', '') END;

    IF jsonb_typeof(v_attachment) <> 'object'
      OR coalesce(v_attachment->>'kind', '') <> 'image'
      OR v_attachment_path IS NULL
      OR v_attachment_preview_path IS NULL
      OR v_attachment_path = v_attachment_preview_path
      OR left(v_attachment_path, char_length(v_folder)) <> v_folder
      OR left(v_attachment_preview_path, char_length(v_folder)) <> v_folder
      OR v_attachment_path LIKE '%..%'
      OR v_attachment_preview_path LIKE '%..%'
      OR char_length(v_attachment_path) > 300
      OR char_length(v_attachment_preview_path) > 300
      OR coalesce(v_attachment->>'width', '') !~ '^[1-9][0-9]{0,4}$'
      OR coalesce(v_attachment->>'height', '') !~ '^[1-9][0-9]{0,4}$'
      OR coalesce(v_attachment->>'bytes', '') !~ '^[1-9][0-9]{0,7}$'
      OR (v_attachment_thumbhash IS NOT NULL AND char_length(v_attachment_thumbhash) > 200)
    THEN
      RETURN jsonb_build_object('status', 'invalid', 'error', 'a photo is an image kept in the account''s own folder');
    END IF;

    v_attachment_width := (v_attachment->>'width')::integer;
    v_attachment_height := (v_attachment->>'height')::integer;
    v_attachment_bytes := (v_attachment->>'bytes')::integer;

    IF v_attachment_width > 20000 OR v_attachment_height > 20000 OR v_attachment_bytes > 10485760 THEN
      RETURN jsonb_build_object('status', 'invalid', 'error', 'a photo is at most 20000 px a side and 10 MB');
    END IF;
  END IF;

  IF v_client_message_id IS NOT NULL AND char_length(v_client_message_id) NOT BETWEEN 8 AND 100 THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'a client message id is 8 to 100 characters');
  END IF;

  IF p_author = 'user' THEN
    INSERT INTO public.support_conversations (user_id, created_at, last_message_at)
    VALUES (p_user_id, v_now, v_now)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  -- Two writes to one conversation wait for each other here, so a retried
  -- send always finds the copy the first one kept.
  SELECT * INTO v_conversation
  FROM public.support_conversations
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Stamped once the conversation is locked, so messages are timed in the
  -- order they are kept: a side that has read up to one message has never
  -- passed over another kept after it with an earlier time.
  v_now := clock_timestamp();

  IF v_client_message_id IS NOT NULL THEN
    SELECT * INTO v_message
    FROM public.support_messages
    WHERE conversation_id = v_conversation.id
      AND client_message_id = v_client_message_id;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'status', 'duplicate',
        'conversation_id', v_conversation.id,
        'conversation_status', v_conversation.status,
        'message', public.support_message_payload(v_message.id)
      );
    END IF;
  END IF;

  IF p_reply_to_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.support_messages
    WHERE id = p_reply_to_message_id
      AND conversation_id = v_conversation.id
      AND deleted_at IS NULL
  ) THEN
    RETURN jsonb_build_object('status', 'reply_not_found');
  END IF;

  INSERT INTO public.support_messages (
    conversation_id, author, body, client_message_id, reply_to_message_id, created_at,
    attachment_kind, attachment_path, attachment_preview_path,
    attachment_width, attachment_height, attachment_bytes, attachment_thumbhash
  )
  VALUES (
    v_conversation.id, p_author, nullif(v_body, ''), v_client_message_id, p_reply_to_message_id, v_now,
    CASE WHEN v_attachment IS NULL THEN NULL ELSE 'image' END, v_attachment_path, v_attachment_preview_path,
    v_attachment_width, v_attachment_height, v_attachment_bytes, v_attachment_thumbhash
  )
  RETURNING * INTO v_message;

  -- Writing is reading: the writer has seen the whole thread and stops typing,
  -- and the other side has one more unread message.
  UPDATE public.support_conversations
  SET last_message_at = v_now,
      last_user_message_at = CASE WHEN p_author = 'user' THEN v_now ELSE last_user_message_at END,
      last_staff_message_at = CASE WHEN p_author = 'staff' THEN v_now ELSE last_staff_message_at END,
      last_message_preview = nullif(left(v_body, 200), ''),
      last_message_author = p_author,
      last_message_has_photo = v_attachment IS NOT NULL,
      status = CASE WHEN p_author = 'user' THEN 'open' ELSE status END,
      resolved_at = CASE WHEN p_author = 'user' THEN NULL ELSE resolved_at END,
      user_last_read_at = CASE WHEN p_author = 'user' THEN v_now ELSE user_last_read_at END,
      staff_last_read_at = CASE WHEN p_author = 'staff' THEN v_now ELSE staff_last_read_at END,
      user_unread_count = CASE WHEN p_author = 'user' THEN 0 ELSE user_unread_count + 1 END,
      staff_unread_count = CASE WHEN p_author = 'staff' THEN 0 ELSE staff_unread_count + 1 END,
      user_typing_until = CASE WHEN p_author = 'user' THEN NULL ELSE user_typing_until END,
      staff_typing_until = CASE WHEN p_author = 'staff' THEN NULL ELSE staff_typing_until END
  WHERE id = v_conversation.id
  RETURNING * INTO v_conversation;

  RETURN jsonb_build_object(
    'status', 'sent',
    'conversation_id', v_conversation.id,
    'conversation_status', v_conversation.status,
    'message', public.support_message_payload(v_message.id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.send_support_message(uuid, text, text, text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_support_message(uuid, text, text, text, uuid, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.send_support_message(uuid, text, text, text, uuid, jsonb) IS
  'Service-role-only: adds an account''s message or the operator''s reply, with or without a photo, to the account''s support conversation.';

-- Changes the text of one's own message within 15 minutes of sending it, as a
-- chat app allows. The conversation's preview follows when it is the latest
-- message.
CREATE OR REPLACE FUNCTION public.edit_support_message(
  p_user_id uuid,
  p_author text,
  p_message_id uuid,
  p_body text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_body text := btrim(coalesce(p_body, ''), E' \t\r\n');
  v_now timestamptz := clock_timestamp();
  v_conversation public.support_conversations%ROWTYPE;
  v_message public.support_messages%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_message_id IS NULL OR p_author IS NULL OR p_author NOT IN ('user', 'staff') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'an account, a message and an author of user or staff are required');
  END IF;

  IF char_length(v_body) < 1 OR char_length(v_body) > 2000 THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'a message is 1 to 2000 characters');
  END IF;

  SELECT * INTO v_conversation
  FROM public.support_conversations
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  v_now := clock_timestamp();

  SELECT * INTO v_message
  FROM public.support_messages
  WHERE id = p_message_id
    AND conversation_id = v_conversation.id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_message.author <> p_author THEN
    RETURN jsonb_build_object('status', 'not_yours');
  END IF;

  IF v_message.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'deleted');
  END IF;

  IF v_message.created_at < v_now - interval '15 minutes' THEN
    RETURN jsonb_build_object('status', 'too_late');
  END IF;

  IF v_message.body = v_body THEN
    RETURN jsonb_build_object('status', 'unchanged', 'message', public.support_message_payload(v_message.id));
  END IF;

  UPDATE public.support_messages
  SET body = v_body,
      edited_at = v_now
  WHERE id = v_message.id;

  IF NOT EXISTS (
    SELECT 1
    FROM public.support_messages later
    WHERE later.conversation_id = v_conversation.id
      AND (later.created_at, later.id) > (v_message.created_at, v_message.id)
  ) THEN
    UPDATE public.support_conversations
    SET last_message_preview = left(v_body, 200)
    WHERE id = v_conversation.id;
  END IF;

  RETURN jsonb_build_object('status', 'edited', 'message', public.support_message_payload(v_message.id));
END;
$$;

REVOKE ALL ON FUNCTION public.edit_support_message(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.edit_support_message(uuid, text, uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.edit_support_message(uuid, text, uuid, text) IS
  'Service-role-only: changes the text of one''s own support message within 15 minutes of sending it.';

-- Deletes one's own message for everyone within 48 hours of sending it: the
-- text and the photo go, "This message was deleted" stays in its place, and
-- its reactions go with them. The answer names the photo's two copies
-- (removed_paths, inside support_attachments) for the service to remove from
-- Storage, which a database function cannot do.
CREATE OR REPLACE FUNCTION public.delete_support_message(
  p_user_id uuid,
  p_author text,
  p_message_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_conversation public.support_conversations%ROWTYPE;
  v_message public.support_messages%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_message_id IS NULL OR p_author IS NULL OR p_author NOT IN ('user', 'staff') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'an account, a message and an author of user or staff are required');
  END IF;

  SELECT * INTO v_conversation
  FROM public.support_conversations
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  v_now := clock_timestamp();

  SELECT * INTO v_message
  FROM public.support_messages
  WHERE id = p_message_id
    AND conversation_id = v_conversation.id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_message.author <> p_author THEN
    RETURN jsonb_build_object('status', 'not_yours');
  END IF;

  IF v_message.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'deleted', 'message', public.support_message_payload(v_message.id));
  END IF;

  IF v_message.created_at < v_now - interval '48 hours' THEN
    RETURN jsonb_build_object('status', 'too_late');
  END IF;

  DELETE FROM public.support_message_reactions WHERE message_id = v_message.id;

  UPDATE public.support_messages
  SET body = NULL,
      deleted_at = v_now,
      attachment_kind = NULL,
      attachment_path = NULL,
      attachment_preview_path = NULL,
      attachment_width = NULL,
      attachment_height = NULL,
      attachment_bytes = NULL,
      attachment_thumbhash = NULL
  WHERE id = v_message.id;

  IF NOT EXISTS (
    SELECT 1
    FROM public.support_messages later
    WHERE later.conversation_id = v_conversation.id
      AND (later.created_at, later.id) > (v_message.created_at, v_message.id)
  ) THEN
    UPDATE public.support_conversations
    SET last_message_preview = NULL,
        last_message_has_photo = false
    WHERE id = v_conversation.id;
  END IF;

  -- A deleted message waits on nobody: each side's latest message and unread
  -- count are counted again without it. A deleted question leaves "Waiting on
  -- us" and its unread badge; a deleted reply puts the question back.
  UPDATE public.support_conversations AS c
  SET last_user_message_at = (
        SELECT max(m.created_at) FROM public.support_messages AS m
        WHERE m.conversation_id = c.id AND m.author = 'user' AND m.deleted_at IS NULL
      ),
      last_staff_message_at = (
        SELECT max(m.created_at) FROM public.support_messages AS m
        WHERE m.conversation_id = c.id AND m.author = 'staff' AND m.deleted_at IS NULL
      ),
      user_unread_count = (
        SELECT count(*) FROM public.support_messages AS m
        WHERE m.conversation_id = c.id AND m.author = 'staff' AND m.deleted_at IS NULL
          AND (c.user_last_read_at IS NULL OR m.created_at > c.user_last_read_at)
      ),
      staff_unread_count = (
        SELECT count(*) FROM public.support_messages AS m
        WHERE m.conversation_id = c.id AND m.author = 'user' AND m.deleted_at IS NULL
          AND (c.staff_last_read_at IS NULL OR m.created_at > c.staff_last_read_at)
      )
  WHERE c.id = v_conversation.id;

  RETURN jsonb_build_object(
    'status', 'deleted',
    'message', public.support_message_payload(v_message.id),
    'removed_paths', CASE
      WHEN v_message.attachment_kind IS NULL THEN '[]'::jsonb
      ELSE jsonb_build_array(v_message.attachment_path, v_message.attachment_preview_path)
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_support_message(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_support_message(uuid, text, uuid)
  TO service_role;

COMMENT ON FUNCTION public.delete_support_message(uuid, text, uuid) IS
  'Service-role-only: deletes one''s own support message for everyone within 48 hours of sending it.';

-- Sets or clears a side's reaction on a message of the conversation. A side
-- has at most one reaction per message; NULL takes it away.
CREATE OR REPLACE FUNCTION public.set_support_message_reaction(
  p_user_id uuid,
  p_author text,
  p_message_id uuid,
  p_emoji text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_conversation public.support_conversations%ROWTYPE;
  v_message public.support_messages%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_message_id IS NULL OR p_author IS NULL OR p_author NOT IN ('user', 'staff') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'an account, a message and an author of user or staff are required');
  END IF;

  IF p_emoji IS NOT NULL AND p_emoji NOT IN ('👍', '❤️', '😂', '😮', '😢', '🙏') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'a reaction is one of the quick reactions');
  END IF;

  SELECT * INTO v_conversation
  FROM public.support_conversations
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  v_now := clock_timestamp();

  SELECT * INTO v_message
  FROM public.support_messages
  WHERE id = p_message_id
    AND conversation_id = v_conversation.id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_message.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'deleted');
  END IF;

  IF p_emoji IS NULL THEN
    DELETE FROM public.support_message_reactions
    WHERE message_id = v_message.id
      AND author = p_author;
  ELSE
    INSERT INTO public.support_message_reactions (message_id, author, emoji, created_at)
    VALUES (v_message.id, p_author, p_emoji, v_now)
    ON CONFLICT (message_id, author) DO UPDATE
      SET emoji = EXCLUDED.emoji,
          created_at = EXCLUDED.created_at;
  END IF;

  RETURN jsonb_build_object('status', 'reacted', 'message', public.support_message_payload(v_message.id));
END;
$$;

REVOKE ALL ON FUNCTION public.set_support_message_reaction(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_support_message_reaction(uuid, text, uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.set_support_message_reaction(uuid, text, uuid, text) IS
  'Service-role-only: sets or clears a side''s quick reaction on a support message.';

-- A side has read the thread up to a message it was shown
-- (p_up_to_message_id), or all of it without one: its read time moves on to
-- that message's time (never back), so a message kept after the reader's last
-- look is not read unseen, and its unread count is what the other side wrote
-- after that and still stands. An id of no message of the conversation
-- changes nothing.
CREATE OR REPLACE FUNCTION public.mark_support_conversation_read(
  p_user_id uuid,
  p_reader text,
  p_up_to_message_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_read_at timestamptz;
  v_conversation public.support_conversations%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_reader IS NULL OR p_reader NOT IN ('user', 'staff') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'an account and a reader of user or staff are required');
  END IF;

  SELECT * INTO v_conversation
  FROM public.support_conversations
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF p_up_to_message_id IS NULL THEN
    v_read_at := clock_timestamp();
  ELSE
    SELECT created_at INTO v_read_at
    FROM public.support_messages
    WHERE id = p_up_to_message_id
      AND conversation_id = v_conversation.id;
  END IF;

  IF v_read_at IS NOT NULL THEN
    v_read_at := greatest(
      coalesce(CASE WHEN p_reader = 'user' THEN v_conversation.user_last_read_at ELSE v_conversation.staff_last_read_at END, v_read_at),
      v_read_at
    );

    UPDATE public.support_conversations
    SET user_last_read_at = CASE WHEN p_reader = 'user' THEN v_read_at ELSE user_last_read_at END,
        staff_last_read_at = CASE WHEN p_reader = 'staff' THEN v_read_at ELSE staff_last_read_at END,
        user_unread_count = CASE WHEN p_reader = 'user' THEN (
          SELECT count(*) FROM public.support_messages AS m
          WHERE m.conversation_id = v_conversation.id AND m.author = 'staff'
            AND m.deleted_at IS NULL AND m.created_at > v_read_at
        ) ELSE user_unread_count END,
        staff_unread_count = CASE WHEN p_reader = 'staff' THEN (
          SELECT count(*) FROM public.support_messages AS m
          WHERE m.conversation_id = v_conversation.id AND m.author = 'user'
            AND m.deleted_at IS NULL AND m.created_at > v_read_at
        ) ELSE staff_unread_count END
    WHERE id = v_conversation.id
    RETURNING * INTO v_conversation;
  END IF;

  RETURN jsonb_build_object(
    'status', 'read',
    'user_last_read_at', v_conversation.user_last_read_at,
    'staff_last_read_at', v_conversation.staff_last_read_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_support_conversation_read(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_support_conversation_read(uuid, text, uuid)
  TO service_role;

COMMENT ON FUNCTION public.mark_support_conversation_read(uuid, text, uuid) IS
  'Service-role-only: records how far the account or support has read its support conversation.';

-- "typing…": a side is writing for the next 8 seconds, or has stopped.
CREATE OR REPLACE FUNCTION public.set_support_conversation_typing(
  p_user_id uuid,
  p_author text,
  p_typing boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_until timestamptz := CASE WHEN coalesce(p_typing, false) THEN clock_timestamp() + interval '8 seconds' ELSE NULL END;
BEGIN
  IF p_user_id IS NULL OR p_author IS NULL OR p_author NOT IN ('user', 'staff') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'an account and an author of user or staff are required');
  END IF;

  UPDATE public.support_conversations
  SET user_typing_until = CASE WHEN p_author = 'user' THEN v_until ELSE user_typing_until END,
      staff_typing_until = CASE WHEN p_author = 'staff' THEN v_until ELSE staff_typing_until END
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  RETURN jsonb_build_object('status', 'ok');
END;
$$;

REVOKE ALL ON FUNCTION public.set_support_conversation_typing(uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_support_conversation_typing(uuid, text, boolean)
  TO service_role;

COMMENT ON FUNCTION public.set_support_conversation_typing(uuid, text, boolean) IS
  'Service-role-only: says that the account or support is typing in its support conversation, for a few seconds.';

-- A photo sent to support is staged in the uploads bucket like any upload and
-- claimed by the send, which records it as consumed by 'support_message'. The
-- consumer check from 20260803120000_media_upload_intents.sql would refuse
-- that name.
ALTER TABLE public.media_upload_intents DROP CONSTRAINT IF EXISTS media_upload_intents_consumed_by_check;
ALTER TABLE public.media_upload_intents ADD CONSTRAINT media_upload_intents_consumed_by_check CHECK (consumed_by IN (
  'post_publish',
  'post_update',
  'generation_input',
  'generation_restore',
  'support_message'
));

-- An account's deletion takes its support photos with its folder of
-- support_attachments: the erasure manifest lists that bucket with the others
-- whose objects sit under the account's id. Copied from
-- 20261030151942_post_keeps_its_deleted_creation_folder.sql with that one
-- bucket added (src/lib/account-deletion-service.ts reads the same list).
CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_showcase_paths jsonb;
  v_template_prefixes jsonb;
  v_manifest jsonb;
  v_job public.account_deletion_jobs%ROWTYPE;
  v_owner_ids uuid[];
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('account-deletion:' || p_user_id::text, 0)
  );

  SELECT *
  INTO v_job
  FROM public.account_deletion_jobs
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF FOUND AND v_job.status = 'completed' THEN
    RETURN jsonb_build_object(
      'status', 'already_completed',
      'user_id', p_user_id,
      'attempt_count', v_job.attempt_count,
      'storage_manifest', v_job.storage_manifest
    );
  END IF;

  IF FOUND
    AND jsonb_typeof(v_job.storage_manifest->'owner_user_ids') = 'array'
    AND jsonb_array_length(v_job.storage_manifest->'owner_user_ids') > 0 THEN
    SELECT array_agg(value::uuid ORDER BY value::uuid)
    INTO v_owner_ids
    FROM jsonb_array_elements_text(
      v_job.storage_manifest->'owner_user_ids'
    ) AS persisted(value);

    UPDATE public.profiles
    SET identity_state = 'deleting'
    WHERE id = ANY(v_owner_ids)
      AND identity_state <> 'deleting';

    UPDATE public.account_deletion_jobs
    SET attempt_count = attempt_count + 1,
        last_attempt_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    WHERE user_id = p_user_id
    RETURNING * INTO v_job;

    RETURN jsonb_build_object(
      'status', 'prepared',
      'user_id', v_job.user_id,
      'attempt_count', v_job.attempt_count,
      'storage_manifest', v_job.storage_manifest
    );
  END IF;

  -- Lock every current member and the target deterministically. The profile
  -- trigger prevents a concurrent merge from adding another guest after the
  -- target moves to deleting.
  PERFORM 1
  FROM public.profiles
  WHERE id = p_user_id OR merged_into_user_id = p_user_id
  ORDER BY id
  FOR UPDATE;

  SELECT array_agg(owner.id ORDER BY owner.id)
  INTO v_owner_ids
  FROM (
    SELECT p_user_id AS id
    UNION
    SELECT id
    FROM public.profiles
    WHERE merged_into_user_id = p_user_id
  ) AS owner;

  UPDATE public.profiles
  SET identity_state = 'deleting'
  WHERE id = ANY(v_owner_ids)
    AND identity_state <> 'deleting';

  SELECT coalesce(jsonb_agg(distinct path ORDER BY path), '[]'::jsonb)
  INTO v_showcase_paths
  FROM (
    SELECT g.showcase_asset_path AS path FROM public.generations g
    WHERE g.user_id = any(v_owner_ids)
      AND starts_with(btrim(g.showcase_asset_path), 'showcase/' || g.id::text || '/')
    UNION
    SELECT paths.path FROM public.posts p
    CROSS JOIN LATERAL (
      SELECT p.showcase_asset_path AS path
      UNION SELECT o.name FROM storage.objects o WHERE o.bucket_id='post_media'
        AND starts_with(o.name, 'private-posts/' || p.id::text || '/')
      UNION SELECT unnest(array[m.storage_path,m.preview_storage_path,m.display_storage_path,
        m.rendition_storage_path,m.teaser_storage_path]) FROM public.post_media m WHERE m.post_id = p.id
      UNION SELECT unnest(array[m.storage_path,m.preview_storage_path,m.rendition_storage_path])
        FROM public.post_resource_purchase_media m
        JOIN public.post_resource_bundle_purchases purchase ON purchase.id=m.purchase_id
        JOIN public.post_resource_bundles bundle ON bundle.id=purchase.bundle_id
        WHERE bundle.post_id=p.id
    ) paths
    WHERE p.user_id = any(v_owner_ids) AND (
      starts_with(btrim(paths.path), 'posts/' || p.id::text || '/')
      OR starts_with(btrim(paths.path), 'private-posts/' || p.id::text || '/')
      -- A creation's copy, under private-posts/ for one marked NSFW: of a
      -- creation the account made, or of the deleted one the post recorded.
      OR ((starts_with(btrim(paths.path), 'showcase/' || coalesce(p.generation_id, p.deleted_generation_id)::text || '/')
          OR starts_with(btrim(paths.path), 'private-posts/' || coalesce(p.generation_id, p.deleted_generation_id)::text || '/'))
        AND (p.generation_id IS NULL OR EXISTS (
          SELECT 1 FROM public.generations g WHERE g.id=p.generation_id AND g.user_id=any(v_owner_ids)
        )))
    )
  ) owned_paths;

  SELECT coalesce(jsonb_agg(template.id::text ORDER BY template.id::text), '[]'::jsonb)
  INTO v_template_prefixes
  FROM public.templates AS template
  WHERE template.creator_user_id = ANY(v_owner_ids);

  v_manifest := jsonb_build_object(
    'owner_user_ids', to_jsonb(v_owner_ids),
    'user_prefix_buckets', jsonb_build_array(
      'profiles',
      'uploads',
      'generated_images',
      'generated_videos',
      'generated_audio',
      'generation_inputs',
      'post_resource_files',
      'template_inputs',
      'support_attachments'
    ),
    'showcase_media_paths', v_showcase_paths,
    'template_asset_prefixes', v_template_prefixes,
    'retention_policy', jsonb_build_object(
      'user_private_media', 'delete',
      'showcase_media', 'delete',
      'template_assets', 'delete',
      'template_database_snapshots', 'anonymize'
    )
  );

  INSERT INTO public.account_deletion_jobs (
    user_id,
    status,
    storage_manifest,
    attempt_count,
    last_error,
    requested_at,
    last_attempt_at,
    updated_at
  ) VALUES (
    p_user_id,
    'requested',
    v_manifest,
    1,
    NULL,
    timezone('utc'::text, now()),
    timezone('utc'::text, now()),
    timezone('utc'::text, now())
  )
  ON CONFLICT (user_id) DO UPDATE
  SET storage_manifest = EXCLUDED.storage_manifest,
      attempt_count = public.account_deletion_jobs.attempt_count + 1,
      last_error = NULL,
      last_attempt_at = timezone('utc'::text, now()),
      updated_at = timezone('utc'::text, now())
  RETURNING * INTO v_job;

  RETURN jsonb_build_object(
    'status', 'prepared',
    'user_id', v_job.user_id,
    'attempt_count', v_job.attempt_count,
    'storage_manifest', v_job.storage_manifest
  );
END;
$$;

-- Storage refuses a write into an account's folder once its deletion has
-- blocked the owner, so nothing lands after the sweep proved the folder
-- empty. The guard of 20260819071500_complete_upload_capability_state_machine.sql,
-- unchanged but for support_attachments in its two lists of the buckets
-- kept under an account's folder.
CREATE OR REPLACE FUNCTION public.guard_upload_storage_object_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_key text;
  v_new_key text;
  v_old_owner text;
  v_new_owner text;
BEGIN
  v_new_owner := split_part(NEW.name, '/', 1);
  v_old_owner := CASE WHEN TG_OP = 'UPDATE'
    THEN split_part(OLD.name, '/', 1) ELSE v_new_owner END;

  -- Account deletion takes owner then path locks. Storage must use the same
  -- order so even a service-created object with no reservation cannot commit
  -- after the deletion sweep has proven the prefix empty.
  IF v_old_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND v_new_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND v_old_owner <> v_new_owner THEN
    IF v_old_owner < v_new_owner THEN
      PERFORM public.lock_upload_owner(v_old_owner::uuid);
      PERFORM public.lock_upload_owner(v_new_owner::uuid);
    ELSE
      PERFORM public.lock_upload_owner(v_new_owner::uuid);
      PERFORM public.lock_upload_owner(v_old_owner::uuid);
    END IF;
  ELSIF v_new_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM public.lock_upload_owner(v_new_owner::uuid);
  ELSIF v_old_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM public.lock_upload_owner(v_old_owner::uuid);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old_key := OLD.bucket_id || '/' || OLD.name;
    v_new_key := NEW.bucket_id || '/' || NEW.name;
    IF v_old_key <= v_new_key THEN
      PERFORM public.lock_upload_storage_path(OLD.bucket_id, OLD.name);
      IF v_new_key <> v_old_key THEN
        PERFORM public.lock_upload_storage_path(NEW.bucket_id, NEW.name);
      END IF;
    ELSE
      PERFORM public.lock_upload_storage_path(NEW.bucket_id, NEW.name);
      PERFORM public.lock_upload_storage_path(OLD.bucket_id, OLD.name);
    END IF;
  ELSE
    PERFORM public.lock_upload_storage_path(NEW.bucket_id, NEW.name);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.upload_path_tombstones AS tombstone
    WHERE (tombstone.bucket_id, tombstone.storage_path)
      IN ((NEW.bucket_id, NEW.name),
          (CASE WHEN TG_OP = 'UPDATE' THEN OLD.bucket_id ELSE NEW.bucket_id END,
           CASE WHEN TG_OP = 'UPDATE' THEN OLD.name ELSE NEW.name END))
  ) THEN
    RAISE EXCEPTION 'Upload path has been permanently revoked'
      USING ERRCODE = '42501';
  END IF;

  IF (
    NEW.bucket_id IN (
      'profiles', 'uploads', 'generated_images', 'generated_videos',
      'generated_audio', 'generation_inputs', 'post_resource_files',
      'template_inputs', 'support_attachments'
    ) AND EXISTS (
      SELECT 1 FROM public.blocked_upload_owners AS blocked
      WHERE v_new_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND blocked.owner_user_id = v_new_owner::uuid
    )
  ) OR (
    TG_OP = 'UPDATE'
    AND OLD.bucket_id IN (
      'profiles', 'uploads', 'generated_images', 'generated_videos',
      'generated_audio', 'generation_inputs', 'post_resource_files',
      'template_inputs', 'support_attachments'
    ) AND EXISTS (
      SELECT 1 FROM public.blocked_upload_owners AS blocked
      WHERE v_old_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND blocked.owner_user_id = v_old_owner::uuid
    )
  ) THEN
    RAISE EXCEPTION 'Upload owner has been permanently blocked'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_upload_storage_object_write()
  FROM PUBLIC, anon, authenticated, service_role;

-- The account is told when support answers (support_reply, written by
-- notifySupportReplied). The type check last widened in
-- 20261015145442_mobile_notification_payout_types.sql would refuse the insert.
ALTER TABLE public.mobile_notifications DROP CONSTRAINT IF EXISTS mobile_notifications_type_check;
ALTER TABLE public.mobile_notifications ADD CONSTRAINT mobile_notifications_type_check CHECK (type IN (
  'generation_succeeded', 'generation_failed', 'credits_purchased', 'purchases_restored',
  'marketplace_unlocked', 'post_resource_unlocked', 'creator_followed', 'post_saved', 'post_remixed',
  'post_shared', 'referral_reward_earned', 'referral_reward_reversed',
  'creator_payout_paid', 'creator_payout_rejected',
  'support_reply'
));
