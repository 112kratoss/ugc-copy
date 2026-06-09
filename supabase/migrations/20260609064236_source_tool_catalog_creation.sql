ALTER TABLE public.source_tools
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.source_tool_models
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS source_tools_created_by_recent_idx
  ON public.source_tools (created_by_user_id, created_at DESC)
  WHERE created_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_tool_models_created_by_recent_idx
  ON public.source_tool_models (created_by_user_id, created_at DESC)
  WHERE created_by_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.save_post_source_tools_with_catalog(
  p_post_id uuid,
  p_owner_user_id uuid,
  p_media_kind text,
  p_source_tools jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_source_tools jsonb := COALESCE(p_source_tools, '[]'::jsonb);
  v_entry jsonb;
  v_tool_label text;
  v_tool_slug text;
  v_model_label text;
  v_model_slug text;
  v_canonical_tool_label text;
  v_canonical_tool_slug text;
  v_canonical_model_label text;
  v_canonical_model_slug text;
  v_tool_id uuid;
  v_create_tool boolean;
  v_create_model boolean;
  v_tool_count integer;
  v_model_count integer;
  v_sort_order integer := 0;
  v_first_tool_label text;
  v_first_tool_slug text;
BEGIN
  IF jsonb_typeof(v_source_tools) <> 'array' THEN
    RAISE EXCEPTION 'Source tool metadata must be an array.';
  END IF;

  IF jsonb_array_length(v_source_tools) > 5 THEN
    RAISE EXCEPTION 'A post can include at most 5 source tools.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.posts
    WHERE id = p_post_id
      AND user_id = p_owner_user_id
  ) THEN
    RAISE EXCEPTION 'The source tool post does not belong to this user.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_user_id::text, 0));

  DELETE FROM public.post_source_tools
  WHERE post_id = p_post_id;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_source_tools)
  LOOP
    v_tool_label := btrim(COALESCE(v_entry->>'toolLabel', ''));
    v_model_label := NULLIF(btrim(COALESCE(v_entry->>'modelLabel', '')), '');
    v_create_tool := COALESCE(v_entry->>'createTool', '') = 'true';
    v_create_model := COALESCE(v_entry->>'createModel', '') = 'true';

    IF v_tool_label = '' THEN
      RAISE EXCEPTION 'Source tool names cannot be empty.';
    END IF;
    IF char_length(v_tool_label) > 80 THEN
      RAISE EXCEPTION 'Source tool names must be 80 characters or fewer.';
    END IF;
    IF v_model_label IS NOT NULL AND char_length(v_model_label) > 80 THEN
      RAISE EXCEPTION 'Source model names must be 80 characters or fewer.';
    END IF;

    v_tool_slug := regexp_replace(
      regexp_replace(
        replace(lower(btrim(COALESCE(NULLIF(v_entry->>'toolSlug', ''), v_tool_label))), '&', ' and '),
        '[^a-z0-9]+',
        '-',
        'g'
      ),
      '(^-+|-+$)',
      '',
      'g'
    );

    IF v_tool_slug = '' THEN
      RAISE EXCEPTION 'Source tool names must include letters or numbers.';
    END IF;
    IF v_tool_slug = ANY (ARRAY['all', 'custom', 'unknown']) THEN
      RAISE EXCEPTION 'The source tool name "%" is reserved.', v_tool_label;
    END IF;

    v_tool_id := NULL;
    v_canonical_tool_label := v_tool_label;
    v_canonical_tool_slug := v_tool_slug;

    SELECT id, label, slug
    INTO v_tool_id, v_canonical_tool_label, v_canonical_tool_slug
    FROM public.source_tools
    WHERE slug = v_tool_slug
    LIMIT 1;

    IF NOT FOUND THEN
      v_tool_id := NULL;
      v_canonical_tool_label := v_tool_label;
      v_canonical_tool_slug := v_tool_slug;
    END IF;

    IF v_tool_id IS NULL AND v_create_tool THEN
      IF p_media_kind NOT IN ('image', 'video') THEN
        RAISE EXCEPTION 'Creating source tools requires image or video media.';
      END IF;

      SELECT count(*)
      INTO v_tool_count
      FROM public.source_tools
      WHERE created_by_user_id = p_owner_user_id
        AND created_at >= now() - interval '24 hours';

      IF v_tool_count >= 10 THEN
        RAISE EXCEPTION 'You reached the source tool creation limit of 10 per 24 hours.';
      END IF;

      INSERT INTO public.source_tools (
        slug,
        label,
        supported_media_kinds,
        sort_order,
        is_active,
        created_by_user_id
      )
      VALUES (
        v_tool_slug,
        v_tool_label,
        ARRAY[p_media_kind]::text[],
        1000,
        true,
        p_owner_user_id
      )
      ON CONFLICT (slug) DO NOTHING
      RETURNING id, label, slug
      INTO v_tool_id, v_canonical_tool_label, v_canonical_tool_slug;

      IF v_tool_id IS NULL THEN
        SELECT id, label, slug
        INTO v_tool_id, v_canonical_tool_label, v_canonical_tool_slug
        FROM public.source_tools
        WHERE slug = v_tool_slug
        LIMIT 1;
      END IF;
    ELSIF v_tool_id IS NOT NULL AND v_create_tool THEN
      UPDATE public.source_tools
      SET is_active = true,
          updated_at = now()
      WHERE id = v_tool_id
        AND NOT is_active;
    END IF;

    v_canonical_model_label := v_model_label;
    v_canonical_model_slug := NULL;

    IF v_model_label IS NOT NULL THEN
      v_model_slug := regexp_replace(
        regexp_replace(
          replace(lower(btrim(COALESCE(NULLIF(v_entry->>'modelSlug', ''), v_model_label))), '&', ' and '),
          '[^a-z0-9]+',
          '-',
          'g'
        ),
        '(^-+|-+$)',
        '',
        'g'
      );

      IF v_model_slug = '' THEN
        RAISE EXCEPTION 'Source model names must include letters or numbers.';
      END IF;
      IF v_model_slug = ANY (ARRAY['all', 'custom', 'unknown']) THEN
        RAISE EXCEPTION 'The source model name "%" is reserved.', v_model_label;
      END IF;

      v_canonical_model_slug := v_model_slug;

      IF v_tool_id IS NOT NULL THEN
        SELECT label, slug
        INTO v_canonical_model_label, v_canonical_model_slug
        FROM public.source_tool_models
        WHERE source_tool_id = v_tool_id
          AND slug = v_model_slug
        LIMIT 1;

        IF NOT FOUND THEN
          v_canonical_model_label := v_model_label;
          v_canonical_model_slug := v_model_slug;
        END IF;

        IF NOT FOUND AND v_create_model THEN
          SELECT count(*)
          INTO v_model_count
          FROM public.source_tool_models
          WHERE created_by_user_id = p_owner_user_id
            AND created_at >= now() - interval '24 hours';

          IF v_model_count >= 30 THEN
            RAISE EXCEPTION 'You reached the source model creation limit of 30 per 24 hours.';
          END IF;

          INSERT INTO public.source_tool_models (
            source_tool_id,
            slug,
            label,
            sort_order,
            is_active,
            created_by_user_id
          )
          VALUES (
            v_tool_id,
            v_model_slug,
            v_model_label,
            1000,
            true,
            p_owner_user_id
          )
          ON CONFLICT (source_tool_id, slug) DO NOTHING
          RETURNING label, slug
          INTO v_canonical_model_label, v_canonical_model_slug;

          IF NOT FOUND THEN
            SELECT label, slug
            INTO v_canonical_model_label, v_canonical_model_slug
            FROM public.source_tool_models
            WHERE source_tool_id = v_tool_id
              AND slug = v_model_slug
            LIMIT 1;
          END IF;
        ELSIF FOUND AND v_create_model THEN
          UPDATE public.source_tool_models
          SET is_active = true,
              updated_at = now()
          WHERE source_tool_id = v_tool_id
            AND slug = v_model_slug
            AND NOT is_active;
        END IF;
      ELSIF v_create_model THEN
        RAISE EXCEPTION 'Create the source tool before creating a model.';
      END IF;
    END IF;

    INSERT INTO public.post_source_tools (
      post_id,
      tool_label,
      tool_slug,
      model_label,
      model_slug,
      sort_order,
      updated_at
    )
    VALUES (
      p_post_id,
      v_canonical_tool_label,
      v_canonical_tool_slug,
      v_canonical_model_label,
      v_canonical_model_slug,
      v_sort_order,
      now()
    );

    IF v_sort_order = 0 THEN
      v_first_tool_label := v_canonical_tool_label;
      v_first_tool_slug := v_canonical_tool_slug;
    END IF;

    v_sort_order := v_sort_order + 1;
  END LOOP;

  UPDATE public.posts
  SET source_tool = v_first_tool_label,
      source_tool_slug = v_first_tool_slug,
      updated_at = now()
  WHERE id = p_post_id
    AND user_id = p_owner_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_post_source_tools_with_catalog(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_post_source_tools_with_catalog(uuid, uuid, text, jsonb)
  TO service_role;
