-- DEFERRED STAGE-3 CONTRACT MIGRATION -- DO NOT APPLY WITH STAGES 1 OR 2.
--
-- Promotion gate:
--   1. Every supported web/mobile build uses explicit upload finalization and
--      the service-role workflow initializer.
--   2. Telemetry shows no authenticated initializer calls, direct workflow
--      table writes, legacy start_workflow_canvas_run calls, or target-first
--      linked-account deletions for the full compatibility window.
--   3. Copy this file into supabase/migrations with a fresh 14-digit UTC
--      timestamp. Do not move it with its repository timestamp: production's
--      migration runner rejects out-of-order versions.
--
-- Rollback after promotion requires an explicit emergency migration restoring
-- the required grants/FK. Application code must never silently restore them.

-- Workflow contraction: owner-scoped reads remain, while all mutation is
-- forced through the server-owned initializer/service boundary.
REVOKE INSERT, UPDATE, DELETE
  ON TABLE public.workflow_canvas_runs
  FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE
  ON TABLE public.workflow_canvas_run_steps
  FROM anon, authenticated;

GRANT SELECT ON TABLE public.workflow_canvas_runs TO authenticated;
GRANT SELECT ON TABLE public.workflow_canvas_run_steps TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.workflow_canvas_runs
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.workflow_canvas_run_steps
  TO service_role;

DROP POLICY IF EXISTS "Users can create their own workflow runs"
  ON public.workflow_canvas_runs;
DROP POLICY IF EXISTS "Users can update their own workflow runs"
  ON public.workflow_canvas_runs;
DROP POLICY IF EXISTS "Users can create their own workflow run steps"
  ON public.workflow_canvas_run_steps;
DROP POLICY IF EXISTS "Users can update their own workflow run steps"
  ON public.workflow_canvas_run_steps;

REVOKE ALL ON FUNCTION public.initialize_workflow_canvas_run(
  uuid, uuid, text, text, text, jsonb, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_workflow_canvas_run(
  uuid, uuid, text, text, text, jsonb, text, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.start_workflow_canvas_run(
  uuid, uuid, text, text, text, jsonb, text
) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.start_workflow_canvas_run(
  uuid, uuid, text, text, text, jsonb, text
);

-- The application has used reserve_upload_bytes_v2 since stage 2. Once every
-- supported mobile build explicitly finalizes uploads, remove the v1
-- path-based reservation shim so no future server can silently fall back to an
-- octet-stream compatibility reservation.
REVOKE ALL ON FUNCTION public.reserve_upload_bytes(
  uuid, text, text, bigint, bigint, bigint, integer
) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.reserve_upload_bytes(
  uuid, text, text, bigint, bigint, bigint, integer
);

REVOKE ALL ON FUNCTION public.consume_upload_byte_reservation(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.consume_upload_byte_reservation(uuid, text, text);

REVOKE ALL ON FUNCTION public.release_upload_byte_reservation(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.release_upload_byte_reservation(text, text);

-- Identity contraction: after guest-first deletion is authoritative, prevent
-- any future target-first Auth deletion at the database relationship itself.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_merged_into_user_id_fkey;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_merged_into_user_id_fkey
  FOREIGN KEY (merged_into_user_id)
  REFERENCES auth.users(id)
  ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE public.profiles
  VALIDATE CONSTRAINT profiles_merged_into_user_id_fkey;
