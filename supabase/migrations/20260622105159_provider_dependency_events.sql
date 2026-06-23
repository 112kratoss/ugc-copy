CREATE TABLE IF NOT EXISTS public.provider_dependency_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name text NOT NULL,
  request_id text,
  outcome text NOT NULL,
  method text NOT NULL,
  host text,
  provider_task_id text,
  timeout_ms integer NOT NULL,
  duration_ms integer NOT NULL,
  status integer,
  ok boolean,
  error_name text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_dependency_events_service_name_not_blank CHECK (btrim(service_name) <> ''),
  CONSTRAINT provider_dependency_events_method_not_blank CHECK (btrim(method) <> ''),
  CONSTRAINT provider_dependency_events_outcome_check CHECK (
    outcome IN ('success', 'http_error', 'timeout', 'network_error')
  ),
  CONSTRAINT provider_dependency_events_timeout_non_negative CHECK (timeout_ms >= 0),
  CONSTRAINT provider_dependency_events_duration_non_negative CHECK (duration_ms >= 0),
  CONSTRAINT provider_dependency_events_status_valid CHECK (status IS NULL OR status BETWEEN 100 AND 599)
);

CREATE INDEX IF NOT EXISTS provider_dependency_events_created_idx
  ON public.provider_dependency_events (created_at DESC);

CREATE INDEX IF NOT EXISTS provider_dependency_events_service_created_idx
  ON public.provider_dependency_events (service_name, created_at DESC);

CREATE INDEX IF NOT EXISTS provider_dependency_events_outcome_created_idx
  ON public.provider_dependency_events (outcome, created_at DESC);

ALTER TABLE public.provider_dependency_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.provider_dependency_events FROM PUBLIC;
REVOKE ALL ON public.provider_dependency_events FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.provider_dependency_events TO service_role;

DROP POLICY IF EXISTS "No client access to provider_dependency_events"
  ON public.provider_dependency_events;
CREATE POLICY "No client access to provider_dependency_events"
  ON public.provider_dependency_events FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.provider_dependency_events IS
  'Backend-owned durable telemetry for failed, timed-out, network-error, and slow external provider calls. Direct client access is denied; ops health reads use the service role.';
