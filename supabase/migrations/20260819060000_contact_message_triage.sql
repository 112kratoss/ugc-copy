-- Triage state for the inbound contact queue.
--
-- `contact_messages` was append-only: the console could read an enquiry and
-- open a reply, but nothing recorded that it had been dealt with. The queue
-- therefore only ever grew, every operator re-read the same handled messages,
-- and there was no way to tell an unanswered enquiry from one answered last
-- month.
--
-- Handling is a two-state toggle rather than a delete: a support record is
-- evidence, and a mistakenly-handled message has to be recoverable.

ALTER TABLE public.contact_messages
  ADD COLUMN IF NOT EXISTS handled_at timestamptz,
  ADD COLUMN IF NOT EXISTS handled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS handled_note text
    CHECK (handled_note IS NULL OR char_length(btrim(handled_note)) BETWEEN 1 AND 1000);

-- The open queue is the hot read: operators filter to unhandled by default.
CREATE INDEX IF NOT EXISTS contact_messages_open_idx
  ON public.contact_messages (created_at DESC)
  WHERE handled_at IS NULL;

CREATE INDEX IF NOT EXISTS contact_messages_handled_idx
  ON public.contact_messages (handled_at DESC)
  WHERE handled_at IS NOT NULL;

COMMENT ON COLUMN public.contact_messages.handled_at IS
  'Set when an operator marked the enquiry dealt with. Null means it is still in the open queue.';

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

  SELECT * INTO v_message
  FROM public.contact_messages
  WHERE id = p_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Naturally idempotent: the state is a toggle, not an accumulating ledger, so
  -- a double-submitted form re-asserts the same state instead of duplicating it.
  IF p_handled THEN
    UPDATE public.contact_messages
    SET handled_at = coalesce(v_message.handled_at, v_now),
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

COMMENT ON FUNCTION public.set_contact_message_handled(uuid, uuid, boolean, text) IS
  'Service-role-only contact queue triage toggle for the /admin console.';
