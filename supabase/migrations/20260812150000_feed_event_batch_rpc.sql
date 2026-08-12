-- Record a bounded feed telemetry batch in one database transaction. Each loop
-- body is a nested PL/pgSQL block, so its EXCEPTION handler is an implicit
-- savepoint: a poison event rolls back its own writes without discarding valid
-- siblings from the same request.

CREATE OR REPLACE FUNCTION public.record_showcase_feed_events(
  p_actor_user_id uuid,
  p_anonymous_key_hash text,
  p_events jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event jsonb;
  v_event_index integer := 0;
  v_recorded integer := 0;
  v_rejected integer := 0;
  v_outcomes jsonb := '[]'::jsonb;
  v_outcome jsonb;
  v_duplicate boolean;
  v_existing public.feed_events%ROWTYPE;
  v_creator_user_id uuid;
  v_client_event_id text;
  v_feed_session_id uuid;
  v_delivery_id bigint;
  v_post_id uuid;
  v_event_type text;
  v_position integer;
  v_duration_ms integer;
  v_progress double precision;
  v_source_surface text;
  v_occurred_at timestamptz;
  v_metadata jsonb;
  v_session_id uuid;
  v_session_user_id uuid;
  v_session_anonymous_key_hash text;
  v_session_created_at timestamptz;
  v_session_expires_at timestamptz;
  v_delivery_position integer;
  v_saved boolean;
  v_status integer;
  v_error text;
BEGIN
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Feed event batch must be an array';
  END IF;

  IF jsonb_array_length(p_events) < 1 OR jsonb_array_length(p_events) > 25 THEN
    RAISE EXCEPTION 'Feed event batch must contain between 1 and 25 entries';
  END IF;

  IF p_actor_user_id IS NULL
    AND char_length(coalesce(p_anonymous_key_hash, '')) NOT BETWEEN 32 AND 128
  THEN
    RAISE EXCEPTION 'Anonymous feed event batches require a valid identity hash';
  END IF;

  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)
  LOOP
    v_outcome := NULL;

    BEGIN
      v_duplicate := false;
      v_existing := NULL;
      v_client_event_id := v_event->>'clientEventId';
      v_feed_session_id := nullif(v_event->>'feedSessionId', '')::uuid;
      v_delivery_id := nullif(v_event->>'deliveryId', '')::bigint;
      v_post_id := (v_event->>'postId')::uuid;
      v_event_type := v_event->>'eventType';
      v_position := nullif(v_event->>'position', '')::integer;
      v_duration_ms := nullif(v_event->>'durationMs', '')::integer;
      v_progress := nullif(v_event->>'progress', '')::double precision;
      v_source_surface := v_event->>'sourceSurface';
      v_occurred_at := (v_event->>'occurredAt')::timestamptz;
      v_metadata := coalesce(v_event->'metadata', '{}'::jsonb);

      -- The public parser enforces this same 24-hour/5-minute window. Keep the
      -- transaction boundary defensive because this privileged RPC is also
      -- callable by server jobs, and expired mobile queue entries must not be
      -- able to grow the event tables without bound.
      IF v_occurred_at IS NULL
        OR v_occurred_at < now() - interval '24 hours'
        OR v_occurred_at > now() + interval '5 minutes'
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Feed event timestamp is outside the accepted window.';
      END IF;

      SELECT posts.user_id
      INTO v_creator_user_id
      FROM public.posts AS posts
      WHERE posts.id = v_post_id
        AND posts.visibility = 'public'
        AND posts.archived_at IS NULL;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '404|Public feed post was not found.';
      END IF;

      IF v_event_type = 'hide_creator' AND p_actor_user_id = v_creator_user_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Creators cannot hide their own profile.';
      END IF;

      IF v_event_type = ANY (ARRAY['follow', 'remix_complete', 'purchase', 'report']) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|This feed event must be recorded by its authoritative server action.';
      END IF;

      SELECT events.*
      INTO v_existing
      FROM public.feed_events AS events
      WHERE events.client_event_id = v_client_event_id;

      IF FOUND THEN
        IF v_existing.post_id IS DISTINCT FROM v_post_id
          OR v_existing.creator_user_id IS DISTINCT FROM v_creator_user_id
          OR v_existing.event_type IS DISTINCT FROM v_event_type
          OR v_existing.source_surface IS DISTINCT FROM v_source_surface
          OR v_existing.viewer_user_id IS DISTINCT FROM p_actor_user_id
          OR v_existing.anonymous_key_hash IS DISTINCT FROM (
            CASE WHEN p_actor_user_id IS NULL THEN p_anonymous_key_hash ELSE NULL END
          )
        THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '409|Feed event ID is already used by a different event.';
        END IF;
        v_duplicate := true;
      END IF;

      IF NOT v_duplicate THEN
        IF v_event_type = ANY (ARRAY['save', 'unsave']) AND p_actor_user_id IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '401|Authentication is required for feed save events.';
        END IF;

        IF v_delivery_id IS NULL AND (
          v_event_type = ANY (ARRAY[
            'impression', 'open', 'dwell', 'media_progress', 'quick_skip',
            'share', 'remix_start', 'resource_open'
          ])
          OR (
            v_event_type = ANY (ARRAY['not_interested', 'hide_creator'])
            AND p_actor_user_id IS NULL
          )
        ) THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|A matching feed delivery is required for this event.';
        END IF;

        v_session_id := v_feed_session_id;
        IF v_delivery_id IS NOT NULL THEN
          SELECT items.session_id, items.position
          INTO v_session_id, v_delivery_position
          FROM public.feed_session_items AS items
          WHERE items.id = v_delivery_id
            AND items.post_id = v_post_id
            AND (v_feed_session_id IS NULL OR items.session_id = v_feed_session_id);

          IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Feed delivery does not match this post.';
          END IF;
          IF v_position IS NOT NULL AND v_position IS DISTINCT FROM v_delivery_position THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Feed event position does not match its delivery.';
          END IF;
          v_position := coalesce(v_position, v_delivery_position);
        END IF;

        IF v_session_id IS NOT NULL THEN
          SELECT
            sessions.viewer_user_id,
            sessions.anonymous_key_hash,
            sessions.created_at,
            sessions.expires_at
          INTO
            v_session_user_id,
            v_session_anonymous_key_hash,
            v_session_created_at,
            v_session_expires_at
          FROM public.feed_sessions AS sessions
          WHERE sessions.id = v_session_id;

          IF NOT FOUND
            OR v_occurred_at < v_session_created_at
            OR v_occurred_at >= v_session_expires_at
          THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Feed session was not found or was inactive when this event occurred.';
          END IF;
          IF v_session_user_id IS NOT NULL THEN
            IF v_session_user_id IS DISTINCT FROM p_actor_user_id THEN
              RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Feed session does not belong to this viewer.';
            END IF;
          ELSIF p_actor_user_id IS NOT NULL
            OR v_session_anonymous_key_hash IS DISTINCT FROM p_anonymous_key_hash
          THEN
            -- Do not let an account claim a delivery created for a guest (or
            -- vice versa). Besides crossing actor modes, that would otherwise
            -- reach validate_feed_event_context() as a 23514 and abort every
            -- sibling in this batch.
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Feed session does not belong to this viewer.';
          END IF;
        END IF;

        IF v_event_type = 'media_progress' AND v_progress IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Media progress events require a progress value.';
        END IF;

        IF v_event_type = ANY (ARRAY['save', 'unsave']) AND p_actor_user_id IS NOT NULL THEN
          SELECT EXISTS (
            SELECT 1
            FROM public.post_saves AS saves
            WHERE saves.user_id = p_actor_user_id
              AND saves.post_id = v_post_id
          ) INTO v_saved;
          IF v_saved IS DISTINCT FROM (v_event_type = 'save') THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '409|Feed save event does not match the authoritative save state.';
          END IF;
        END IF;

        BEGIN
          IF v_event_type = 'media_progress' THEN
            PERFORM public.record_feed_media_progress_event(
              v_client_event_id,
              v_feed_session_id,
              v_delivery_id,
              p_actor_user_id,
              CASE WHEN p_actor_user_id IS NULL THEN p_anonymous_key_hash ELSE NULL END,
              v_post_id,
              v_creator_user_id,
              v_source_surface,
              v_position,
              v_duration_ms,
              v_progress,
              v_metadata,
              v_occurred_at
            );
          ELSE
            INSERT INTO public.feed_events (
              client_event_id,
              session_id,
              session_item_id,
              viewer_user_id,
              anonymous_key_hash,
              post_id,
              creator_user_id,
              event_type,
              source_surface,
              position,
              duration_ms,
              progress,
              metadata,
              occurred_at
            ) VALUES (
              v_client_event_id,
              v_feed_session_id,
              v_delivery_id,
              p_actor_user_id,
              CASE WHEN p_actor_user_id IS NULL THEN p_anonymous_key_hash ELSE NULL END,
              v_post_id,
              v_creator_user_id,
              v_event_type,
              v_source_surface,
              v_position,
              v_duration_ms,
              v_progress,
              v_metadata,
              v_occurred_at
            );
          END IF;
        EXCEPTION WHEN unique_violation THEN
          -- Re-resolve every capped uniqueness contract explicitly:
          -- feed_events_session_item_type_unique_idx,
          -- feed_events_user_post_signal_unique_idx and
          -- feed_events_user_creator_hide_unique_idx.
          v_existing := NULL;
          SELECT events.* INTO v_existing
          FROM public.feed_events AS events
          WHERE events.client_event_id = v_client_event_id;

          IF FOUND THEN
            IF v_existing.post_id = v_post_id
              AND v_existing.creator_user_id = v_creator_user_id
              AND v_existing.event_type = v_event_type
              AND v_existing.source_surface = v_source_surface
              AND v_existing.viewer_user_id IS NOT DISTINCT FROM p_actor_user_id
              AND v_existing.anonymous_key_hash IS NOT DISTINCT FROM (
                CASE WHEN p_actor_user_id IS NULL THEN p_anonymous_key_hash ELSE NULL END
              )
            THEN
              v_duplicate := true;
            ELSE
              -- An occupied client ID is authoritative. Never let an unrelated
              -- semantic cap mask a same-ID/different-event conflict.
              RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '409|Feed event ID is already used by a different event.';
            END IF;
          ELSE
            v_existing := NULL;
            IF v_delivery_id IS NOT NULL THEN
              SELECT events.* INTO v_existing
              FROM public.feed_events AS events
              WHERE events.session_item_id = v_delivery_id
                AND events.event_type = v_event_type;
            END IF;

            IF v_existing.id IS NULL
              AND p_actor_user_id IS NOT NULL
              AND v_event_type = ANY (ARRAY['save', 'unsave', 'not_interested'])
            THEN
              SELECT events.* INTO v_existing
              FROM public.feed_events AS events
              WHERE events.viewer_user_id = p_actor_user_id
                AND events.post_id = v_post_id
                AND events.event_type = v_event_type;
            END IF;

            IF v_existing.id IS NULL
              AND p_actor_user_id IS NOT NULL
              AND v_event_type = 'hide_creator'
            THEN
              SELECT events.* INTO v_existing
              FROM public.feed_events AS events
              WHERE events.viewer_user_id = p_actor_user_id
                AND events.creator_user_id = v_creator_user_id
                AND events.event_type = v_event_type;
            END IF;

            IF v_existing.id IS NOT NULL
              AND (v_event_type = 'hide_creator' OR v_existing.post_id = v_post_id)
              AND v_existing.creator_user_id = v_creator_user_id
              AND v_existing.event_type = v_event_type
              AND v_existing.viewer_user_id IS NOT DISTINCT FROM p_actor_user_id
              AND v_existing.anonymous_key_hash IS NOT DISTINCT FROM (
                CASE WHEN p_actor_user_id IS NULL THEN p_anonymous_key_hash ELSE NULL END
              )
            THEN
              v_duplicate := true;
            ELSE
              RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '409|Feed event ID is already used by a different event.';
            END IF;
          END IF;
        END;
      END IF;

      -- Preference state is deliberately applied only after the event insert or
      -- duplicate resolution. Tests pin this ordering.
      IF p_actor_user_id IS NOT NULL AND v_event_type = 'not_interested' THEN
        INSERT INTO public.feed_user_post_feedback (
          user_id, post_id, feedback_type, updated_at
        ) VALUES (
          p_actor_user_id, v_post_id, 'not_interested', v_occurred_at
        )
        ON CONFLICT (user_id, post_id) DO UPDATE SET
          feedback_type = EXCLUDED.feedback_type,
          updated_at = EXCLUDED.updated_at;
      ELSIF p_actor_user_id IS NOT NULL AND v_event_type = 'hide_creator' THEN
        INSERT INTO public.feed_user_creator_feedback (
          user_id, creator_user_id, feedback_type, updated_at
        ) VALUES (
          p_actor_user_id, v_creator_user_id, 'hide_creator', v_occurred_at
        )
        ON CONFLICT (user_id, creator_user_id) DO UPDATE SET
          feedback_type = EXCLUDED.feedback_type,
          updated_at = EXCLUDED.updated_at;
      END IF;

      v_outcome := jsonb_build_object(
        'index', v_event_index,
        'ok', true,
        'duplicate', v_duplicate
      );
    EXCEPTION
      WHEN SQLSTATE 'P0001' THEN
        v_status := substring(SQLERRM FROM 1 FOR 3)::integer;
        v_error := substring(SQLERRM FROM 5);
        v_outcome := jsonb_build_object(
          'index', v_event_index,
          'ok', false,
          'status', v_status,
          'error', v_error
        );
      WHEN SQLSTATE '22P02' OR SQLSTATE '22003' OR SQLSTATE '22007' OR SQLSTATE '22008' THEN
        -- Type casts are driven entirely by this one JSON entry. Treat malformed
        -- UUID, bigint, numeric and timestamp values as poison input while
        -- retaining transport-level 500s for real database failures.
        v_outcome := jsonb_build_object(
          'index', v_event_index,
          'ok', false,
          'status', 400,
          'error', 'Feed event contains an invalid identifier or value.'
        );
      WHEN OTHERS THEN
        -- Unknown database failures are transport-level failures, not poison
        -- input. Abort the transaction so callers return a retryable HTTP 500;
        -- replaying successful siblings is safe through client_event_id.
        RAISE;
    END;

    IF coalesce((v_outcome->>'ok')::boolean, false) THEN
      v_recorded := v_recorded + 1;
    ELSE
      v_rejected := v_rejected + 1;
    END IF;
    v_outcomes := v_outcomes || jsonb_build_array(v_outcome);
    v_event_index := v_event_index + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'recorded', v_recorded,
    'rejected', v_rejected,
    'outcomes', v_outcomes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_showcase_feed_events(uuid, text, jsonb)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_showcase_feed_events(uuid, text, jsonb)
TO service_role;

COMMENT ON FUNCTION public.record_showcase_feed_events(uuid, text, jsonb) IS
  'Records 1-25 validated feed events in one transaction with per-entry savepoint isolation and mixed outcomes.';
