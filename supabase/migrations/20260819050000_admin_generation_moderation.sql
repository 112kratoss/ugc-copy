-- Operator removal of a single generation.
--
-- `resolve_subject_report_for_ops` removes a reported comment, but for a
-- `generation` target its only writes are to the report row -- so a report
-- about a generated image could be closed with the image still served.
--
-- ENFORCEMENT: every public read path already filters `archived_at IS NULL`,
-- so a moderation removal sets it and takes effect immediately without a dozen
-- query sites having to remember a new column. But `archived_at` is also the
-- creator's own archive toggle, and `restoreOwnerGenerationForRoute` clears it
-- -- which would let the offender undo the moderation. `moderation_removed_at`
-- exists to close that: it marks the removal as an operator decision, and the
-- owner restore path refuses while it is set.
--
-- The creator's prior state is captured on the audit row rather than assumed,
-- so restoring a wrongly-removed generation puts it back exactly as it was
-- instead of silently un-archiving something the creator had archived
-- themselves, or re-publishing something they had made private.

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS moderation_removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS moderation_removed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS generations_moderation_removed_idx
  ON public.generations (moderation_removed_at DESC)
  WHERE moderation_removed_at IS NOT NULL;

COMMENT ON COLUMN public.generations.moderation_removed_at IS
  'Set when an operator removed this generation. While set, the owner restore path must refuse.';

CREATE TABLE IF NOT EXISTS public.admin_generation_moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL REFERENCES public.generations(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('remove', 'restore')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  -- The creator's state before an operator touched it, so a restore is exact.
  previous_archived_at timestamptz,
  previous_is_public boolean,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_generation_moderation_idempotency_key_idx
  ON public.admin_generation_moderation_actions (idempotency_key);

CREATE INDEX IF NOT EXISTS admin_generation_moderation_generation_idx
  ON public.admin_generation_moderation_actions (generation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_generation_moderation_created_idx
  ON public.admin_generation_moderation_actions (created_at DESC);

ALTER TABLE public.admin_generation_moderation_actions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.admin_generation_moderation_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.admin_generation_moderation_actions TO service_role;

COMMENT ON TABLE public.admin_generation_moderation_actions IS
  'Audit log of operator generation removals and restorations from /admin.';

CREATE OR REPLACE FUNCTION public.apply_admin_generation_moderation(
  p_generation_id uuid,
  p_reviewer_id uuid,
  p_action text,
  p_reason text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.admin_generation_moderation_actions%ROWTYPE;
  v_generation public.generations%ROWTYPE;
  v_now timestamptz := timezone('utc'::text, now());
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_last_removal public.admin_generation_moderation_actions%ROWTYPE;
  v_action_id uuid;
BEGIN
  IF p_generation_id IS NULL OR p_reviewer_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'generation and reviewer are required');
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('remove', 'restore') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'unsupported moderation action');
  END IF;

  IF v_reason IS NULL OR char_length(v_reason) < 3 THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'reason is required');
  END IF;

  IF v_key IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'idempotency key is required');
  END IF;

  SELECT * INTO v_existing
  FROM public.admin_generation_moderation_actions
  WHERE idempotency_key = v_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'already_applied',
      'action_id', v_existing.id,
      'action', v_existing.action
    );
  END IF;

  SELECT * INTO v_generation
  FROM public.generations
  WHERE id = p_generation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF p_action = 'remove' THEN
    UPDATE public.generations
    SET moderation_removed_at = v_now,
        moderation_removed_by = p_reviewer_id,
        is_public = false,
        -- Only stamp an archive the creator had not already made, so their own
        -- archive timestamp is never overwritten and then lost on restore.
        archived_at = coalesce(archived_at, v_now),
        archived_by_user_id = coalesce(archived_by_user_id, p_reviewer_id)
    WHERE id = p_generation_id;

    INSERT INTO public.admin_generation_moderation_actions (
      generation_id, reviewer_id, action, reason,
      previous_archived_at, previous_is_public, idempotency_key
    ) VALUES (
      p_generation_id, p_reviewer_id, 'remove', v_reason,
      v_generation.archived_at, v_generation.is_public, v_key
    )
    RETURNING id INTO v_action_id;

    RETURN jsonb_build_object(
      'status', 'applied', 'action', 'remove', 'action_id', v_action_id
    );
  END IF;

  -- Restore: put the creator's state back exactly as the last removal found it.
  SELECT * INTO v_last_removal
  FROM public.admin_generation_moderation_actions
  WHERE generation_id = p_generation_id AND action = 'remove'
  ORDER BY created_at DESC
  LIMIT 1;

  UPDATE public.generations
  SET moderation_removed_at = NULL,
      moderation_removed_by = NULL,
      archived_at = v_last_removal.previous_archived_at,
      archived_by_user_id = CASE
        WHEN v_last_removal.previous_archived_at IS NULL THEN NULL
        ELSE archived_by_user_id
      END,
      is_public = coalesce(v_last_removal.previous_is_public, false)
  WHERE id = p_generation_id;

  INSERT INTO public.admin_generation_moderation_actions (
    generation_id, reviewer_id, action, reason, idempotency_key
  ) VALUES (
    p_generation_id, p_reviewer_id, 'restore', v_reason, v_key
  )
  RETURNING id INTO v_action_id;

  RETURN jsonb_build_object(
    'status', 'applied', 'action', 'restore', 'action_id', v_action_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_admin_generation_moderation(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_admin_generation_moderation(uuid, uuid, text, text, text)
  TO service_role;

COMMENT ON FUNCTION public.apply_admin_generation_moderation(uuid, uuid, text, text, text) IS
  'Service-role-only generation removal/restoration with an operator audit record.';
