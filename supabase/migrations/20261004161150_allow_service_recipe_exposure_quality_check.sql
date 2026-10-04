-- Direct service-role post restores run the exposure trigger as service_role.
-- Its quality predicate was private to postgres, making valid restores fail.
-- Keep client roles denied; the trusted service already reads these rows.
REVOKE ALL ON FUNCTION public.post_resource_bundle_quality_issue_for(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_resource_bundle_quality_issue_for(uuid)
  TO service_role;
