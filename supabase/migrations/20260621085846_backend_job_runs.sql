CREATE TABLE IF NOT EXISTS public.backend_job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  route text NOT NULL,
  request_id text NOT NULL,
  lock_owner text NOT NULL,
  status text NOT NULL DEFAULT 'started',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  skip_reason text,
  error_message text,
  summary jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backend_job_runs_job_name_not_blank CHECK (btrim(job_name) <> ''),
  CONSTRAINT backend_job_runs_route_not_blank CHECK (btrim(route) <> ''),
  CONSTRAINT backend_job_runs_request_id_not_blank CHECK (btrim(request_id) <> ''),
  CONSTRAINT backend_job_runs_lock_owner_not_blank CHECK (btrim(lock_owner) <> ''),
  CONSTRAINT backend_job_runs_status_check CHECK (status IN ('started', 'succeeded', 'skipped', 'failed')),
  CONSTRAINT backend_job_runs_finished_after_started CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT backend_job_runs_duration_non_negative CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX IF NOT EXISTS backend_job_runs_job_started_idx
  ON public.backend_job_runs (job_name, started_at DESC);

CREATE INDEX IF NOT EXISTS backend_job_runs_status_started_idx
  ON public.backend_job_runs (status, started_at DESC);

ALTER TABLE public.backend_job_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.backend_job_runs FROM PUBLIC;
REVOKE ALL ON public.backend_job_runs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backend_job_runs TO service_role;
