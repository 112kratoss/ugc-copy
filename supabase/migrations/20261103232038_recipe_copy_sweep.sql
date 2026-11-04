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
-- this is what it reads and writes:
--
-- * recipe_file_paths_in_text: the copy and import paths a text names, in any
--   form (bare, bucket-prefixed, inside a storage link), bucket-qualified.
-- * Two small partial indexes on generation_input_media find the kept inputs of
--   anyone (a buyer's run of a bought recipe) that name a given copy: by the
--   copy the row recorded (metadata.recipeFile) and by a copy it ran from
--   directly (metadata.sourceStoragePath). An import is in its buyer's folder,
--   so the buyer's own kept inputs, read by user_id, cover it.
-- * recipe_file_sweep_named: of a batch of paths, those something names. It
--   reads only through indexed keys taken from the paths themselves (the
--   publisher, buyer and seller, and the creation): their recipes and the
--   recipes on the creation's posts, every revision of those (sold or not,
--   retired or not), their supplements and escrow mappings, their purchases'
--   snapshots, the legacy marketplace rows of those people, the kept inputs of
--   those people and of the creation, the kept inputs anywhere naming the path
--   (the index above), and the generations and workflow canvases of those
--   people.
-- * list_recipe_file_sweep_candidates: walks each bucket in name order from a
--   stored cursor, a bounded page a run, and hands back the files in the two
--   folders older than the grace period that nothing names; an import also
--   stays while a run start has reused it lately (recipe_import_uses).
-- * record_recipe_import_use: a run start records each import it makes or
--   reuses before it touches the file, so the sweep never removes one in use.
-- * list_swept_recipe_copies_named_again: a few removed copies at a time,
--   least recently checked first, that something names again, with the saved
--   input to copy each back from or, where that is gone, an import of the same
--   copy that survives.

-- ─── Paths in a text ────────────────────────────────────────────────────────

-- A segment is anything up to a slash, a quote, white space, a query or
-- fragment, an escape or a JSON or record delimiter.
CREATE FUNCTION public.recipe_file_paths_in_text(p_text text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(DISTINCT found.path), '{}'::text[])
  FROM (
    SELECT 'post_resource_files/' || match[1] AS path
    FROM regexp_matches(
      coalesce(p_text, ''),
      '([^/"''[:space:]?#\\,(){}<>]+/generation-references/[^/"''[:space:]?#\\,(){}<>]+/[^/"''[:space:]?#\\,(){}<>]+)',
      'g'
    ) AS match
    UNION ALL
    SELECT 'generation_inputs/' || match[1]
    FROM regexp_matches(
      coalesce(p_text, ''),
      '([^/"''[:space:]?#\\,(){}<>]+/recipe-imports/[^/"''[:space:]?#\\,(){}<>]+/[^/"''[:space:]?#\\,(){}<>]+/[^/"''[:space:]?#\\,(){}<>]+)',
      'g'
    ) AS match
  ) AS found;
$$;

ALTER FUNCTION public.recipe_file_paths_in_text(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.recipe_file_paths_in_text(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recipe_file_paths_in_text(text) TO service_role;

COMMENT ON FUNCTION public.recipe_file_paths_in_text(text) IS
  'The recipe copy (post_resource_files/...) and recipe import (generation_inputs/...) paths a text names, bare, bucket-prefixed or in a storage link.';

-- The kept inputs that name a seller's copy: a buyer's run records the copy it
-- used (metadata.recipeFile, src/lib/generation-input-media.ts) and may have run
-- from it directly (sourceStoragePath). Both indexes are partial, so they hold
-- only those rows, a small share of the table; the build still reads the table
-- once under a SHARE lock, which holds new kept inputs back for that long, and
-- waits at most five seconds for the lock itself.
SET LOCAL lock_timeout = '5s';

CREATE INDEX generation_input_media_recipe_file_idx
  ON public.generation_input_media ((metadata ->> 'recipeFile'))
  WHERE metadata ? 'recipeFile';

CREATE INDEX generation_input_media_recipe_copy_source_idx
  ON public.generation_input_media ((metadata ->> 'sourceStoragePath'))
  WHERE (metadata ->> 'sourceStoragePath') LIKE 'post_resource_files/%';

-- ─── State ──────────────────────────────────────────────────────────────────

CREATE TABLE public.recipe_file_sweep_deletions (
  bucket_id text NOT NULL,
  object_name text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  -- When the named-again read last looked at it; it looks at the least recent first.
  checked_at timestamptz,
  PRIMARY KEY (bucket_id, object_name),
  CONSTRAINT recipe_file_sweep_deletions_layout_check CHECK (
    (bucket_id = 'post_resource_files' AND object_name ~ '^[^/]+/generation-references/[^/]+/[^/]+$')
    OR (bucket_id = 'generation_inputs' AND object_name ~ '^[^/]+/recipe-imports/[^/]+/[^/]+/[^/]+$')
  )
);

CREATE INDEX recipe_file_sweep_deletions_deleted_at_idx
  ON public.recipe_file_sweep_deletions (deleted_at);
CREATE INDEX recipe_file_sweep_deletions_checked_idx
  ON public.recipe_file_sweep_deletions (bucket_id, checked_at NULLS FIRST, deleted_at);

COMMENT ON TABLE public.recipe_file_sweep_deletions IS
  'Service-only ledger of the recipe copies and recipe imports the recipe-copy-sweep job removed, written before each removal and kept for two weeks, so a copy something names again is copied back.';

ALTER TABLE public.recipe_file_sweep_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.recipe_file_sweep_deletions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.recipe_file_sweep_deletions TO service_role;

-- Where each bucket's walk stands: the last object name read ('' to start over).
CREATE TABLE public.recipe_file_sweep_cursors (
  bucket_id text PRIMARY KEY CHECK (bucket_id IN ('post_resource_files', 'generation_inputs')),
  after_name text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

COMMENT ON TABLE public.recipe_file_sweep_cursors IS
  'Where the recipe-copy-sweep job''s walk of each bucket stands. Written only by list_recipe_file_sweep_candidates.';

ALTER TABLE public.recipe_file_sweep_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.recipe_file_sweep_cursors
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.recipe_file_sweep_cursors TO service_role;

-- A run start's latest make or reuse of each import, by the database's clock.
CREATE TABLE public.recipe_import_uses (
  object_name text PRIMARY KEY CHECK (object_name ~ '^[^/]+/recipe-imports/[^/]+/[^/]+/[^/]+$'),
  buyer_user_id uuid NOT NULL,
  used_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  -- The copy it was made from, in the recipe files: how a removed copy finds an import of it.
  copy_object_name text GENERATED ALWAYS AS (
    split_part(object_name, '/', 3) || '/generation-references/' || split_part(object_name, '/', 4)
      || '/' || split_part(object_name, '/', 5)
  ) STORED,
  CHECK (split_part(object_name, '/', 1) = buyer_user_id::text)
);

CREATE INDEX recipe_import_uses_used_at_idx ON public.recipe_import_uses (used_at);
CREATE INDEX recipe_import_uses_copy_object_name_idx ON public.recipe_import_uses (copy_object_name);

COMMENT ON TABLE public.recipe_import_uses IS
  'When a run start last made or reused each recipe import (generation_inputs/<buyer>/recipe-imports/...), recorded before it touches the file, so the recipe-copy-sweep job leaves an import in use alone. Written by record_recipe_import_use.';

ALTER TABLE public.recipe_import_uses ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.recipe_import_uses
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, DELETE ON TABLE public.recipe_import_uses TO service_role;

CREATE FUNCTION public.record_recipe_import_use(p_buyer_user_id uuid, p_object_name text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.recipe_import_uses AS uses (object_name, buyer_user_id, used_at)
  VALUES (p_object_name, p_buyer_user_id, timezone('utc'::text, now()))
  ON CONFLICT (object_name) DO UPDATE SET used_at = excluded.used_at;
$$;

ALTER FUNCTION public.record_recipe_import_use(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_recipe_import_use(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_recipe_import_use(uuid, text) TO service_role;

COMMENT ON FUNCTION public.record_recipe_import_use(uuid, text) IS
  'Records, by the database''s clock, that a run start is making or reusing this recipe import. Called before the file is copied or signed.';

CREATE FUNCTION public.list_recipe_imports_used_since(p_object_names text[], p_since timestamptz)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT uses.object_name
  FROM public.recipe_import_uses AS uses
  WHERE uses.object_name = ANY(coalesce(p_object_names, '{}'::text[]))
    AND uses.used_at >= p_since;
$$;

ALTER FUNCTION public.list_recipe_imports_used_since(text[], timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_recipe_imports_used_since(text[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_recipe_imports_used_since(text[], timestamptz) TO service_role;

-- ─── What names a path ──────────────────────────────────────────────────────

CREATE FUNCTION public.recipe_file_sweep_named(p_paths text[])
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH wanted AS MATERIALIZED (
    SELECT DISTINCT asked.path
    FROM unnest(coalesce(p_paths, '{}'::text[])) AS asked(path)
    WHERE asked.path ~ '^post_resource_files/[^/]+/generation-references/[^/]+/[^/]+$'
       OR asked.path ~ '^generation_inputs/[^/]+/recipe-imports/[^/]+/[^/]+/[^/]+$'
  ),
  segments AS (
    SELECT
      split_part(wanted.path, '/', 2) AS person,
      CASE WHEN wanted.path LIKE 'generation_inputs/%' THEN split_part(wanted.path, '/', 4) END AS seller,
      CASE WHEN wanted.path LIKE 'generation_inputs/%' THEN split_part(wanted.path, '/', 5)
           ELSE split_part(wanted.path, '/', 4) END AS creation
    FROM wanted
  ),
  people AS MATERIALIZED (
    SELECT DISTINCT found.id::uuid AS id
    FROM (SELECT segments.person AS id FROM segments UNION SELECT segments.seller FROM segments) AS found
    WHERE found.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  creations AS MATERIALIZED (
    SELECT DISTINCT segments.creation::uuid AS id
    FROM segments
    WHERE segments.creation ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  -- The recipes of those people, and the recipes on the creation's posts
  -- (a recipe whose owner changed in a merge still sits on that post).
  bundle_ids AS MATERIALIZED (
    SELECT bundles.id FROM public.post_resource_bundles AS bundles
    WHERE bundles.owner_user_id IN (SELECT people.id FROM people)
    UNION
    SELECT bundles.id
    FROM public.posts AS posts
    JOIN public.post_resource_bundles AS bundles ON bundles.post_id = posts.id
    WHERE posts.generation_id IN (SELECT creations.id FROM creations)
       OR posts.deleted_generation_id IN (SELECT creations.id FROM creations)
  ),
  revision_ids AS MATERIALIZED (
    SELECT revisions.id FROM public.post_resource_bundle_revisions AS revisions
    WHERE revisions.bundle_id IN (SELECT bundle_ids.id FROM bundle_ids)
  ),
  purchase_ids AS MATERIALIZED (
    SELECT purchases.id FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.bundle_id IN (SELECT bundle_ids.id FROM bundle_ids)
  ),
  asset_ids AS MATERIALIZED (
    SELECT assets.id FROM public.marketplace_assets AS assets
    WHERE assets.seller_user_id IN (SELECT people.id FROM people)
  ),
  texts AS (
    SELECT to_jsonb(bundles)::text AS body
    FROM public.post_resource_bundles AS bundles
    WHERE bundles.id IN (SELECT bundle_ids.id FROM bundle_ids)
    UNION ALL
    SELECT to_jsonb(revisions)::text
    FROM public.post_resource_bundle_revisions AS revisions
    WHERE revisions.id IN (SELECT revision_ids.id FROM revision_ids)
    UNION ALL
    SELECT to_jsonb(supplements)::text
    FROM public.post_resource_bundle_revision_supplements AS supplements
    WHERE supplements.revision_id IN (SELECT revision_ids.id FROM revision_ids)
    UNION ALL
    SELECT to_jsonb(files)::text
    FROM public.post_resource_bundle_revision_files AS files
    WHERE files.revision_id IN (SELECT revision_ids.id FROM revision_ids)
    UNION ALL
    SELECT to_jsonb(purchase_media)::text
    FROM public.post_resource_purchase_media AS purchase_media
    WHERE purchase_media.purchase_id IN (SELECT purchase_ids.id FROM purchase_ids)
    UNION ALL
    SELECT to_jsonb(assets)::text
    FROM public.marketplace_assets AS assets
    WHERE assets.id IN (SELECT asset_ids.id FROM asset_ids)
    UNION ALL
    SELECT to_jsonb(content)::text
    FROM public.marketplace_asset_content AS content
    WHERE content.asset_id IN (SELECT asset_ids.id FROM asset_ids)
    UNION ALL
    SELECT to_jsonb(inputs)::text
    FROM public.generation_input_media AS inputs
    WHERE inputs.user_id IN (SELECT people.id FROM people)
    UNION ALL
    SELECT to_jsonb(inputs)::text
    FROM public.generation_input_media AS inputs
    WHERE inputs.generation_id IN (SELECT creations.id FROM creations)
    UNION ALL
    SELECT to_jsonb(generations)::text
    FROM public.generations AS generations
    WHERE generations.id IN (SELECT creations.id FROM creations)
    UNION ALL
    SELECT to_jsonb(generations)::text
    FROM public.generations AS generations
    WHERE generations.user_id IN (SELECT people.id FROM people)
    UNION ALL
    SELECT to_jsonb(canvases)::text
    FROM public.workflow_canvases AS canvases
    WHERE canvases.user_id IN (SELECT people.id FROM people)
  ),
  mentions AS (
    SELECT unnest(public.recipe_file_paths_in_text(texts.body)) AS path
    FROM texts
    WHERE strpos(texts.body, '/generation-references/') > 0
       OR strpos(texts.body, '/recipe-imports/') > 0
    UNION ALL
    -- Anyone's kept input naming a copy: a buyer's run of a bought recipe,
    -- through the two partial indexes.
    SELECT inputs.metadata ->> 'recipeFile'
    FROM public.generation_input_media AS inputs
    WHERE inputs.metadata ? 'recipeFile'
      AND (inputs.metadata ->> 'recipeFile') IN (SELECT wanted.path FROM wanted)
    UNION ALL
    SELECT inputs.metadata ->> 'sourceStoragePath'
    FROM public.generation_input_media AS inputs
    WHERE (inputs.metadata ->> 'sourceStoragePath') LIKE 'post_resource_files/%'
      AND (inputs.metadata ->> 'sourceStoragePath') IN (SELECT wanted.path FROM wanted)
  )
  SELECT wanted.path
  FROM wanted
  WHERE wanted.path IN (SELECT mentions.path FROM mentions);
$$;

ALTER FUNCTION public.recipe_file_sweep_named(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.recipe_file_sweep_named(text[])
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.recipe_file_sweep_named(text[]) IS
  'Of these bucket-qualified recipe copy and import paths, those something names: recipes (of the people in the paths and on the creation''s posts), every revision, supplement, escrow mapping and purchase snapshot of them, the people''s legacy marketplace rows, kept inputs (of the people, of the creation, and anyone''s naming the path), and the people''s generations and canvases. Internal to the recipe-copy-sweep reads.';

-- ─── The candidates ─────────────────────────────────────────────────────────

CREATE FUNCTION public.list_recipe_file_sweep_candidates(
  p_created_before timestamptz,
  p_imports_quiet_since timestamptz,
  p_limit integer,
  p_scan_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_after_copies text;
  v_after_imports text;
  v_result jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'list_recipe_file_sweep_candidates takes a limit from 1 to 1000, got %', p_limit
      USING ERRCODE = '22023';
  END IF;
  IF p_scan_limit IS NULL OR p_scan_limit < 1 OR p_scan_limit > 20000 THEN
    RAISE EXCEPTION 'list_recipe_file_sweep_candidates scans from 1 to 20000 objects a bucket, got %', p_scan_limit
      USING ERRCODE = '22023';
  END IF;
  -- The floors hold whatever the caller asks: a copy a day old can still be
  -- the one a save is about to name, and an import reused within two hours
  -- may still be fetched through the link its start signed (an hour).
  IF p_created_before IS NULL OR p_created_before > now() - interval '1 day' THEN
    RAISE EXCEPTION 'list_recipe_file_sweep_candidates keeps every file younger than a day'
      USING ERRCODE = '22023';
  END IF;
  IF p_imports_quiet_since IS NULL OR p_imports_quiet_since > now() - interval '2 hours' THEN
    RAISE EXCEPTION 'list_recipe_file_sweep_candidates keeps every import reused in the last two hours'
      USING ERRCODE = '22023';
  END IF;

  -- One walk at a time: a second caller waits for the first to move the cursors.
  INSERT INTO public.recipe_file_sweep_cursors (bucket_id)
  VALUES ('post_resource_files'), ('generation_inputs')
  ON CONFLICT (bucket_id) DO NOTHING;
  SELECT cursors.after_name INTO v_after_copies
  FROM public.recipe_file_sweep_cursors AS cursors
  WHERE cursors.bucket_id = 'post_resource_files'
  FOR UPDATE;
  SELECT cursors.after_name INTO v_after_imports
  FROM public.recipe_file_sweep_cursors AS cursors
  WHERE cursors.bucket_id = 'generation_inputs'
  FOR UPDATE;

  WITH copies_page AS MATERIALIZED (
    SELECT objects.bucket_id, objects.name, objects.created_at
    FROM storage.objects AS objects
    WHERE objects.bucket_id = 'post_resource_files' AND objects.name > v_after_copies
    ORDER BY objects.name
    LIMIT p_scan_limit
  ),
  imports_page AS MATERIALIZED (
    SELECT objects.bucket_id, objects.name, objects.created_at
    FROM storage.objects AS objects
    WHERE objects.bucket_id = 'generation_inputs' AND objects.name > v_after_imports
    ORDER BY objects.name
    LIMIT p_scan_limit
  ),
  layout AS MATERIALIZED (
    SELECT page.bucket_id, page.name, page.created_at
    FROM (SELECT * FROM copies_page UNION ALL SELECT * FROM imports_page) AS page
    WHERE (page.bucket_id = 'post_resource_files' AND page.name ~ '^[^/]+/generation-references/[^/]+/[^/.][^/]*$')
       OR (page.bucket_id = 'generation_inputs' AND page.name ~ '^[^/]+/recipe-imports/[^/]+/[^/]+/[^/.][^/]*$')
  ),
  old AS MATERIALIZED (
    SELECT layout.bucket_id, layout.name, layout.created_at, layout.bucket_id || '/' || layout.name AS path
    FROM layout
    WHERE layout.created_at IS NOT NULL AND layout.created_at < p_created_before
  ),
  named AS MATERIALIZED (
    SELECT named_paths.path
    FROM public.recipe_file_sweep_named((SELECT array_agg(old.path) FROM old)) AS named_paths(path)
  ),
  in_use AS MATERIALIZED (
    SELECT uses.object_name
    FROM public.recipe_import_uses AS uses
    JOIN old ON old.bucket_id = 'generation_inputs' AND old.name = uses.object_name
    WHERE uses.used_at >= p_imports_quiet_since
  ),
  judged AS MATERIALIZED (
    SELECT
      old.bucket_id,
      old.name,
      old.created_at,
      named.path IS NOT NULL AS is_named,
      in_use.object_name IS NOT NULL AS is_in_use
    FROM old
    LEFT JOIN named ON named.path = old.path
    LEFT JOIN in_use ON old.bucket_id = 'generation_inputs' AND in_use.object_name = old.name
  ),
  ranked AS MATERIALIZED (
    SELECT
      judged.bucket_id,
      judged.name,
      judged.created_at,
      row_number() OVER (ORDER BY judged.bucket_id <> 'post_resource_files', judged.name) AS position
    FROM judged
    WHERE NOT judged.is_named AND NOT judged.is_in_use
  ),
  picked AS MATERIALIZED (
    SELECT ranked.bucket_id, ranked.name, ranked.created_at
    FROM ranked
    WHERE ranked.position <= p_limit
  )
  SELECT jsonb_build_object(
    'readAt', now(),
    'scanned', (SELECT count(*) FROM copies_page) + (SELECT count(*) FROM imports_page),
    'examined', (SELECT count(*) FROM layout),
    'tooRecent', (SELECT count(*) FROM layout) - (SELECT count(*) FROM old),
    'named', (SELECT count(*) FROM judged WHERE judged.is_named),
    'importsInUse', (SELECT count(*) FROM judged WHERE NOT judged.is_named AND judged.is_in_use),
    'unnamed', (SELECT count(*) FROM ranked),
    'candidates', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object('bucketId', picked.bucket_id, 'name', picked.name, 'createdAt', picked.created_at)
        ORDER BY picked.bucket_id <> 'post_resource_files', picked.name
      )
      FROM picked
    ), '[]'::jsonb),
    -- Each walk goes on after the last candidate handed back where the batch
    -- left some of its page, after its page where it did not, and starts over
    -- at the end of the bucket.
    'nextCopies', CASE
      WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.bucket_id = 'post_resource_files' AND ranked.position > p_limit)
        THEN coalesce((SELECT max(picked.name) FROM picked WHERE picked.bucket_id = 'post_resource_files'), v_after_copies)
      WHEN (SELECT count(*) FROM copies_page) >= p_scan_limit
        THEN (SELECT max(copies_page.name) FROM copies_page)
      ELSE ''
    END,
    'nextImports', CASE
      WHEN EXISTS (SELECT 1 FROM ranked WHERE ranked.bucket_id = 'generation_inputs' AND ranked.position > p_limit)
        THEN coalesce((SELECT max(picked.name) FROM picked WHERE picked.bucket_id = 'generation_inputs'), v_after_imports)
      WHEN (SELECT count(*) FROM imports_page) >= p_scan_limit
        THEN (SELECT max(imports_page.name) FROM imports_page)
      ELSE ''
    END
  )
  INTO v_result;

  UPDATE public.recipe_file_sweep_cursors AS cursors
  SET after_name = CASE cursors.bucket_id
        WHEN 'post_resource_files' THEN v_result->>'nextCopies'
        ELSE v_result->>'nextImports'
      END,
      updated_at = timezone('utc'::text, now())
  WHERE cursors.bucket_id IN ('post_resource_files', 'generation_inputs');

  RETURN v_result;
END;
$$;

ALTER FUNCTION public.list_recipe_file_sweep_candidates(timestamptz, timestamptz, integer, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_recipe_file_sweep_candidates(timestamptz, timestamptz, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_recipe_file_sweep_candidates(timestamptz, timestamptz, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.list_recipe_file_sweep_candidates(timestamptz, timestamptz, integer, integer) IS
  'Walks each bucket p_scan_limit objects on from its cursor and hands back the recipe copies and imports created before p_created_before (at least a day ago) that nothing names, an import only if no run start reused it since p_imports_quiet_since: at most p_limit, copies first, in name order, with counts. Moves the cursors. Read by the recipe-copy-sweep job.';

-- ─── A removed copy named again ─────────────────────────────────────────────

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
  input_media_type text,
  surviving_import text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'list_swept_recipe_copies_named_again takes a limit from 1 to 1000, got %', p_limit
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH batch AS MATERIALIZED (
    SELECT deletions.object_name
    FROM public.recipe_file_sweep_deletions AS deletions
    WHERE deletions.bucket_id = 'post_resource_files'
      AND deletions.deleted_at >= p_deleted_since
    ORDER BY deletions.checked_at NULLS FIRST, deletions.deleted_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  touched AS MATERIALIZED (
    UPDATE public.recipe_file_sweep_deletions AS deletions
    SET checked_at = timezone('utc'::text, now())
    FROM batch
    WHERE deletions.bucket_id = 'post_resource_files'
      AND deletions.object_name = batch.object_name
    RETURNING deletions.object_name
  ),
  -- A save that found no copy at its path made a new one: nothing to do.
  missing AS MATERIALIZED (
    SELECT touched.object_name
    FROM touched
    WHERE NOT EXISTS (
      SELECT 1 FROM storage.objects AS objects
      WHERE objects.bucket_id = 'post_resource_files' AND objects.name = touched.object_name
    )
  ),
  named AS MATERIALIZED (
    SELECT named_paths.path
    FROM public.recipe_file_sweep_named(
      (SELECT array_agg('post_resource_files/' || missing.object_name) FROM missing)
    ) AS named_paths(path)
  )
  SELECT
    missing.object_name,
    inputs.id,
    inputs.user_id,
    inputs.role,
    inputs.sort_order,
    inputs.storage_path,
    inputs.media_type,
    -- Where the saved input is gone, a buyer's import of the same copy holds its
    -- bytes. Found through indexes only: the imports run starts recorded, and the
    -- buyers whose kept inputs recorded the copy (an import is at a fixed path in
    -- the buyer's folder); then the object itself, by its name.
    CASE WHEN inputs.id IS NULL THEN (
      SELECT imports.name
      FROM (
        SELECT uses.object_name AS name
        FROM public.recipe_import_uses AS uses
        WHERE uses.copy_object_name = missing.object_name
        UNION
        SELECT kept.user_id::text || '/recipe-imports/' || split_part(missing.object_name, '/', 1) || '/'
               || split_part(missing.object_name, '/', 3) || '/' || split_part(missing.object_name, '/', 4)
        FROM public.generation_input_media AS kept
        WHERE kept.metadata ? 'recipeFile'
          AND (kept.metadata ->> 'recipeFile') = 'post_resource_files/' || missing.object_name
      ) AS imports
      WHERE EXISTS (
        SELECT 1 FROM storage.objects AS objects
        WHERE objects.bucket_id = 'generation_inputs' AND objects.name = imports.name
      )
      ORDER BY imports.name
      LIMIT 1
    ) END
  FROM missing
  JOIN named ON named.path = 'post_resource_files/' || missing.object_name
  -- The copy is named for the saved input it was made from: its row id ends
  -- the file name, and its creation is the folder's.
  LEFT JOIN public.generation_input_media AS inputs
    ON inputs.id::text = substring(
         missing.object_name
         FROM '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[^./]+$'
       )
   AND inputs.generation_id::text = split_part(missing.object_name, '/', 3)
  ORDER BY missing.object_name;
END;
$$;

ALTER FUNCTION public.list_swept_recipe_copies_named_again(timestamptz, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_swept_recipe_copies_named_again(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_swept_recipe_copies_named_again(timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.list_swept_recipe_copies_named_again(timestamptz, integer) IS
  'Looks at up to p_limit copies the recipe-copy-sweep job removed since p_deleted_since, least recently looked at first, and hands back those something names again that are not back at their path, each with the saved input row it was copied from (null when gone) and, then, an import of the same copy that survives.';
