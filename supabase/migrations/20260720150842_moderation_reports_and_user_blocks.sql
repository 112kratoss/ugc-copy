CREATE TABLE public.user_blocks (
  blocker_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CONSTRAINT user_blocks_cannot_block_self CHECK (blocker_user_id <> blocked_user_id)
);

CREATE INDEX user_blocks_blocked_user_idx
  ON public.user_blocks (blocked_user_id, blocker_user_id);

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;

-- User blocking is mediated by the authenticated backend so that the mutation
-- can also remove follows and invalidate viewer-specific content. Keeping the
-- table off the public Data API prevents clients from enumerating block lists.
REVOKE ALL ON TABLE public.user_blocks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_blocks TO service_role;

COMMENT ON TABLE public.user_blocks IS
  'Backend-owned user safety blocks. A block hides public creator content in both directions and prevents new follows.';

CREATE TABLE public.moderation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  target_type text NOT NULL CHECK (target_type IN ('user', 'generation')),
  reported_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  generation_id uuid REFERENCES public.generations(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (
    reason IN (
      'spam',
      'harassment',
      'impersonation',
      'unsafe_content',
      'offensive_ai_output',
      'other'
    )
  ),
  details text CHECK (details IS NULL OR char_length(details) <= 1000),
  source_surface text NOT NULL CHECK (source_surface IN (
    'showcase',
    'showcase-reel',
    'creator-profile',
    'generation-viewer'
  )),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT moderation_reports_target_shape CHECK (
    (target_type = 'user' AND generation_id IS NULL)
    OR (target_type = 'generation' AND reported_user_id IS NULL)
  ),
  CONSTRAINT moderation_reports_cannot_report_self CHECK (
    target_type <> 'user'
    OR reporter_user_id IS NULL
    OR reported_user_id IS NULL
    OR reporter_user_id <> reported_user_id
  )
);

CREATE INDEX moderation_reports_open_queue_idx
  ON public.moderation_reports (created_at ASC, id ASC)
  WHERE status IN ('open', 'reviewing');

CREATE INDEX moderation_reports_reporter_created_idx
  ON public.moderation_reports (reporter_user_id, created_at DESC)
  WHERE reporter_user_id IS NOT NULL;

CREATE INDEX moderation_reports_reported_user_created_idx
  ON public.moderation_reports (reported_user_id, created_at DESC)
  WHERE reported_user_id IS NOT NULL;

CREATE INDEX moderation_reports_generation_created_idx
  ON public.moderation_reports (generation_id, created_at DESC)
  WHERE generation_id IS NOT NULL;

CREATE INDEX moderation_reports_reviewed_by_idx
  ON public.moderation_reports (reviewed_by)
  WHERE reviewed_by IS NOT NULL;

ALTER TABLE public.moderation_reports ENABLE ROW LEVEL SECURITY;

-- Reports may contain sensitive safety context. Only trusted server and
-- moderation tooling using the service role can read or mutate the queue.
REVOKE ALL ON TABLE public.moderation_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.moderation_reports TO service_role;

DROP TRIGGER IF EXISTS moderation_reports_set_updated_at ON public.moderation_reports;
CREATE TRIGGER moderation_reports_set_updated_at
BEFORE UPDATE ON public.moderation_reports
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at_column();

COMMENT ON TABLE public.moderation_reports IS
  'Backend-owned moderation queue for user conduct and offensive private AI generation reports.';
