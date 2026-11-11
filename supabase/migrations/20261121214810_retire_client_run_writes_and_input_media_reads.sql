-- No client reaches workflow runs or generation input media any more, so the
-- client privileges on them go, and with them the helper 20261031033532 added
-- to keep their policies working without a client read of generations.
--
--   * The run details and approval routes read a run and its steps with the
--     service client, found only as the admitted caller's (the user_id filters
--     in loadWorkflowRunState). No client role reads or writes run steps.
--   * Run and step writes have crossed the service-only initializer and the
--     worker since 20260819072000. This is the workflow-table half of the
--     deferred stage-3 contract (supabase/contract_migrations/
--     security_remediation_stage3.sql): client writes and their policies go,
--     owner-scoped reads stay. workflow_step_generation_owned only checked the
--     generation a client wrote into a step, so it goes too.
--   * Every reader of generation_input_media uses the service client.
--
-- Edge logs sampled from 2026-08-20 to 2026-11-11 show no client call to these
-- tables or to the two workflow RPCs other than the ops boundary probes.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Settlement and generation deletes write generations first and then reach
-- run steps and input media, through the terminal trigger and the cascades.
-- SHARE holds those writers off while the policies below are dropped, and
-- still lets a child insert check its foreign key against generations. An
-- account deletion cascades from auth.users into these tables and generations
-- in an order of its own; should one meet this file, Postgres ends one of the
-- two as a deadlock and the release, or the deletion, runs again.
LOCK TABLE public.generations IN SHARE MODE;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.workflow_canvas_runs FROM anon, authenticated;
DROP POLICY IF EXISTS "Users can create their own workflow runs" ON public.workflow_canvas_runs;
DROP POLICY IF EXISTS "Users can update their own workflow runs" ON public.workflow_canvas_runs;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.workflow_canvas_run_steps FROM anon, authenticated;
DROP POLICY IF EXISTS "Users can create their own workflow run steps" ON public.workflow_canvas_run_steps;
DROP POLICY IF EXISTS "Users can update their own workflow run steps" ON public.workflow_canvas_run_steps;
DROP POLICY IF EXISTS workflow_step_generation_owned ON public.workflow_canvas_run_steps;

DROP POLICY IF EXISTS "Users can view own generation input media" ON public.generation_input_media;
REVOKE ALL PRIVILEGES ON TABLE public.generation_input_media FROM PUBLIC, anon, authenticated;

-- Fails rather than cascades if anything still calls it.
DROP FUNCTION IF EXISTS public.current_identity_owns_generation(uuid);

COMMIT;
