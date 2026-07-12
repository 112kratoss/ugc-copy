-- Supabase projects may explicitly grant function execution to API roles through
-- default privileges. Keep this backend-only completion hook invoker-scoped and
-- revoke every public API role directly.
ALTER FUNCTION public.record_template_run_success(uuid, text, integer)
  SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.record_template_run_success(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_template_run_success(uuid, text, integer)
  TO service_role;

-- Cover both columns of the composite foreign keys used to enforce that active
-- versions and run versions belong to their parent template.
CREATE INDEX IF NOT EXISTS templates_active_version_fk_idx
  ON public.templates (id, active_version_id)
  WHERE active_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS template_runs_template_version_fk_idx
  ON public.template_runs (template_id, template_version_id)
  WHERE template_version_id IS NOT NULL;
