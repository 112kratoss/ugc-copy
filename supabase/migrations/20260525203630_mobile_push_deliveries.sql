CREATE TABLE IF NOT EXISTS public.mobile_push_deliveries (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES public.mobile_notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_id uuid REFERENCES public.mobile_push_tokens(id) ON DELETE SET NULL,
  expo_push_token text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  push_ticket_id text,
  send_status text NOT NULL DEFAULT 'pending' CHECK (send_status IN ('pending', 'sent', 'error')),
  receipt_status text NOT NULL DEFAULT 'pending' CHECK (receipt_status IN ('pending', 'ok', 'error', 'stale')),
  receipt_checked_at timestamptz,
  receipt_error_code text,
  receipt_message text,
  provider_message text,
  provider_details jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  sent_at timestamptz,
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS mobile_push_deliveries_notification_idx
  ON public.mobile_push_deliveries (notification_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mobile_push_deliveries_pending_receipts_idx
  ON public.mobile_push_deliveries (receipt_status, sent_at ASC)
  WHERE receipt_status = 'pending';

CREATE INDEX IF NOT EXISTS mobile_push_deliveries_token_idx
  ON public.mobile_push_deliveries (token_id, created_at DESC);

ALTER TABLE public.mobile_push_deliveries ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS mobile_push_deliveries_set_updated_at ON public.mobile_push_deliveries;
CREATE TRIGGER mobile_push_deliveries_set_updated_at
BEFORE UPDATE ON public.mobile_push_deliveries
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at_column();
