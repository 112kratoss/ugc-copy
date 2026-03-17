-- Create ai_usage_events table for tracking non-generation AI actions (e.g. prompt enhancement)
CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users NOT NULL,
  feature text NOT NULL,            -- e.g. 'prompt_enhancement'
  provider text NOT NULL,           -- e.g. 'kie'
  model text NOT NULL,              -- e.g. 'gemini-3-flash'
  medium text,                      -- 'image', 'video', 'motion'
  cost integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  input_prompt text,
  output_text text,
  error_message text,
  refunded boolean DEFAULT false,
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS
ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;

-- Users can read their own usage events
CREATE POLICY "Users can view their own usage events."
  ON public.ai_usage_events FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can insert/update (API routes use service client)
-- No insert/update policy needed for regular users since API uses service_role key.

-- Idempotent refund RPC for usage events
CREATE OR REPLACE FUNCTION public.refund_ai_usage_event(p_event_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  evt RECORD;
BEGIN
  SELECT user_id, cost, refunded INTO evt
  FROM ai_usage_events
  WHERE id = p_event_id;

  IF NOT FOUND OR evt.refunded = true OR evt.cost IS NULL OR evt.cost = 0 THEN
    RETURN false;
  END IF;

  UPDATE profiles SET credits = credits + evt.cost WHERE id = evt.user_id;
  UPDATE ai_usage_events SET refunded = true, status = 'refunded' WHERE id = p_event_id;

  RETURN true;
END;
$$;
