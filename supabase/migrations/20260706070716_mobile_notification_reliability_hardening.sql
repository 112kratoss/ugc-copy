-- Mobile notification reliability hardening.
-- - Keep active Expo push tokens exclusive to one account.
-- - Restrict client writes on backend-owned notification rows.
-- - Add an atomic aggregated-notification upsert for social notification grouping.
-- - Add indexes used by retry and retention maintenance.

WITH ranked_active_tokens AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY expo_push_token
      ORDER BY last_seen_at DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC, id DESC
    ) AS row_number
  FROM public.mobile_push_tokens
  WHERE is_active = true
)
UPDATE public.mobile_push_tokens tokens
SET
  is_active = false,
  disabled_at = COALESCE(tokens.disabled_at, timezone('utc'::text, now())),
  updated_at = timezone('utc'::text, now())
FROM ranked_active_tokens ranked
WHERE tokens.id = ranked.id
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS mobile_push_tokens_active_expo_push_token_idx
  ON public.mobile_push_tokens (expo_push_token)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS mobile_push_deliveries_retryable_idx
  ON public.mobile_push_deliveries (last_attempt_at ASC, created_at ASC)
  WHERE send_status = 'error'
    AND receipt_status = 'error'
    AND push_ticket_id IS NULL
    AND attempt_count < 3;

CREATE INDEX IF NOT EXISTS mobile_push_deliveries_created_at_idx
  ON public.mobile_push_deliveries (created_at);

CREATE INDEX IF NOT EXISTS mobile_notifications_read_retention_idx
  ON public.mobile_notifications (updated_at)
  WHERE is_read = true;

REVOKE INSERT, DELETE ON TABLE public.mobile_notifications FROM authenticated;
REVOKE UPDATE ON TABLE public.mobile_notifications FROM authenticated;
GRANT UPDATE (is_read) ON TABLE public.mobile_notifications TO authenticated;

CREATE OR REPLACE FUNCTION public.upsert_mobile_notification(
  p_user_id uuid,
  p_actor_user_id uuid,
  p_type text,
  p_category text,
  p_title text,
  p_body text,
  p_deep_link text DEFAULT NULL,
  p_object_type text DEFAULT NULL,
  p_object_id text DEFAULT NULL,
  p_dedupe_key text DEFAULT NULL,
  p_aggregation_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row public.mobile_notifications%ROWTYPE;
  v_was_created boolean := true;
BEGIN
  IF p_aggregation_key IS NULL OR length(trim(p_aggregation_key)) = 0 THEN
    RAISE EXCEPTION 'aggregation key is required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.mobile_notifications (
    user_id,
    actor_user_id,
    type,
    category,
    title,
    body,
    deep_link,
    object_type,
    object_id,
    dedupe_key,
    aggregation_key,
    event_count,
    is_read
  )
  VALUES (
    p_user_id,
    p_actor_user_id,
    p_type,
    p_category,
    p_title,
    p_body,
    p_deep_link,
    p_object_type,
    p_object_id,
    p_dedupe_key,
    p_aggregation_key,
    1,
    false
  )
  ON CONFLICT (user_id, aggregation_key)
    WHERE aggregation_key IS NOT NULL
  DO UPDATE SET
    actor_user_id = EXCLUDED.actor_user_id,
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    deep_link = EXCLUDED.deep_link,
    object_type = EXCLUDED.object_type,
    object_id = EXCLUDED.object_id,
    event_count = public.mobile_notifications.event_count + 1,
    is_read = false,
    updated_at = timezone('utc'::text, now())
  RETURNING * INTO v_row;

  v_was_created := v_row.event_count = 1;

  RETURN jsonb_build_object(
    'notification', to_jsonb(v_row),
    'wasCreated', v_was_created
  );
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_mobile_notification(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_mobile_notification(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) TO service_role;
