CREATE INDEX IF NOT EXISTS mobile_push_tokens_user_device_active_idx
  ON public.mobile_push_tokens (user_id, device_id, is_active)
  WHERE device_id IS NOT NULL;
