-- Preserve moderation state and audit attribution across stale or concurrent
-- admin submissions. This is a forward correction for the functions introduced
-- by 20260819050000 and 20260819060000; deployed migration history stays intact.

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
  v_active_removal public.admin_generation_moderation_actions%ROWTYPE;
  v_action_id uuid;
BEGIN
  IF p_generation_id IS NULL OR p_reviewer_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'generation and reviewer are required');
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('remove', 'restore') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'unsupported moderation action');
  END IF;

  IF v_reason IS NULL OR char_length(v_reason) < 3 OR char_length(v_reason) > 1000 THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'reason must be between 3 and 1000 characters');
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

  -- The row lock makes the state checks below authoritative even when two stale
  -- admin pages submit opposing or duplicate actions at the same time.
  SELECT * INTO v_generation
  FROM public.generations
  WHERE id = p_generation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF p_action = 'remove' AND v_generation.moderation_removed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'invalid',
      'error', 'generation is already removed by moderation'
    );
  END IF;

  IF p_action = 'restore' AND v_generation.moderation_removed_at IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'invalid',
      'error', 'generation is not removed by moderation'
    );
  END IF;

  IF p_action = 'remove' THEN
    UPDATE public.generations
    SET moderation_removed_at = v_now,
        moderation_removed_by = p_reviewer_id,
        is_public = false,
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

  -- Pick the first removal in the still-active removal cycle. The original
  -- function admitted duplicate removals, so selecting the newest row could
  -- restore the already-hidden state captured by a duplicate. A removal from a
  -- completed earlier cycle is excluded by the later restore that closed it.
  SELECT removal.* INTO v_active_removal
  FROM public.admin_generation_moderation_actions AS removal
  WHERE removal.generation_id = p_generation_id
    AND removal.action = 'remove'
    AND NOT EXISTS (
      SELECT 1
      FROM public.admin_generation_moderation_actions AS restoration
      WHERE restoration.generation_id = removal.generation_id
        AND restoration.action = 'restore'
        AND (restoration.created_at, restoration.id) > (removal.created_at, removal.id)
    )
  ORDER BY removal.created_at ASC, removal.id ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status', 'invalid',
      'error', 'active moderation removal has no audit record'
    );
  END IF;

  UPDATE public.generations
  SET moderation_removed_at = NULL,
      moderation_removed_by = NULL,
      archived_at = v_active_removal.previous_archived_at,
      archived_by_user_id = CASE
        WHEN v_active_removal.previous_archived_at IS NULL THEN NULL
        ELSE archived_by_user_id
      END,
      is_public = coalesce(v_active_removal.previous_is_public, false)
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

CREATE OR REPLACE FUNCTION public.set_contact_message_handled(
  p_message_id uuid,
  p_reviewer_id uuid,
  p_handled boolean,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_message public.contact_messages%ROWTYPE;
  v_now timestamptz := timezone('utc'::text, now());
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_message_id IS NULL OR p_reviewer_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'message and reviewer are required');
  END IF;

  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'note must be 1000 characters or fewer');
  END IF;

  SELECT * INTO v_message
  FROM public.contact_messages
  WHERE id = p_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- A repeated handle is a replay, not a new decision. Leave all three audit
  -- fields together so a stale tab cannot attach a new reviewer or note to the
  -- original operator's timestamp.
  IF p_handled AND v_message.handled_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'applied',
      'message_id', p_message_id,
      'handled', true
    );
  END IF;

  IF p_handled THEN
    UPDATE public.contact_messages
    SET handled_at = v_now,
        handled_by = p_reviewer_id,
        handled_note = v_note
    WHERE id = p_message_id;
  ELSE
    UPDATE public.contact_messages
    SET handled_at = NULL,
        handled_by = NULL,
        handled_note = NULL
    WHERE id = p_message_id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'applied',
    'message_id', p_message_id,
    'handled', p_handled
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_contact_message_handled(uuid, uuid, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_contact_message_handled(uuid, uuid, boolean, text)
  TO service_role;
