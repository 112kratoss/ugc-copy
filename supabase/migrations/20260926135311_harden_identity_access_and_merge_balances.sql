-- Section 1: enforce the same current-subject boundary in API admission,
-- direct table/Storage policies, and the two remaining authenticated definer
-- mutations. Keep existing valid-client grants during schema-first rollout.
CREATE OR REPLACE FUNCTION public.current_identity_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    public.current_identity_admission()
      @> '{"state":"active","session_valid":true,"banned":false}'::jsonb,
    false
  );
$$;
REVOKE ALL ON FUNCTION public.current_identity_is_active() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_identity_is_active() TO authenticated, service_role;
COMMENT ON FUNCTION public.current_identity_is_active() IS
  'Current-subject API admission shared by Data API and Storage RLS: live account, active lifecycle, no ban and valid session. Retains the admission RPC legacy sessionless-token compatibility.';

-- A guest is authenticated but may only read its profile. Do not revoke its
-- SELECT grant or gate all operations on registration: guest creation needs it.
CREATE POLICY profiles_registered_update
  ON public.profiles AS RESTRICTIVE FOR UPDATE TO authenticated
  USING ((SELECT public.current_identity_is_registered()))
  WITH CHECK ((SELECT public.current_identity_is_registered()));


CREATE OR REPLACE FUNCTION public.start_workflow_canvas_run(
  p_canvas_id uuid,
  p_user_id uuid,
  p_start_node_id text,
  p_mode text,
  p_catalog_revision text,
  p_graph_snapshot jsonb,
  p_idempotency_key text DEFAULT NULL
)
RETURNS TABLE (
  run_id uuid,
  run_status text,
  run_created_at timestamptz,
  reused boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid;
  v_key text;
  v_run public.workflow_canvas_runs%ROWTYPE;
  v_admission jsonb;
BEGIN
  -- Definer mutations bypass table RLS. A signed end-user request must pass
  -- the same admission boundary before any write, including rate-limit writes.
  -- Service-role workers retain their existing trusted invocation path.
  IF (SELECT auth.jwt() ->> 'role') = 'authenticated'
    AND NOT public.current_identity_is_active() THEN
    RAISE EXCEPTION 'Active identity required' USING ERRCODE = '42501';
  END IF;
  IF p_canvas_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'canvas_id and user_id are required';
  END IF;

  v_caller := auth.uid();
  IF v_caller IS NOT NULL AND v_caller IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'cannot start a workflow run for another user';
  END IF;

  -- check_backend_rate_limit is service-only, but this SECURITY DEFINER
  -- function executes as its owner. The subject is safe because an end-user
  -- caller has already been bound to auth.uid() above.
  v_admission := public.check_backend_rate_limit(
    'legacy-workflow-run-start',
    p_user_id::text,
    20,
    600
  );
  IF NOT coalesce((v_admission->>'allowed')::boolean, false) THEN
    RAISE EXCEPTION 'legacy workflow run rate limit exceeded';
  END IF;

  IF btrim(coalesce(p_start_node_id, '')) = '' THEN
    RAISE EXCEPTION 'start_node_id is required';
  END IF;

  IF coalesce(p_mode, '') NOT IN ('node', 'branch') THEN
    RAISE EXCEPTION 'mode must be node or branch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_canvases
    WHERE id = p_canvas_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'workflow canvas not found for this user';
  END IF;

  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  IF length(v_key) > 200 THEN
    RAISE EXCEPTION 'idempotency_key is too long';
  END IF;

  INSERT INTO public.workflow_canvas_runs (
    canvas_id, user_id, start_node_id, mode, status,
    catalog_revision, graph_snapshot, idempotency_key
  ) VALUES (
    p_canvas_id, p_user_id, btrim(p_start_node_id), p_mode, 'processing',
    p_catalog_revision, p_graph_snapshot, v_key
  )
  ON CONFLICT (canvas_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_run;

  IF v_run.id IS NOT NULL THEN
    RETURN QUERY SELECT v_run.id, v_run.status, v_run.created_at, false;
    RETURN;
  END IF;

  SELECT * INTO v_run
  FROM public.workflow_canvas_runs
  WHERE canvas_id = p_canvas_id AND idempotency_key = v_key;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'idempotent workflow run lookup failed for key %', v_key;
  END IF;

  RETURN QUERY SELECT v_run.id, v_run.status, v_run.created_at, true;
END;
$$;

CREATE OR REPLACE FUNCTION public.initialize_workflow_canvas_run(
  p_canvas_id uuid,
  p_user_id uuid,
  p_start_node_id text,
  p_mode text,
  p_catalog_revision text,
  p_graph_snapshot jsonb,
  p_idempotency_key text,
  p_step_skeleton jsonb
)
RETURNS TABLE (
  run_id uuid,
  run_status text,
  run_created_at timestamptz,
  job_id uuid,
  reused boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid;
  v_key text;
  v_run public.workflow_canvas_runs%ROWTYPE;
  v_job_id uuid;
BEGIN
  -- Definer mutations bypass table RLS. A signed end-user request must pass
  -- the same admission boundary before any write, including rate-limit writes.
  -- Service-role workers retain their existing trusted invocation path.
  IF (SELECT auth.jwt() ->> 'role') = 'authenticated'
    AND NOT public.current_identity_is_active() THEN
    RAISE EXCEPTION 'Active identity required' USING ERRCODE = '42501';
  END IF;
  IF p_canvas_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'canvas_id and user_id are required';
  END IF;

  v_caller := auth.uid();
  IF v_caller IS NOT NULL AND v_caller IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'cannot start a workflow run for another user';
  END IF;

  IF btrim(coalesce(p_start_node_id, '')) = '' THEN
    RAISE EXCEPTION 'start_node_id is required';
  END IF;
  IF coalesce(p_mode, '') NOT IN ('node', 'branch') THEN
    RAISE EXCEPTION 'mode must be node or branch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_canvases
    WHERE id = p_canvas_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'workflow canvas not found for this user';
  END IF;

  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  IF v_key IS NULL THEN RAISE EXCEPTION 'idempotency_key is required'; END IF;
  IF length(v_key) > 200 THEN RAISE EXCEPTION 'idempotency_key is too long'; END IF;

  IF jsonb_typeof(p_step_skeleton) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'step_skeleton must be an array';
  END IF;
  IF jsonb_array_length(p_step_skeleton) < 1
    OR jsonb_array_length(p_step_skeleton) > 200 THEN
    RAISE EXCEPTION 'step_skeleton must contain between 1 and 200 nodes';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_step_skeleton) AS item
    WHERE btrim(coalesce(item->>'nodeId', '')) = ''
  ) THEN
    RAISE EXCEPTION 'step_skeleton contains a blank node id';
  END IF;
  IF (
    SELECT count(*) FROM jsonb_array_elements(p_step_skeleton)
  ) IS DISTINCT FROM (
    SELECT count(DISTINCT item->>'nodeId') FROM jsonb_array_elements(p_step_skeleton) AS item
  ) THEN
    RAISE EXCEPTION 'step_skeleton contains duplicate node ids';
  END IF;

  INSERT INTO public.workflow_canvas_runs (
    canvas_id, user_id, start_node_id, mode, status,
    catalog_revision, graph_snapshot, idempotency_key
  ) VALUES (
    p_canvas_id, p_user_id, btrim(p_start_node_id), p_mode, 'processing',
    p_catalog_revision, p_graph_snapshot, v_key
  )
  ON CONFLICT (canvas_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_run;

  IF v_run.id IS NULL THEN
    SELECT * INTO v_run
    FROM public.workflow_canvas_runs
    WHERE canvas_id = p_canvas_id AND idempotency_key = v_key;

    IF v_run.id IS NULL THEN
      RAISE EXCEPTION 'idempotent workflow run lookup failed for key %', v_key;
    END IF;

    SELECT jobs.id INTO v_job_id
    FROM public.workflow_run_step_jobs AS jobs
    WHERE jobs.run_id = v_run.id
    ORDER BY jobs.attempt ASC
    LIMIT 1;

    RETURN QUERY SELECT v_run.id, v_run.status, v_run.created_at, v_job_id, true;
    RETURN;
  END IF;

  INSERT INTO public.workflow_canvas_run_steps (
    run_id, node_id, status, input_snapshot, started_at, finished_at
  )
  SELECT
    v_run.id,
    btrim(item->>'nodeId'),
    'queued',
    CASE WHEN jsonb_typeof(item->'inputSnapshot') = 'object'
      THEN item->'inputSnapshot' ELSE NULL END,
    NULL,
    NULL
  FROM jsonb_array_elements(p_step_skeleton) AS item;

  INSERT INTO public.workflow_run_step_jobs (
    run_id, canvas_id, node_id, attempt, status, next_attempt_at, updated_at
  ) VALUES (
    v_run.id, p_canvas_id, btrim(p_start_node_id), 1, 'pending', now(), now()
  )
  RETURNING id INTO v_job_id;

  RETURN QUERY SELECT v_run.id, v_run.status, v_run.created_at, v_job_id, false;
END;
$$;

-- A transfer can carry refund/clawback debt. The old nonnegative ledger
-- constraints forced the merge to discard that debt. Keep historical rows and
-- all idempotency/ownership constraints; permit signed amounts from now on.
ALTER TABLE public.account_merges
  DROP CONSTRAINT account_merges_credits_moved_check,
  DROP CONSTRAINT account_merges_promotional_credits_moved_check;
COMMENT ON COLUMN public.account_merges.credits_moved IS
  'Signed guest credit balance transferred exactly once; negative values preserve refund debt.';
COMMENT ON COLUMN public.account_merges.promotional_credits_moved IS
  'Signed promotional balance transferred exactly once, including clawback debt.';

CREATE OR REPLACE FUNCTION public.merge_guest_account(
  p_guest_user_id uuid,
  p_target_user_id uuid,
  p_source_surface text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_guest public.profiles%ROWTYPE;
  v_target public.profiles%ROWTYPE;
  v_existing public.account_merges%ROWTYPE;
  v_guest_is_anonymous boolean;
  v_target_is_anonymous boolean;
  v_first uuid;
  v_second uuid;
  v_credits_moved integer;
  v_promotional_credits_moved integer;
  v_target_credits integer;
BEGIN
  IF p_guest_user_id IS NULL
     OR p_target_user_id IS NULL
     OR p_guest_user_id = p_target_user_id
     OR p_source_surface NOT IN ('mobile', 'web') THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  -- Deterministic lock order. Two devices redeeming into the same account, or a
  -- retry racing its own original, would otherwise deadlock.
  v_first := least(p_guest_user_id, p_target_user_id);
  v_second := greatest(p_guest_user_id, p_target_user_id);
  PERFORM 1 FROM public.profiles WHERE id = v_first FOR UPDATE;
  PERFORM 1 FROM public.profiles WHERE id = v_second FOR UPDATE;

  SELECT * INTO v_guest FROM public.profiles WHERE id = p_guest_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  SELECT * INTO v_target FROM public.profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  -- Idempotent replay. The client retries this after a flaky sign-in, and the
  -- unique constraint alone would surface as an error rather than a success.
  SELECT * INTO v_existing
  FROM public.account_merges
  WHERE guest_user_id = p_guest_user_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', CASE WHEN v_existing.target_user_id = p_target_user_id
                     THEN 'already_merged'
                     ELSE 'conflict' END,
      'credits_moved', v_existing.credits_moved,
      'promotional_credits_moved', v_existing.promotional_credits_moved,
      'credits', v_target.credits
    );
  END IF;

  -- Anonymity is read from auth.users, which only the auth server writes. The
  -- route proves it from the JWT as well; this is the independent check, and the
  -- one that cannot be reached around.
  SELECT coalesce(is_anonymous, false) INTO v_guest_is_anonymous
  FROM auth.users WHERE id = p_guest_user_id;
  SELECT coalesce(is_anonymous, false) INTO v_target_is_anonymous
  FROM auth.users WHERE id = p_target_user_id;

  -- A guest may not swallow a registered account, a guest may not absorb another
  -- guest, and an already-linked identity on either side is out of bounds.
  IF NOT v_guest_is_anonymous
     OR v_target_is_anonymous
     OR v_guest.merged_into_user_id IS NOT NULL
     OR v_target.merged_into_user_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  -- Preserve both accounts signed balances; linking must never forgive debt.
  v_credits_moved := coalesce(v_guest.credits, 0);
  v_promotional_credits_moved := coalesce(v_guest.promotional_credits, 0);

  UPDATE public.profiles
  SET credits = coalesce(credits, 0) + v_credits_moved,
      promotional_credits = coalesce(promotional_credits, 0) + v_promotional_credits_moved
  WHERE id = p_target_user_id
  RETURNING credits INTO v_target_credits;

  -- Drained and linked in the same statement sequence that credits the target.
  -- A guest row left holding a balance is a second spendable copy of the same
  -- money; the link is what makes every later settlement resolve to the target.
  UPDATE public.profiles
  SET credits = 0,
      promotional_credits = 0,
      merged_into_user_id = p_target_user_id,
      merged_at = timezone('utc'::text, now())
  WHERE id = p_guest_user_id;

  -- Nothing else moves. generations, transactions, mobile_store_transactions,
  -- mobile_purchase_intents and creation_credit_reservations all keep their
  -- original guest user_id: the last two would raise on the attempt, and reads
  -- and settlement resolve through linked_account_ids()/canonical_account_id()
  -- instead.
  INSERT INTO public.account_merges (
    guest_user_id,
    target_user_id,
    credits_moved,
    promotional_credits_moved,
    source_surface
  ) VALUES (
    p_guest_user_id,
    p_target_user_id,
    v_credits_moved,
    v_promotional_credits_moved,
    p_source_surface
  );

  RETURN jsonb_build_object(
    'status', 'merged',
    'credits_moved', v_credits_moved,
    'promotional_credits_moved', v_promotional_credits_moved,
    'credits', v_target_credits
  );
END;
$$;
REVOKE ALL ON FUNCTION public.merge_guest_account(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_guest_account(uuid, uuid, text) TO service_role;
