-- Made with stores a model under the catalog's slug, dots and all.
--
-- save_post_source_tools_with_catalog slugified a sent model slug before it
-- looked the model up, so `veo-3.1` (the seeded catalog slug, and the
-- generation model's id that /api/showcase/publish sends since #617) became
-- `veo-3-1`, missed the seeded row and was stored hyphenated, matching
-- neither the catalog nor generations.model. 18 of the 45 generation models
-- have a dot in their id. Now:
--   - the lookup takes a catalog model whose slug slugifies to the sent one,
--     the one whose slug is the sent slug as it is ahead of any other. For
--     the app's own tool the catalog is generation_models as well: the June
--     seed lists 12 of the app's 45 models, and a composer sends a model its
--     picker lacks (one retired from the catalog) hyphenated;
--   - a sent slug the catalog lacks is kept as sent when it is already a
--     slug (letters and digits joined by single dots or hyphens). A model
--     sent with no slug still gets one from its label, hyphenated as before;
--   - the app's own models (magicbooklet) keep the label the server sent,
--     which names them as their posts print them (getPostModelDisplayName,
--     or the generation catalog's display name), where the June seed says
--     "Kling 2.6 Motion" and "Kling 3.0 Motion". The seed's labels stay: no
--     reader shows its app models, as withGenerationCatalogModels
--     (src/lib/source-tools-server.ts) swaps in the generation catalog's.
--
-- The posts UPDATE at the end ran on every save, rewriting the row and
-- rebuilding its search document (posts_refresh_public_search_document fires
-- on any UPDATE that sets source_tool) when nothing had changed. It now runs
-- only when the first tool changes. Running every time, it was also what
-- refused a save for an account being deleted (posts_freeze_for_account_deletion),
-- so the function now checks that first and raises the trigger's error.
--
-- A post with no media (a text post) sends no media kind, and `NULL NOT IN
-- (...)` let a new tool through to source_tools' check, a 500 that deleted
-- the new post. It now gets the validation error the API answers with 400.
--
-- Rows stored hyphenated get their slug back at the end. Production held
-- none on 2026-11-01 (read-only count: 19 Made with rows, one with a model,
-- a custom one); this covers rows written before this release.

-- The CLI runs a file's statements outside a transaction block, where SET
-- LOCAL does nothing: the function and the rows it would have written change
-- together.
BEGIN;
SET LOCAL lock_timeout = '5s';

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
  v_sent_model_slug text;
  v_new_model_slug text;
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

  IF public.is_account_deletion_requested(p_owner_user_id) THEN
    RAISE EXCEPTION 'Account deletion is already in progress'
      USING ERRCODE = 'object_not_in_prerequisite_state';
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
      IF p_media_kind IS NULL OR p_media_kind NOT IN ('image', 'video') THEN
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

      -- A sent slug that is already a slug keeps its dots (`veo-3.1`); a
      -- model the catalog lacks is stored, and created, under it.
      v_sent_model_slug := lower(btrim(v_entry->>'modelSlug'));
      IF v_sent_model_slug !~ '^[a-z0-9]+([.-][a-z0-9]+)*$' THEN
        v_sent_model_slug := NULL;
      END IF;
      v_new_model_slug := COALESCE(v_sent_model_slug, v_model_slug);

      v_canonical_model_slug := v_new_model_slug;

      IF v_tool_id IS NOT NULL THEN
        -- The app's models are the generation models too: the June seed
        -- lists 12 of them, and one retired from the catalog keeps its id.
        SELECT known.label, known.slug
        INTO v_canonical_model_label, v_canonical_model_slug
        FROM (
          SELECT label, slug, sort_order
          FROM public.source_tool_models
          WHERE source_tool_id = v_tool_id
          UNION ALL
          SELECT v_model_label, model_id, 1000
          FROM public.generation_models
          WHERE v_canonical_tool_slug = 'magicbooklet'
        ) AS known
        WHERE regexp_replace(
            regexp_replace(replace(lower(btrim(known.slug)), '&', ' and '), '[^a-z0-9]+', '-', 'g'),
            '(^-+|-+$)',
            '',
            'g'
          ) = v_model_slug
        ORDER BY known.slug = v_sent_model_slug DESC NULLS LAST, known.sort_order, known.slug
        LIMIT 1;

        IF NOT FOUND THEN
          v_canonical_model_label := v_model_label;
          v_canonical_model_slug := v_new_model_slug;
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
            v_new_model_slug,
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
              AND slug = v_new_model_slug
            LIMIT 1;
          END IF;
        ELSIF FOUND AND v_create_model THEN
          UPDATE public.source_tool_models
          SET is_active = true,
              updated_at = now()
          WHERE source_tool_id = v_tool_id
            AND slug = v_canonical_model_slug
            AND NOT is_active;
        END IF;
      ELSIF v_create_model THEN
        RAISE EXCEPTION 'Create the source tool before creating a model.';
      END IF;

      IF v_canonical_tool_slug = 'magicbooklet' THEN
        v_canonical_model_label := v_model_label;
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
    AND user_id = p_owner_user_id
    AND (
      source_tool IS DISTINCT FROM v_first_tool_label
      OR source_tool_slug IS DISTINCT FROM v_first_tool_slug
    );
END;
$$;

REVOKE ALL ON FUNCTION public.save_post_source_tools_with_catalog(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_post_source_tools_with_catalog(uuid, uuid, text, jsonb)
  TO service_role;

-- A row stored hyphenated gets its slug back when exactly one slug its tool
-- knows slugifies to it, by the function's lookup above: a catalog model's,
-- or for an app row a generation model's id. A row whose slug is itself one
-- its tool knows is left alone, so a model created under a hyphenated slug
-- keeps its rows.
WITH known_slugs AS (
  SELECT tools.slug AS tool_slug, models.slug
  FROM public.source_tool_models AS models
  JOIN public.source_tools AS tools ON tools.id = models.source_tool_id
  UNION
  SELECT 'magicbooklet', generation_models.model_id
  FROM public.generation_models
),
restored AS (
  SELECT stored.id, min(known_slugs.slug) AS slug
  FROM public.post_source_tools AS stored
  JOIN known_slugs
    ON known_slugs.tool_slug = stored.tool_slug
   AND regexp_replace(
         regexp_replace(replace(lower(btrim(known_slugs.slug)), '&', ' and '), '[^a-z0-9]+', '-', 'g'),
         '(^-+|-+$)',
         '',
         'g'
       ) = stored.model_slug
  WHERE NOT EXISTS (
    SELECT 1
    FROM known_slugs AS exact
    WHERE exact.tool_slug = stored.tool_slug
      AND exact.slug = stored.model_slug
  )
  GROUP BY stored.id
  HAVING count(DISTINCT known_slugs.slug) = 1
)
UPDATE public.post_source_tools AS stored
SET model_slug = restored.slug,
    updated_at = now()
FROM restored
WHERE stored.id = restored.id;

COMMIT;
