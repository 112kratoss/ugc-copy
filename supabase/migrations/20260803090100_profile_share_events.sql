-- Creator-profile shares had nowhere to land. generation_share_events and
-- post_share_events are both foreign keyed to a piece of content, so a share of
-- a *profile* could only be dropped on the floor -- which is exactly what both
-- clients did. This is the profile-shaped sibling of post_share_events, with the
-- same backend-only access posture.

-- profiles already revokes UPDATE from anon/authenticated and its SELECT policy
-- is own-row only, so this counter is service-role territory by construction and
-- adding it exposes nothing new. It exists so lifetime reach survives the 90-day
-- prune below, exactly as posts.share_count does.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS share_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.profile_share_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('share_click', 'share_visit')),
  source_surface text NOT NULL CHECK (
    source_surface IN (
      'creator-profile',
      'profile'
    )
  ),
  channel text CHECK (channel IN ('native-share', 'copy-link')),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS profile_share_events_profile_created_idx
  ON public.profile_share_events (profile_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS profile_share_events_actor_idx
  ON public.profile_share_events (actor_user_id);

ALTER TABLE public.profile_share_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_share_events FROM PUBLIC;
REVOKE ALL ON public.profile_share_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_share_events TO service_role;
DROP POLICY IF EXISTS "No client access to profile_share_events" ON public.profile_share_events;
CREATE POLICY "No client access to profile_share_events"
  ON public.profile_share_events FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.profile_share_events IS
  'Backend-owned creator profile share event ledger. Direct client access is intentionally denied; API routes record events through service-role RPCs.';

CREATE OR REPLACE FUNCTION public.record_profile_share_event(
  p_profile_user_id uuid,
  p_event_type text,
  p_source_surface text,
  p_channel text DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_username text;
BEGIN
  -- A profile with no username has no /creators/<username> URL, so there was
  -- nothing shareable to share. The profile-shaped analogue of the visibility
  -- guard in record_post_share_event.
  SELECT username
  INTO v_username
  FROM public.profiles
  WHERE id = p_profile_user_id;

  IF v_username IS NULL OR btrim(v_username) = '' THEN
    RAISE EXCEPTION 'Only addressable creator profiles can record share events'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.profile_share_events (
    profile_user_id,
    event_type,
    source_surface,
    channel,
    actor_user_id
  )
  VALUES (
    p_profile_user_id,
    p_event_type,
    p_source_surface,
    p_channel,
    p_actor_user_id
  );

  IF p_event_type = 'share_click' THEN
    UPDATE public.profiles
    SET share_count = share_count + 1
    WHERE id = p_profile_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_profile_share_event(uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_profile_share_event(uuid, text, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.record_profile_share_event(uuid, text, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_profile_share_event(uuid, text, text, text, uuid) TO service_role;

-- Append-only telemetry needs a retention policy from day one. Ninety days
-- matches prune_post_share_events and the other event tables.
CREATE OR REPLACE FUNCTION public.prune_profile_share_events(
  p_older_than interval DEFAULT interval '90 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.profile_share_events
  WHERE created_at < timezone('utc'::text, now()) - p_older_than;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_profile_share_events(interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_profile_share_events(interval)
  TO service_role;
