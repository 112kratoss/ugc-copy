-- The API verifies the registered identity and rate limit before this call.
-- All token and preference changes commit together, including account handoff.
CREATE FUNCTION public.register_mobile_push_token(
  p_user_id uuid, p_expo_push_token text, p_platform text,
  p_device_id text DEFAULT NULL, p_app_version text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_user uuid; v_id uuid; v_now timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_expo_push_token IS NULL
     OR p_expo_push_token !~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$'
     OR p_platform IS NULL OR p_platform NOT IN ('ios','android') THEN
    RAISE EXCEPTION 'Invalid mobile push registration' USING ERRCODE='22023';
  END IF;
  -- Lock this token first so its active ownership cannot move between discovering
  -- affected accounts and locking them. All registrations use the same order.
  PERFORM pg_advisory_xact_lock(hashtextextended('mobile-push-register:token:'||p_expo_push_token,0));
  FOR v_user IN
    SELECT owner_id FROM (
      SELECT p_user_id AS owner_id
      UNION SELECT user_id FROM public.mobile_push_tokens WHERE expo_push_token=p_expo_push_token AND is_active
    ) owners ORDER BY owner_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('mobile-push-register:user:'||v_user::text,0));
  END LOOP;
  v_now:=clock_timestamp();
  UPDATE public.mobile_push_tokens SET is_active=false,disabled_at=v_now
    WHERE expo_push_token=p_expo_push_token AND user_id<>p_user_id AND is_active;
  IF p_device_id IS NOT NULL THEN
    UPDATE public.mobile_push_tokens SET is_active=false,disabled_at=v_now
      WHERE user_id=p_user_id AND device_id=p_device_id AND expo_push_token<>p_expo_push_token AND is_active;
  END IF;
  INSERT INTO public.mobile_push_tokens(user_id,expo_push_token,platform,device_id,app_version,is_active,disabled_at,last_seen_at)
    VALUES(p_user_id,p_expo_push_token,p_platform,p_device_id,p_app_version,true,NULL,v_now)
    ON CONFLICT(user_id,expo_push_token) DO UPDATE
      SET platform=excluded.platform,device_id=excluded.device_id,app_version=excluded.app_version,
          is_active=true,disabled_at=NULL,last_seen_at=excluded.last_seen_at
    RETURNING id INTO v_id;
  INSERT INTO public.mobile_notification_preferences(user_id) VALUES(p_user_id) ON CONFLICT(user_id) DO NOTHING;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.register_mobile_push_token(uuid,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_mobile_push_token(uuid,text,text,text,text) TO service_role;
