CREATE TABLE IF NOT EXISTS public.mobile_push_tokens (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  device_id text,
  app_version text,
  is_active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (user_id, expo_push_token)
);

CREATE TABLE IF NOT EXISTS public.mobile_notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  push_enabled boolean NOT NULL DEFAULT true,
  generation_enabled boolean NOT NULL DEFAULT true,
  commerce_enabled boolean NOT NULL DEFAULT true,
  social_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.mobile_notifications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN (
    'generation_succeeded',
    'generation_failed',
    'credits_purchased',
    'purchases_restored',
    'marketplace_unlocked',
    'post_resource_unlocked',
    'creator_followed',
    'post_saved',
    'post_remixed',
    'post_shared'
  )),
  category text NOT NULL CHECK (category IN ('generation', 'commerce', 'social', 'system')),
  title text NOT NULL,
  body text NOT NULL,
  deep_link text,
  object_type text,
  object_id text,
  dedupe_key text,
  aggregation_key text,
  event_count integer NOT NULL DEFAULT 1 CHECK (event_count > 0),
  is_read boolean NOT NULL DEFAULT false,
  pushed_at timestamptz,
  push_ticket_id text,
  push_error text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS mobile_push_tokens_user_active_idx
  ON public.mobile_push_tokens (user_id, is_active, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS mobile_notifications_user_updated_idx
  ON public.mobile_notifications (user_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS mobile_notifications_user_unread_idx
  ON public.mobile_notifications (user_id, is_read, updated_at DESC)
  WHERE is_read = false;

CREATE UNIQUE INDEX IF NOT EXISTS mobile_notifications_user_dedupe_key_idx
  ON public.mobile_notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS mobile_notifications_user_aggregation_key_idx
  ON public.mobile_notifications (user_id, aggregation_key)
  WHERE aggregation_key IS NOT NULL;

ALTER TABLE public.mobile_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own mobile notifications" ON public.mobile_notifications;
CREATE POLICY "Users can view their own mobile notifications"
  ON public.mobile_notifications FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own mobile notifications" ON public.mobile_notifications;
CREATE POLICY "Users can update their own mobile notifications"
  ON public.mobile_notifications FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage their own mobile push tokens" ON public.mobile_push_tokens;
CREATE POLICY "Users can manage their own mobile push tokens"
  ON public.mobile_push_tokens FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view their own mobile notification preferences" ON public.mobile_notification_preferences;
CREATE POLICY "Users can view their own mobile notification preferences"
  ON public.mobile_notification_preferences FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own mobile notification preferences" ON public.mobile_notification_preferences;
CREATE POLICY "Users can insert their own mobile notification preferences"
  ON public.mobile_notification_preferences FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own mobile notification preferences" ON public.mobile_notification_preferences;
CREATE POLICY "Users can update their own mobile notification preferences"
  ON public.mobile_notification_preferences FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mobile_notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mobile_push_tokens TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.mobile_notification_preferences TO authenticated;

DROP TRIGGER IF EXISTS mobile_push_tokens_set_updated_at ON public.mobile_push_tokens;
CREATE TRIGGER mobile_push_tokens_set_updated_at
BEFORE UPDATE ON public.mobile_push_tokens
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at_column();

DROP TRIGGER IF EXISTS mobile_notification_preferences_set_updated_at ON public.mobile_notification_preferences;
CREATE TRIGGER mobile_notification_preferences_set_updated_at
BEFORE UPDATE ON public.mobile_notification_preferences
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at_column();

DROP TRIGGER IF EXISTS mobile_notifications_set_updated_at ON public.mobile_notifications;
CREATE TRIGGER mobile_notifications_set_updated_at
BEFORE UPDATE ON public.mobile_notifications
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at_column();
