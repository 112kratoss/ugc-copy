-- "Include creation references" copies a creation's saved inputs into its
-- publisher's recipe files, post_resource_files/<publisher>/generation-references/
-- <generation>/<file>, and a run start imports a bought recipe's copy into the
-- buyer's generation inputs, generation_inputs/<buyer>/recipe-imports/<seller>/
-- <generation>/<file> (#677, #678). A copy made by a save refused or failing
-- after it, and the copies of a recipe or post deleted since, are named by
-- nothing, and an import whose run kept no input row is too. Nothing removed
-- them.
--
-- The recipe-copy-sweep job (src/lib/recipe-copy-sweep.ts) removes them, and
-- these are its reads:
--
-- * recipe_file_sweep_named_objects: every copy and import path anything names,
--   read as text out of whole rows, so a path is kept whichever column or form
--   (bare, bucket-prefixed, inside a signed link) holds it: every recipe as it
--   stands, every revision of one (sold or not, retired or not), the revision
--   supplements and escrow mappings, the purchase snapshots, the legacy
--   marketplace rows, every kept generation input row (its path and its
--   metadata, which names the copy or import it was made from), and the
--   generations and workflow canvases of the people and creations the paths
--   belong to.
-- * list_recipe_file_sweep_candidates: the copies and imports older than the
--   grace period that nothing names, oldest first, at most a batch, with counts
--   of what was examined and why the rest stays. An import also stays while
--   its buyer has started a run lately, since a run start reuses an import
--   already at its path.
-- * list_swept_recipe_copies_named_again: a swept copy a recipe names again (a
--   save that found the copy at its path just before the sweep removed it
--   writes its recipe after), with the saved input it was copied from, so the
--   job copies it back. The ledger the sweep writes before it removes anything
--   (recipe_file_sweep_deletions) is what makes that check possible.

CREATE TABLE public.recipe_file_sweep_deletions (
  bucket_id text NOT NULL,
  object_name text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (bucket_id, object_name),
  CONSTRAINT recipe_file_sweep_deletions_layout_check CHECK (
    (bucket_id = 'post_resource_files' AND object_name ~ '^[^/]+/generation-references/[^/]+/[^/]+$')
    OR (bucket_id = 'generation_inputs' AND object_name ~ '^[^/]+/recipe-imports/[^/]+/[^/]+/[^/]+$')
  )
);

CREATE INDEX recipe_file_sweep_deletions_deleted_at_idx
  ON public.recipe_file_sweep_deletions (deleted_at);

COMMENT ON TABLE public.recipe_file_sweep_deletions IS
  'Service-only ledger of the recipe copies and recipe imports the recipe-copy-sweep job removed, written before each removal and kept for a week, so a copy a recipe names again is copied back from its saved input.';

ALTER TABLE public.recipe_file_sweep_deletions ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.recipe_file_sweep_deletions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.recipe_file_sweep_deletions TO service_role;

-- What names a copy or an import. Called only by the two functions below, as
-- their owner.
CREATE FUNCTION public.recipe_file_sweep_named_objects(
  p_people uuid[],
  p_generations uuid[]
)
RETURNS TABLE(bucket_id text, object_name text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH texts AS (
    SELECT to_jsonb(bundles)::text AS body FROM public.post_resource_bundles AS bundles
    UNION ALL
    SELECT to_jsonb(revisions)::text FROM public.post_resource_bundle_revisions AS revisions
    UNION ALL
    SELECT to_jsonb(supplements)::text FROM public.post_resource_bundle_revision_supplements AS supplements
    UNION ALL
    SELECT to_jsonb(files)::text FROM public.post_resource_bundle_revision_files AS files
    UNION ALL
    SELECT to_jsonb(purchase_media)::text FROM public.post_resource_purchase_media AS purchase_media
    UNION ALL
    SELECT to_jsonb(assets)::text FROM public.marketplace_assets AS assets
    UNION ALL
    SELECT to_jsonb(content)::text FROM public.marketplace_asset_content AS content
    UNION ALL
    SELECT to_jsonb(inputs)::text FROM public.generation_input_media AS inputs
    UNION ALL
    SELECT to_jsonb(generations)::text
    FROM public.generations AS generations
    WHERE generations.user_id = ANY(coalesce(p_people, '{}'::uuid[]))
       OR generations.id = ANY(coalesce(p_generations, '{}'::uuid[]))
    UNION ALL
    SELECT to_jsonb(canvases)::text
    FROM public.workflow_canvases AS canvases
    WHERE canvases.user_id = ANY(coalesce(p_people, '{}'::uuid[]))
  ),
  mentioning AS (
    SELECT texts.body
    FROM texts
    WHERE strpos(texts.body, '/generation-references/') > 0
       OR strpos(texts.body, '/recipe-imports/') > 0
  )
  -- A segment is anything up to a slash, a quote, white space, a query or
  -- fragment, an escape or a JSON or record delimiter: the path stands out of
  -- a bare path, a bucket-prefixed one and a storage link alike.
  SELECT DISTINCT 'post_resource_files'::text, match[1]
  FROM mentioning,
    regexp_matches(
      mentioning.body,
      '([^/"''[:space:]?#\\,(){}<>]+/generation-references/[^/"''[:space:]?#\\,(){}<>]+/[^/"''[:space:]?#\\,(){}<>]+)',
      'g'
    ) AS match
  UNION
  SELECT DISTINCT 'generation_inputs'::text, match[1]
  FROM mentioning,
    regexp_matches(
      mentioning.body,
      '([^/"''[:space:]?#\\,(){}<>]+/recipe-imports/[^/"''[:space:]?#\\,(){}<>]+/[^/"''[:space:]?#\\,(){}<>]+/[^/"''[:space:]?#\\,(){}<>]+)',
      'g'
    ) AS match;
$$;

ALTER FUNCTION public.recipe_file_sweep_named_objects(uuid[], uuid[])
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.recipe_file_sweep_named_objects(uuid[], uuid[])
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.recipe_file_sweep_named_objects(uuid[], uuid[]) IS
  'Every recipe copy and recipe import path anything names: recipes, every revision, supplements, escrow mappings, purchase snapshots, legacy marketplace rows, every kept generation input, and the given people''s generations and canvases. Internal to the recipe-copy-sweep reads.';

CREATE FUNCTION public.list_recipe_file_sweep_candidates(
  p_created_before timestamptz,
  p_imports_quiet_since timestamptz,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_people uuid[];
  v_generations uuid[];
  v_buyers uuid[];
  v_result jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'list_recipe_file_sweep_candidates takes a limit from 1 to 1000, got %', p_limit
      USING ERRCODE = '22023';
  END IF;
  -- The floors hold whatever the caller asks: a copy a day old can still be
  -- the one a save is about to name, and an import is reused by the run start
  -- that made it for as long as its signed link lives (an hour).
  IF p_created_before IS NULL OR p_created_before > now() - interval '1 day' THEN
    RAISE EXCEPTION 'list_recipe_file_sweep_candidates keeps every file younger than a day'
      USING ERRCODE = '22023';
  END IF;
  IF p_imports_quiet_since IS NULL OR p_imports_quiet_since > now() - interval '1 hour' THEN
    RAISE EXCEPTION 'list_recipe_file_sweep_candidates keeps the imports of a buyer who ran in the last hour'
      USING ERRCODE = '22023';
  END IF;

  WITH layout AS (
    SELECT objects.bucket_id, objects.name
    FROM storage.objects AS objects
    WHERE (objects.bucket_id = 'post_resource_files'
           AND objects.name ~ '^[^/]+/generation-references/[^/]+/[^/.][^/]*$')
       OR (objects.bucket_id = 'generation_inputs'
           AND objects.name ~ '^[^/]+/recipe-imports/[^/]+/[^/]+/[^/.][^/]*$')
  ),
  segments AS (
    SELECT split_part(layout.name, '/', 1) AS person FROM layout
    UNION
    SELECT split_part(layout.name, '/', 3) FROM layout WHERE layout.bucket_id = 'generation_inputs'
  ),
  creations AS (
    SELECT split_part(layout.name, '/', 3) AS creation FROM layout WHERE layout.bucket_id = 'post_resource_files'
    UNION
    SELECT split_part(layout.name, '/', 4) FROM layout WHERE layout.bucket_id = 'generation_inputs'
  ),
  buyers AS (
    SELECT DISTINCT split_part(layout.name, '/', 1) AS buyer FROM layout WHERE layout.bucket_id = 'generation_inputs'
  )
  SELECT
    coalesce((SELECT array_agg(segments.person::uuid) FROM segments
              WHERE segments.person ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '{}'),
    coalesce((SELECT array_agg(creations.creation::uuid) FROM creations
              WHERE creations.creation ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '{}'),
    coalesce((SELECT array_agg(buyers.buyer::uuid) FROM buyers
              WHERE buyers.buyer ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '{}')
  INTO v_people, v_generations, v_buyers;

  WITH layout AS (
    SELECT objects.bucket_id, objects.name, objects.created_at
    FROM storage.objects AS objects
    WHERE (objects.bucket_id = 'post_resource_files'
           AND objects.name ~ '^[^/]+/generation-references/[^/]+/[^/.][^/]*$')
       OR (objects.bucket_id = 'generation_inputs'
           AND objects.name ~ '^[^/]+/recipe-imports/[^/]+/[^/]+/[^/.][^/]*$')
  ),
  named AS MATERIALIZED (
    SELECT named_objects.bucket_id, named_objects.object_name
    FROM public.recipe_file_sweep_named_objects(v_people, v_generations) AS named_objects
  ),
  active_buyers AS MATERIALIZED (
    SELECT DISTINCT generations.user_id::text AS buyer
    FROM public.generations AS generations
    WHERE generations.user_id = ANY(v_buyers)
      AND generations.created_at >= p_imports_quiet_since
  ),
  judged AS MATERIALIZED (
    SELECT
      layout.bucket_id,
      layout.name,
      layout.created_at,
      (layout.created_at IS NULL OR layout.created_at >= p_created_before) AS too_recent,
      EXISTS (
        SELECT 1 FROM named
        WHERE named.bucket_id = layout.bucket_id AND named.object_name = layout.name
      ) AS is_named,
      (
        layout.bucket_id = 'generation_inputs'
        AND EXISTS (
          SELECT 1 FROM active_buyers
          WHERE active_buyers.buyer = split_part(layout.name, '/', 1)
        )
      ) AS buyer_active
    FROM layout
  )
  SELECT jsonb_build_object(
    'examined', count(*),
    'tooRecent', count(*) FILTER (WHERE judged.too_recent),
    'named', count(*) FILTER (WHERE NOT judged.too_recent AND judged.is_named),
    'importsInUse', count(*) FILTER (WHERE NOT judged.too_recent AND NOT judged.is_named AND judged.buyer_active),
    'unnamed', count(*) FILTER (WHERE NOT judged.too_recent AND NOT judged.is_named AND NOT judged.buyer_active),
    'candidates', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object('bucketId', picked.bucket_id, 'name', picked.name, 'createdAt', picked.created_at)
        ORDER BY picked.created_at, picked.bucket_id, picked.name
      )
      FROM (
        SELECT eligible.bucket_id, eligible.name, eligible.created_at
        FROM judged AS eligible
        WHERE NOT eligible.too_recent AND NOT eligible.is_named AND NOT eligible.buyer_active
        ORDER BY eligible.created_at, eligible.bucket_id, eligible.name
        LIMIT p_limit
      ) AS picked
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM judged;

  RETURN v_result;
END;
$$;

ALTER FUNCTION public.list_recipe_file_sweep_candidates(timestamptz, timestamptz, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_recipe_file_sweep_candidates(timestamptz, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_recipe_file_sweep_candidates(timestamptz, timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.list_recipe_file_sweep_candidates(timestamptz, timestamptz, integer) IS
  'The recipe copies and recipe imports created before p_created_before (at least a day ago) that nothing names, an import also only while its buyer has started no run since p_imports_quiet_since: oldest first, at most p_limit, with counts. Read by the recipe-copy-sweep job.';

CREATE FUNCTION public.list_swept_recipe_copies_named_again(
  p_deleted_since timestamptz,
  p_limit integer
)
RETURNS TABLE(
  object_name text,
  input_id uuid,
  input_user_id uuid,
  input_role text,
  input_sort_order integer,
  input_storage_path text,
  input_media_type text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_people uuid[];
  v_generations uuid[];
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'list_swept_recipe_copies_named_again takes a limit from 1 to 1000, got %', p_limit
      USING ERRCODE = '22023';
  END IF;

  WITH recent AS (
    SELECT
      split_part(deletions.object_name, '/', 1) AS person,
      split_part(deletions.object_name, '/', 3) AS creation
    FROM public.recipe_file_sweep_deletions AS deletions
    WHERE deletions.bucket_id = 'post_resource_files'
      AND deletions.deleted_at >= p_deleted_since
  )
  SELECT
    coalesce((SELECT array_agg(DISTINCT recent.person::uuid) FROM recent
              WHERE recent.person ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '{}'),
    coalesce((SELECT array_agg(DISTINCT recent.creation::uuid) FROM recent
              WHERE recent.creation ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '{}')
  INTO v_people, v_generations;

  IF cardinality(v_people) = 0 AND cardinality(v_generations) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH swept AS (
    SELECT deletions.object_name
    FROM public.recipe_file_sweep_deletions AS deletions
    WHERE deletions.bucket_id = 'post_resource_files'
      AND deletions.deleted_at >= p_deleted_since
      -- A save that found no copy at its path made a new one: nothing to do.
      AND NOT EXISTS (
        SELECT 1 FROM storage.objects AS objects
        WHERE objects.bucket_id = 'post_resource_files' AND objects.name = deletions.object_name
      )
  ),
  named AS MATERIALIZED (
    SELECT named_objects.object_name
    FROM public.recipe_file_sweep_named_objects(v_people, v_generations) AS named_objects
    WHERE named_objects.bucket_id = 'post_resource_files'
  )
  SELECT
    swept.object_name,
    inputs.id,
    inputs.user_id,
    inputs.role,
    inputs.sort_order,
    inputs.storage_path,
    inputs.media_type
  FROM swept
  JOIN named ON named.object_name = swept.object_name
  -- The copy is named for the saved input it was made from: its row id ends
  -- the file name, and its creation is the folder's.
  LEFT JOIN public.generation_input_media AS inputs
    ON inputs.id::text = substring(
         swept.object_name
         FROM '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[^./]+$'
       )
   AND inputs.generation_id::text = split_part(swept.object_name, '/', 3)
  ORDER BY swept.object_name
  LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.list_swept_recipe_copies_named_again(timestamptz, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_swept_recipe_copies_named_again(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_swept_recipe_copies_named_again(timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.list_swept_recipe_copies_named_again(timestamptz, integer) IS
  'The recipe copies the recipe-copy-sweep job removed since p_deleted_since that something names again and are not back at their path, each with the saved input row it was copied from (null when that row is gone). Read by the job, which copies them back.';
