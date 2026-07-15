-- Cover foreign-key cascades and SET NULL checks before the feed telemetry
-- tables grow large. These indexes also support creator/viewer cleanup without
-- scanning the full event or assignment history.

CREATE INDEX IF NOT EXISTS feed_events_creator_user_idx
  ON public.feed_events (creator_user_id);

CREATE INDEX IF NOT EXISTS feed_experiment_assignments_experiment_variant_idx
  ON public.feed_experiment_assignments (experiment_id, variant_id);

CREATE INDEX IF NOT EXISTS feed_experiment_assignments_viewer_user_idx
  ON public.feed_experiment_assignments (viewer_user_id)
  WHERE viewer_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_sessions_experiment_assignment_idx
  ON public.feed_sessions (experiment_assignment_id)
  WHERE experiment_assignment_id IS NOT NULL;
