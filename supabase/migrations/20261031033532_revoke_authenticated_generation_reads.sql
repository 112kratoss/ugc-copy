-- Generation reads are the server's. 20260726071722 left `authenticated` a
-- SELECT on eight columns of public.generations and an owner policy for one
-- reader, the web creators' run resume in the browser. That read moved behind
-- GET /api/generations/active (#607), so nothing reads the table with a
-- user's token any more. Withdraw both: a user-scoped read is now refused
-- outright, instead of working until its select grows past the eight columns
-- and then failing only in production.
--
-- Two policies on other tables check a generation's owner with a sub-select
-- on public.generations, and a sub-select in a policy runs with the querying
-- user's own privileges:
--   * workflow_step_generation_owned on workflow_canvas_run_steps, under which
--     the workflow run details and approval routes read a run's steps with the
--     caller's client;
--   * "Users can view own generation input media" on generation_input_media.
-- Both now ask public.current_identity_owns_generation(), which reads the
-- owner with its own privileges and answers only for the caller. They answer
-- as before: the tables' own active-identity policies still apply, as the one
-- on generations did inside the sub-select.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- generations first, the order settlement takes (its terminal trigger then
-- reads run steps) and deletes cascade in. Taking the two linked tables
-- first could deadlock with either.
LOCK TABLE public.generations IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.current_identity_owns_generation(p_generation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.generations AS generation
    WHERE generation.id = p_generation_id
      AND generation.user_id = (SELECT auth.uid())
  );
$$;
REVOKE ALL ON FUNCTION public.current_identity_owns_generation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_identity_owns_generation(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.current_identity_owns_generation(uuid) IS
  'Whether the current subject owns a generation. For RLS on tables that link one: authenticated has no SELECT on generations.';

DROP POLICY IF EXISTS "Users can resume their own generations" ON public.generations;

-- A table-level revoke also clears the column grants the resume projection was
-- made of (granted by postgres, like this revoke).
REVOKE ALL PRIVILEGES ON TABLE public.generations FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS workflow_step_generation_owned ON public.workflow_canvas_run_steps;
CREATE POLICY workflow_step_generation_owned
ON public.workflow_canvas_run_steps AS RESTRICTIVE FOR ALL TO authenticated
USING (
  generation_id IS NULL
  OR public.current_identity_owns_generation(generation_id)
)
WITH CHECK (
  generation_id IS NULL
  OR public.current_identity_owns_generation(generation_id)
);

DROP POLICY IF EXISTS "Users can view own generation input media" ON public.generation_input_media;
CREATE POLICY "Users can view own generation input media"
ON public.generation_input_media FOR SELECT TO authenticated
USING (
  (SELECT auth.uid()) = user_id
  AND public.current_identity_owns_generation(generation_id)
);

COMMIT;
