-- Help & Support's Updates and Roadmap, beside the chat (owner, 2026-11-26:
-- "in the help and support when they opens it, i actually want 3 option"; the
-- plan is docs/plans/help-support-updates-roadmap-plan-2026-11-26.md).
--
-- Updates are news from Magicbooklet: announcements, and features just shipped.
-- Each is a public post of the official account (the profile holding the
-- reserved handle `magicbooklet`), marked by posts.support_update_kind, so its
-- comments, reports, moderation and blocks are the ones every post has. People
-- react to an update with one of the support chat's six quick reactions, one
-- per person, and the console can lock a post's comments
-- (posts.comments_locked): a new comment is refused, the ones there stay.
--
-- The roadmap is what is being built: a short list the console keeps, each
-- item Exploring, Building or Shipped. People react to an item, and the count
-- of people is its vote. Marking an item shipped names the update that
-- announced it, and everyone who reacted is told, once.
--
-- An update can be announced to every registered account as an alert:
-- support_update_broadcasts keeps how far that has reached, and
-- support_update_alert_batch writes the next batch of alerts, at most once per
-- account by the alert's dedupe key, so a retry or a second runner never tells
-- anyone twice.
--
-- The API is the only door, as for the support chat: the account's routes act
-- as the service role after the proxy admits them (src/lib/route-identity-policy.ts),
-- and the console's after the operator's session (admin-auth.ts). No client
-- role is granted anything here, so no table carries the
-- authenticated_identity_active policy. Reactions change only through their
-- functions.

SET lock_timeout = '5s';

-- Posts ----------------------------------------------------------------------

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS support_update_kind text
    CHECK (support_update_kind IN ('announcement', 'shipped')),
  ADD COLUMN IF NOT EXISTS comments_locked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.posts.support_update_kind IS
  'Set on the official account''s posts that are Help & Support updates (announcement or shipped), only through set_support_update.';
COMMENT ON COLUMN public.posts.comments_locked IS
  'True when the post takes no new comment; the comments already there stay readable. post_comments_refuse_locked_post refuses the insert.';

CREATE INDEX IF NOT EXISTS posts_support_updates_idx
  ON public.posts (created_at DESC, id DESC)
  WHERE support_update_kind IS NOT NULL;

-- A locked post takes no new comment. create_post_comment is the only writer
-- of post_comments; its insert fails here with words the comment service reads.
CREATE OR REPLACE FUNCTION public.refuse_comment_on_locked_post()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.posts post
    WHERE post.id = NEW.post_id
      AND post.comments_locked
  ) THEN
    RAISE EXCEPTION 'Comments are locked on this post';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_comment_on_locked_post() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS post_comments_refuse_locked_post ON public.post_comments;
CREATE TRIGGER post_comments_refuse_locked_post
  BEFORE INSERT ON public.post_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.refuse_comment_on_locked_post();

-- The official account: the profile holding the reserved handle. Handles are
-- lower case (profiles_username_format_check), so the unique index answers it.
CREATE OR REPLACE FUNCTION public.support_official_account_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT profile.id
  FROM public.profiles profile
  WHERE profile.username = 'magicbooklet'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.support_official_account_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_official_account_id() TO service_role;

COMMENT ON FUNCTION public.support_official_account_id() IS
  'Service-role-only: the user id of the official account (handle magicbooklet), or null.';

-- Marks a post of the official account as an update, or takes the mark away
-- (p_kind null), and sets whether it takes comments (p_comments_locked null
-- keeps it). An update must be public when it is marked.
CREATE OR REPLACE FUNCTION public.set_support_update(
  p_post_id uuid,
  p_kind text,
  p_comments_locked boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_official uuid;
  v_post public.posts%ROWTYPE;
  v_locked boolean;
BEGIN
  IF p_post_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'a post is required');
  END IF;

  IF p_kind IS NOT NULL AND p_kind NOT IN ('announcement', 'shipped') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'an update is an announcement or shipped');
  END IF;

  v_official := public.support_official_account_id();
  IF v_official IS NULL THEN
    RETURN jsonb_build_object('status', 'no_official_account');
  END IF;

  SELECT * INTO v_post
  FROM public.posts
  WHERE id = p_post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_post.user_id IS DISTINCT FROM v_official THEN
    RETURN jsonb_build_object('status', 'not_official');
  END IF;

  IF p_kind IS NOT NULL AND v_post.visibility <> 'public' THEN
    RETURN jsonb_build_object('status', 'not_public');
  END IF;

  v_locked := coalesce(p_comments_locked, v_post.comments_locked);

  UPDATE public.posts
  SET support_update_kind = p_kind,
      comments_locked = v_locked
  WHERE id = p_post_id;

  RETURN jsonb_build_object('status', 'set', 'kind', p_kind, 'commentsLocked', v_locked);
END;
$$;

REVOKE ALL ON FUNCTION public.set_support_update(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_support_update(uuid, text, boolean) TO service_role;

COMMENT ON FUNCTION public.set_support_update(uuid, text, boolean) IS
  'Service-role-only: marks a public post of the official account as a Help & Support update (or clears the mark) and sets whether it takes comments.';

-- Reactions on updates --------------------------------------------------------

CREATE TABLE public.support_update_reactions (
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (emoji IN ('👍', '❤️', '😂', '😮', '😢', '🙏')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX support_update_reactions_user_idx
  ON public.support_update_reactions (user_id);

COMMENT ON TABLE public.support_update_reactions IS
  'One quick reaction per account per Help & Support update, set and cleared only through set_support_update_reaction.';

-- Roadmap ----------------------------------------------------------------------

CREATE TABLE public.support_roadmap_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 280),
  status text NOT NULL DEFAULT 'exploring' CHECK (status IN ('exploring', 'building', 'shipped')),
  position integer NOT NULL DEFAULT 0,
  shipped_update_post_id uuid REFERENCES public.posts(id) ON DELETE SET NULL,
  shipped_at timestamptz,
  shipped_alerts_sent_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_roadmap_items_shipped_at_matches_status
    CHECK ((status = 'shipped') = (shipped_at IS NOT NULL))
);

CREATE INDEX support_roadmap_items_shipped_update_idx
  ON public.support_roadmap_items (shipped_update_post_id);

CREATE TRIGGER support_roadmap_items_set_updated_at
  BEFORE UPDATE ON public.support_roadmap_items
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at_column();

COMMENT ON TABLE public.support_roadmap_items IS
  'The Help & Support roadmap, kept from /admin/updates: what is being explored, built and recently shipped.';

CREATE TABLE public.support_roadmap_reactions (
  item_id uuid NOT NULL REFERENCES public.support_roadmap_items(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (emoji IN ('👍', '❤️', '😂', '😮', '😢', '🙏')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, user_id)
);

CREATE INDEX support_roadmap_reactions_user_idx
  ON public.support_roadmap_reactions (user_id);

COMMENT ON TABLE public.support_roadmap_reactions IS
  'One quick reaction per account per roadmap item (the count of people is the item''s vote), set and cleared only through set_support_roadmap_reaction.';

-- Announcing an update ----------------------------------------------------------

CREATE TABLE public.support_update_broadcasts (
  post_id uuid PRIMARY KEY REFERENCES public.posts(id) ON DELETE CASCADE,
  push boolean NOT NULL DEFAULT false,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  next_after_user_id uuid,
  sent_count integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX support_update_broadcasts_unfinished_idx
  ON public.support_update_broadcasts (created_at)
  WHERE finished_at IS NULL;

COMMENT ON TABLE public.support_update_broadcasts IS
  'An update announced to every registered account: the alert''s words, whether it pushes, and how far the fan-out in account-id order has reached.';

-- Grants -------------------------------------------------------------------------

ALTER TABLE public.support_update_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_roadmap_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_roadmap_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_update_broadcasts ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.support_update_reactions FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.support_roadmap_items FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.support_roadmap_reactions FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.support_update_broadcasts FROM PUBLIC, anon, authenticated;

-- The service role reads reactions and changes them only through their
-- functions; it keeps the roadmap from the console; it starts a broadcast and
-- leaves its progress to support_update_alert_batch.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.support_update_reactions FROM service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.support_roadmap_reactions FROM service_role;
REVOKE TRUNCATE ON TABLE public.support_roadmap_items FROM service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.support_update_broadcasts FROM service_role;
GRANT SELECT ON TABLE public.support_update_reactions TO service_role;
GRANT SELECT ON TABLE public.support_roadmap_reactions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_roadmap_items TO service_role;
GRANT SELECT, INSERT ON TABLE public.support_update_broadcasts TO service_role;

-- Functions ----------------------------------------------------------------------

-- The reactions on one update, emoji -> count.
CREATE OR REPLACE FUNCTION public.support_update_reaction_counts(p_post_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_object_agg(counted.emoji, counted.people), '{}'::jsonb)
  FROM (
    SELECT reaction.emoji, count(*)::integer AS people
    FROM public.support_update_reactions reaction
    WHERE reaction.post_id = p_post_id
    GROUP BY reaction.emoji
  ) counted;
$$;

REVOKE ALL ON FUNCTION public.support_update_reaction_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_update_reaction_counts(uuid) TO service_role;

-- The reactions on a page of updates, with the reader's own (p_user_id null:
-- none), in one read.
CREATE OR REPLACE FUNCTION public.support_update_reactions_for(p_post_ids uuid[], p_user_id uuid)
RETURNS TABLE (post_id uuid, reactions jsonb, my_reaction text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    ids.post_id,
    public.support_update_reaction_counts(ids.post_id),
    (
      SELECT reaction.emoji
      FROM public.support_update_reactions reaction
      WHERE reaction.post_id = ids.post_id
        AND reaction.user_id = p_user_id
    )
  FROM unnest(coalesce(p_post_ids, ARRAY[]::uuid[])) AS ids(post_id);
$$;

REVOKE ALL ON FUNCTION public.support_update_reactions_for(uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_update_reactions_for(uuid[], uuid) TO service_role;

-- Sets an account's reaction on an update (p_emoji null clears it). The update
-- must still be one people can see: marked, public, not archived, not hidden.
CREATE OR REPLACE FUNCTION public.set_support_update_reaction(
  p_user_id uuid,
  p_post_id uuid,
  p_emoji text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_post_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'an account and an update are required');
  END IF;

  IF p_emoji IS NOT NULL AND p_emoji NOT IN ('👍', '❤️', '😂', '😮', '😢', '🙏') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'a reaction is one of the quick reactions');
  END IF;

  PERFORM 1
  FROM public.posts post
  WHERE post.id = p_post_id
    AND post.support_update_kind IS NOT NULL
    AND post.visibility = 'public'
    AND post.archived_at IS NULL
    AND post.review_status = 'visible'
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF p_emoji IS NULL THEN
    DELETE FROM public.support_update_reactions
    WHERE post_id = p_post_id
      AND user_id = p_user_id;
  ELSE
    INSERT INTO public.support_update_reactions (post_id, user_id, emoji, created_at)
    VALUES (p_post_id, p_user_id, p_emoji, clock_timestamp())
    ON CONFLICT (post_id, user_id) DO UPDATE
      SET emoji = EXCLUDED.emoji,
          created_at = EXCLUDED.created_at;
  END IF;

  RETURN jsonb_build_object(
    'status', 'reacted',
    'myReaction', p_emoji,
    'reactions', public.support_update_reaction_counts(p_post_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_support_update_reaction(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_support_update_reaction(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.set_support_update_reaction(uuid, uuid, text) IS
  'Service-role-only: sets or clears an account''s quick reaction on a Help & Support update.';

-- The reactions on one roadmap item, emoji -> count.
CREATE OR REPLACE FUNCTION public.support_roadmap_reaction_counts(p_item_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_object_agg(counted.emoji, counted.people), '{}'::jsonb)
  FROM (
    SELECT reaction.emoji, count(*)::integer AS people
    FROM public.support_roadmap_reactions reaction
    WHERE reaction.item_id = p_item_id
    GROUP BY reaction.emoji
  ) counted;
$$;

REVOKE ALL ON FUNCTION public.support_roadmap_reaction_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_roadmap_reaction_counts(uuid) TO service_role;

-- The reactions on the roadmap's items, with the reader's own, in one read.
CREATE OR REPLACE FUNCTION public.support_roadmap_reactions_for(p_item_ids uuid[], p_user_id uuid)
RETURNS TABLE (item_id uuid, reactions jsonb, my_reaction text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    ids.item_id,
    public.support_roadmap_reaction_counts(ids.item_id),
    (
      SELECT reaction.emoji
      FROM public.support_roadmap_reactions reaction
      WHERE reaction.item_id = ids.item_id
        AND reaction.user_id = p_user_id
    )
  FROM unnest(coalesce(p_item_ids, ARRAY[]::uuid[])) AS ids(item_id);
$$;

REVOKE ALL ON FUNCTION public.support_roadmap_reactions_for(uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_roadmap_reactions_for(uuid[], uuid) TO service_role;

-- Sets an account's reaction on a roadmap item that is not archived.
CREATE OR REPLACE FUNCTION public.set_support_roadmap_reaction(
  p_user_id uuid,
  p_item_id uuid,
  p_emoji text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_item_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'an account and a roadmap item are required');
  END IF;

  IF p_emoji IS NOT NULL AND p_emoji NOT IN ('👍', '❤️', '😂', '😮', '😢', '🙏') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'a reaction is one of the quick reactions');
  END IF;

  PERFORM 1
  FROM public.support_roadmap_items item
  WHERE item.id = p_item_id
    AND item.archived_at IS NULL
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF p_emoji IS NULL THEN
    DELETE FROM public.support_roadmap_reactions
    WHERE item_id = p_item_id
      AND user_id = p_user_id;
  ELSE
    INSERT INTO public.support_roadmap_reactions (item_id, user_id, emoji, created_at)
    VALUES (p_item_id, p_user_id, p_emoji, clock_timestamp())
    ON CONFLICT (item_id, user_id) DO UPDATE
      SET emoji = EXCLUDED.emoji,
          created_at = EXCLUDED.created_at;
  END IF;

  RETURN jsonb_build_object(
    'status', 'reacted',
    'myReaction', p_emoji,
    'reactions', public.support_roadmap_reaction_counts(p_item_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_support_roadmap_reaction(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_support_roadmap_reaction(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.set_support_roadmap_reaction(uuid, uuid, text) IS
  'Service-role-only: sets or clears an account''s quick reaction on a roadmap item.';

-- Writes the next batch of an update's alerts: registered, active accounts in
-- id order after the broadcast's cursor, each told at most once by the dedupe
-- key. Answers the alerts written (for their pushes) and whether it is done. A
-- broadcast another runner holds answers busy.
CREATE OR REPLACE FUNCTION public.support_update_alert_batch(
  p_post_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_broadcast public.support_update_broadcasts%ROWTYPE;
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_accounts uuid[];
  v_last uuid;
  v_written jsonb;
  v_written_count integer;
  v_done boolean;
BEGIN
  IF p_post_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'an update is required');
  END IF;

  SELECT * INTO v_broadcast
  FROM public.support_update_broadcasts
  WHERE post_id = p_post_id
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.support_update_broadcasts WHERE post_id = p_post_id) THEN
      RETURN jsonb_build_object('status', 'busy');
    END IF;
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_broadcast.finished_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'finished', 'sentCount', v_broadcast.sent_count, 'written', '[]'::jsonb);
  END IF;

  -- An update taken back (unmarked, archived, hidden or no longer public)
  -- announces no further.
  IF NOT EXISTS (
    SELECT 1
    FROM public.posts post
    WHERE post.id = p_post_id
      AND post.support_update_kind IS NOT NULL
      AND post.visibility = 'public'
      AND post.archived_at IS NULL
      AND post.review_status = 'visible'
  ) THEN
    UPDATE public.support_update_broadcasts
    SET finished_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE post_id = p_post_id;
    RETURN jsonb_build_object('status', 'withdrawn', 'sentCount', v_broadcast.sent_count, 'written', '[]'::jsonb);
  END IF;

  SELECT array_agg(account.id ORDER BY account.id)
  INTO v_accounts
  FROM (
    SELECT u.id
    FROM auth.users u
    JOIN public.profiles profile ON profile.id = u.id
    WHERE u.is_anonymous IS NOT TRUE
      AND profile.identity_state = 'active'
      -- The account that posted the update is not told about its own post.
      AND u.id IS DISTINCT FROM (SELECT post.user_id FROM public.posts post WHERE post.id = p_post_id)
      AND (v_broadcast.next_after_user_id IS NULL OR u.id > v_broadcast.next_after_user_id)
    ORDER BY u.id
    LIMIT v_limit
  ) account;

  v_accounts := coalesce(v_accounts, ARRAY[]::uuid[]);
  v_last := v_accounts[array_length(v_accounts, 1)];
  v_done := coalesce(array_length(v_accounts, 1), 0) < v_limit;

  WITH written AS (
    INSERT INTO public.mobile_notifications (
      user_id, type, category, title, body, deep_link, object_type, object_id, dedupe_key
    )
    SELECT
      account_id,
      'support_update',
      'system',
      v_broadcast.title,
      v_broadcast.body,
      '/showcase/' || p_post_id::text,
      'post',
      p_post_id::text,
      'support_update:' || p_post_id::text
    FROM unnest(v_accounts) AS account_id
    ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id, user_id
  )
  SELECT
    coalesce(jsonb_agg(jsonb_build_object('id', written.id, 'userId', written.user_id)), '[]'::jsonb),
    count(*)::integer
  INTO v_written, v_written_count
  FROM written;

  UPDATE public.support_update_broadcasts
  SET next_after_user_id = coalesce(v_last, next_after_user_id),
      sent_count = sent_count + v_written_count,
      finished_at = CASE WHEN v_done THEN clock_timestamp() ELSE NULL END,
      updated_at = clock_timestamp()
  WHERE post_id = p_post_id;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_done THEN 'finished' ELSE 'continuing' END,
    'push', v_broadcast.push,
    'sentCount', v_broadcast.sent_count + v_written_count,
    'written', v_written
  );
END;
$$;

REVOKE ALL ON FUNCTION public.support_update_alert_batch(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_update_alert_batch(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.support_update_alert_batch(uuid, integer) IS
  'Service-role-only: writes the next batch of an announced update''s alerts, each account at most once.';

-- Marks a roadmap item shipped with the update that announced it and tells
-- everyone who reacted to it, once (the item records when, and each alert has
-- a dedupe key). Answers the alerts written, for their pushes.
CREATE OR REPLACE FUNCTION public.ship_support_roadmap_item(
  p_item_id uuid,
  p_update_post_id uuid,
  p_title text,
  p_body text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item public.support_roadmap_items%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_written jsonb := '[]'::jsonb;
BEGIN
  IF p_item_id IS NULL OR p_update_post_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'a roadmap item and the update that announced it are required');
  END IF;

  IF char_length(btrim(coalesce(p_title, ''))) NOT BETWEEN 1 AND 200
     OR char_length(btrim(coalesce(p_body, ''))) NOT BETWEEN 1 AND 500 THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'the alert needs a title and a body');
  END IF;

  SELECT * INTO v_item
  FROM public.support_roadmap_items
  WHERE id = p_item_id
  FOR UPDATE;

  IF NOT FOUND OR v_item.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.posts post
    WHERE post.id = p_update_post_id
      AND post.support_update_kind IS NOT NULL
      AND post.visibility = 'public'
      AND post.archived_at IS NULL
      AND post.review_status = 'visible'
  ) THEN
    RETURN jsonb_build_object('status', 'update_not_found');
  END IF;

  UPDATE public.support_roadmap_items
  SET status = 'shipped',
      shipped_at = coalesce(shipped_at, v_now),
      shipped_update_post_id = p_update_post_id
  WHERE id = p_item_id;

  IF v_item.shipped_alerts_sent_at IS NULL THEN
    WITH written AS (
      INSERT INTO public.mobile_notifications (
        user_id, type, category, title, body, deep_link, object_type, object_id, dedupe_key
      )
      SELECT
        reaction.user_id,
        'support_roadmap_shipped',
        'system',
        btrim(p_title),
        btrim(p_body),
        '/showcase/' || p_update_post_id::text,
        'post',
        p_update_post_id::text,
        'support_roadmap_shipped:' || p_item_id::text
      FROM public.support_roadmap_reactions reaction
      JOIN public.profiles profile ON profile.id = reaction.user_id
      WHERE reaction.item_id = p_item_id
        AND profile.identity_state = 'active'
      ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING id, user_id
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', written.id, 'userId', written.user_id)), '[]'::jsonb)
    INTO v_written
    FROM written;

    UPDATE public.support_roadmap_items
    SET shipped_alerts_sent_at = v_now
    WHERE id = p_item_id;
  END IF;

  RETURN jsonb_build_object('status', 'shipped', 'written', v_written);
END;
$$;

REVOKE ALL ON FUNCTION public.ship_support_roadmap_item(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ship_support_roadmap_item(uuid, uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.ship_support_roadmap_item(uuid, uuid, text, text) IS
  'Service-role-only: marks a roadmap item shipped with its announcing update and alerts everyone who reacted, once.';

-- Alerts --------------------------------------------------------------------------

ALTER TABLE public.mobile_notifications DROP CONSTRAINT IF EXISTS mobile_notifications_type_check;
ALTER TABLE public.mobile_notifications ADD CONSTRAINT mobile_notifications_type_check CHECK (type IN (
  'generation_succeeded', 'generation_failed', 'credits_purchased', 'purchases_restored',
  'marketplace_unlocked', 'post_resource_unlocked', 'creator_followed', 'post_saved', 'post_remixed',
  'post_shared', 'referral_reward_earned', 'referral_reward_reversed',
  'creator_payout_paid', 'creator_payout_rejected',
  'support_reply',
  'support_update', 'support_roadmap_shipped'
));

RESET lock_timeout;
