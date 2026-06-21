ALTER TABLE public.post_resource_bundle_migration_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.post_resource_bundle_migration_audit FROM PUBLIC;
REVOKE ALL ON public.post_resource_bundle_migration_audit FROM anon;
REVOKE ALL ON public.post_resource_bundle_migration_audit FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.post_resource_bundle_migration_audit TO service_role;

DO $$
BEGIN
  IF to_regclass('public.post_resource_bundle_migration_audit_id_seq') IS NOT NULL THEN
    REVOKE ALL ON SEQUENCE public.post_resource_bundle_migration_audit_id_seq FROM PUBLIC;
    REVOKE ALL ON SEQUENCE public.post_resource_bundle_migration_audit_id_seq FROM anon;
    REVOKE ALL ON SEQUENCE public.post_resource_bundle_migration_audit_id_seq FROM authenticated;
    GRANT USAGE, SELECT ON SEQUENCE public.post_resource_bundle_migration_audit_id_seq TO service_role;
  END IF;
END $$;

COMMENT ON TABLE public.post_resource_bundle_migration_audit IS
  'Internal historical migration audit table. Access is restricted to service_role.';
