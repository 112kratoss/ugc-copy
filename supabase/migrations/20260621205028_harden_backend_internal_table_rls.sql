ALTER TABLE public.backend_job_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.backend_job_locks FROM PUBLIC;
REVOKE ALL ON public.backend_job_locks FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backend_job_locks TO service_role;
DROP POLICY IF EXISTS "No client access to backend_job_locks" ON public.backend_job_locks;
CREATE POLICY "No client access to backend_job_locks"
  ON public.backend_job_locks FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

ALTER TABLE public.backend_job_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.backend_job_runs FROM PUBLIC;
REVOKE ALL ON public.backend_job_runs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backend_job_runs TO service_role;
DROP POLICY IF EXISTS "No client access to backend_job_runs" ON public.backend_job_runs;
CREATE POLICY "No client access to backend_job_runs"
  ON public.backend_job_runs FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

ALTER TABLE public.backend_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.backend_rate_limits FROM PUBLIC;
REVOKE ALL ON public.backend_rate_limits FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backend_rate_limits TO service_role;
DROP POLICY IF EXISTS "No client access to backend_rate_limits" ON public.backend_rate_limits;
CREATE POLICY "No client access to backend_rate_limits"
  ON public.backend_rate_limits FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

ALTER TABLE public.generation_completion_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_completion_jobs FROM PUBLIC;
REVOKE ALL ON public.generation_completion_jobs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.generation_completion_jobs TO service_role;
DROP POLICY IF EXISTS "No client access to generation_completion_jobs" ON public.generation_completion_jobs;
CREATE POLICY "No client access to generation_completion_jobs"
  ON public.generation_completion_jobs FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

ALTER TABLE public.generation_share_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_share_events FROM PUBLIC;
REVOKE ALL ON public.generation_share_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.generation_share_events TO service_role;
DROP POLICY IF EXISTS "No client access to generation_share_events" ON public.generation_share_events;
CREATE POLICY "No client access to generation_share_events"
  ON public.generation_share_events FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

ALTER TABLE public.mobile_push_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mobile_push_deliveries FROM PUBLIC;
REVOKE ALL ON public.mobile_push_deliveries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mobile_push_deliveries TO service_role;
DROP POLICY IF EXISTS "No client access to mobile_push_deliveries" ON public.mobile_push_deliveries;
CREATE POLICY "No client access to mobile_push_deliveries"
  ON public.mobile_push_deliveries FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

ALTER TABLE public.post_resource_bundle_migration_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.post_resource_bundle_migration_audit FROM PUBLIC;
REVOKE ALL ON public.post_resource_bundle_migration_audit FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.post_resource_bundle_migration_audit TO service_role;
DROP POLICY IF EXISTS "No client access to post_resource_bundle_migration_audit" ON public.post_resource_bundle_migration_audit;
CREATE POLICY "No client access to post_resource_bundle_migration_audit"
  ON public.post_resource_bundle_migration_audit FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

ALTER TABLE public.post_share_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.post_share_events FROM PUBLIC;
REVOKE ALL ON public.post_share_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.post_share_events TO service_role;
DROP POLICY IF EXISTS "No client access to post_share_events" ON public.post_share_events;
CREATE POLICY "No client access to post_share_events"
  ON public.post_share_events FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

ALTER TABLE public.post_source_tools ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.post_source_tools FROM PUBLIC;
REVOKE ALL ON public.post_source_tools FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.post_source_tools TO service_role;
DROP POLICY IF EXISTS "No client access to post_source_tools" ON public.post_source_tools;
CREATE POLICY "No client access to post_source_tools"
  ON public.post_source_tools FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.backend_job_locks IS
  'Backend-owned lock table. Direct client access is intentionally denied; Vercel API routes use service-role RPCs.';

COMMENT ON TABLE public.backend_job_runs IS
  'Backend-owned job run ledger. Direct client access is intentionally denied; operational reads use service-role API routes.';

COMMENT ON TABLE public.backend_rate_limits IS
  'Backend-owned rate limit counter table. Direct client access is intentionally denied; Vercel API routes use service-role RPCs.';

COMMENT ON TABLE public.generation_completion_jobs IS
  'Backend-owned generation completion queue. Direct client access is intentionally denied; cron and webhook routes use service-role RPCs.';

COMMENT ON TABLE public.generation_share_events IS
  'Backend-owned generation share event ledger. Direct client access is intentionally denied; API routes record events through service-role RPCs.';

COMMENT ON TABLE public.mobile_push_deliveries IS
  'Backend-owned mobile push delivery ledger. Direct client access is intentionally denied; notification routes use the service role.';

COMMENT ON TABLE public.post_resource_bundle_migration_audit IS
  'Backend-owned migration audit ledger. Direct client access is intentionally denied; access is restricted to service-role operations.';

COMMENT ON TABLE public.post_share_events IS
  'Backend-owned post share event ledger. Direct client access is intentionally denied; API routes record events through service-role RPCs.';

COMMENT ON TABLE public.post_source_tools IS
  'Backend-owned post source tool metadata. Direct client access is intentionally denied; API routes read and write with service-role helpers.';
