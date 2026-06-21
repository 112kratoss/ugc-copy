CREATE INDEX IF NOT EXISTS ai_usage_events_created_at_idx
  ON public.ai_usage_events (created_at DESC);

CREATE INDEX IF NOT EXISTS ai_usage_events_pending_created_at_idx
  ON public.ai_usage_events (created_at)
  WHERE status = 'pending';
