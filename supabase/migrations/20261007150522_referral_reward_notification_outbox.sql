-- Only future ledger entries enqueue work. Historical notification delivery
-- cannot be inferred from retained notification history; do not replay it.
CREATE TABLE public.referral_reward_notification_outbox (
  ledger_id uuid PRIMARY KEY REFERENCES public.referral_credit_ledger(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text
);
CREATE INDEX referral_reward_notification_outbox_pending_idx
  ON public.referral_reward_notification_outbox(available_at, ledger_id)
  WHERE completed_at IS NULL;
ALTER TABLE public.referral_reward_notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.referral_reward_notification_outbox FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.referral_reward_notification_outbox TO service_role;

CREATE FUNCTION public.enqueue_referral_reward_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.referral_reward_notification_outbox(ledger_id) VALUES(NEW.id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_referral_reward_notification() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER referral_credit_ledger_enqueue_notification
  AFTER INSERT ON public.referral_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_referral_reward_notification();

CREATE FUNCTION public.has_pending_referral_reward_notifications()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.referral_reward_notification_outbox
    WHERE completed_at IS NULL AND available_at <= now());
$$;

CREATE FUNCTION public.deliver_referral_reward_notifications(p_limit integer DEFAULT 100, p_event_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_event record;
  v_processed integer := 0;
  v_delivered integer := 0;
  v_failed integer := 0;
  v_reversed boolean;
  v_credits bigint;
  v_notification_id uuid;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'Notification delivery limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  FOR v_event IN
    SELECT q.ledger_id, q.attempts, l.user_id, l.reward_id, l.credit_delta, l.idempotency_key
    FROM public.referral_reward_notification_outbox q
    JOIN public.referral_credit_ledger l ON l.id = q.ledger_id
    WHERE q.completed_at IS NULL AND q.available_at <= now()
      AND (p_event_key IS NULL OR l.idempotency_key = p_event_key)
    ORDER BY q.available_at, q.ledger_id
    LIMIT p_limit FOR UPDATE OF q SKIP LOCKED
  LOOP
    v_processed := v_processed + 1;
    BEGIN
      v_reversed := v_event.credit_delta < 0;
      v_credits := abs(v_event.credit_delta::bigint);
      -- Notification history and the completion marker commit together. The
      -- existing push-maintenance worker handles transport after this commit.
      v_notification_id := NULL;
      INSERT INTO public.mobile_notifications(
        user_id, type, category, title, body, deep_link, object_type, object_id, dedupe_key
      ) VALUES (
        v_event.user_id,
        CASE WHEN v_reversed THEN 'referral_reward_reversed' ELSE 'referral_reward_earned' END,
        'commerce',
        CASE WHEN v_reversed THEN 'Referral reward reversed' ELSE 'Referral credits earned' END,
        CASE WHEN v_reversed
          THEN v_credits::text || ' referral ' || CASE WHEN v_credits = 1 THEN 'credit was' ELSE 'credits were' END || ' removed after a payment reversal.'
          ELSE 'You earned ' || v_credits::text || ' bonus ' || CASE WHEN v_credits = 1 THEN 'credit' ELSE 'credits' END || ' from Invite & Earn.' END,
        '/invite', 'referral_reward', v_event.reward_id::text,
        'referral-reward:' || v_event.reward_id::text || ':' || v_event.idempotency_key
      ) ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING id INTO v_notification_id;
      IF v_notification_id IS NOT NULL THEN
        -- A recovered history row has no first-send reservation. Persist zero-
        -- attempt deliveries for currently enabled devices; the existing retry
        -- worker rechecks preferences/token ownership and spends attempts before
        -- provider I/O. Existing history keeps its original delivery decisions.
        INSERT INTO public.mobile_push_deliveries(
          notification_id, user_id, token_id, expo_push_token, platform,
          send_status, receipt_status, attempt_count, receipt_message
        )
        SELECT v_notification_id, t.user_id, t.id, t.expo_push_token, t.platform,
          'error', 'error', 0, 'Referral notification recovered; initial delivery queued.'
        FROM public.mobile_push_tokens t
        LEFT JOIN public.mobile_notification_preferences p ON p.user_id = t.user_id
        WHERE t.user_id = v_event.user_id AND t.is_active
          AND coalesce(p.push_enabled, true) AND coalesce(p.commerce_enabled, true);
      END IF;
      UPDATE public.referral_reward_notification_outbox
        SET completed_at = now(), attempts = attempts + 1, last_error_code = NULL
        WHERE ledger_id = v_event.ledger_id;
      v_delivered := v_delivered + 1;
    EXCEPTION WHEN OTHERS THEN
      -- One poison event must not roll back healthy events or monopolize the
      -- next bounded scan. Preserve a diagnostic code, not customer payloads.
      UPDATE public.referral_reward_notification_outbox
        SET attempts = attempts + 1, last_error_code = SQLSTATE,
          available_at = now() + interval '1 minute' * least(60, power(2, least(attempts, 6)))
        WHERE ledger_id = v_event.ledger_id;
      v_failed := v_failed + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('processed', v_processed, 'delivered', v_delivered, 'failed', v_failed);
END;
$$;
REVOKE ALL ON FUNCTION public.has_pending_referral_reward_notifications() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deliver_referral_reward_notifications(integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_pending_referral_reward_notifications() TO service_role;
GRANT EXECUTE ON FUNCTION public.deliver_referral_reward_notifications(integer, text) TO service_role;
