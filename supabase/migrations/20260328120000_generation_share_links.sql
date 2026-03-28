ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS share_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS share_visit_count integer DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.generation_share_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  generation_id uuid REFERENCES public.generations(id) ON DELETE CASCADE NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('share_click', 'share_visit')),
  source_surface text NOT NULL CHECK (
    source_surface IN (
      'create-image',
      'create-video',
      'create-motion',
      'my-creations',
      'creator-profile',
      'showcase',
      'detail-page'
    )
  ),
  channel text CHECK (channel IN ('native-share', 'copy-link')),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE public.generation_share_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS generation_share_events_generation_created_idx
  ON public.generation_share_events (generation_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.record_generation_share_event(
  p_generation_id uuid,
  p_event_type text,
  p_source_surface text,
  p_channel text DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  INSERT INTO public.generation_share_events (
    generation_id,
    event_type,
    source_surface,
    channel,
    actor_user_id
  )
  VALUES (
    p_generation_id,
    p_event_type,
    p_source_surface,
    p_channel,
    p_actor_user_id
  );

  IF p_event_type = 'share_click' THEN
    UPDATE public.generations
    SET share_count = COALESCE(share_count, 0) + 1
    WHERE id = p_generation_id;
  ELSIF p_event_type = 'share_visit' THEN
    UPDATE public.generations
    SET share_visit_count = COALESCE(share_visit_count, 0) + 1
    WHERE id = p_generation_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
