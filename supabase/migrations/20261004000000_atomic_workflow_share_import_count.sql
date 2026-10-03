-- Count successful copies against the current row, never a stale caller snapshot.
CREATE OR REPLACE FUNCTION public.increment_workflow_share_import_count(p_share_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $function$
  UPDATE public.workflow_shares
  SET import_count = import_count + 1
  WHERE id = p_share_id
  RETURNING import_count;
$function$;

REVOKE ALL ON FUNCTION public.increment_workflow_share_import_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_workflow_share_import_count(uuid) TO service_role;
