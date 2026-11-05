-- A remix's recipe passes on the files that came through the recipe it remixed
-- (remix plan, phase 1b; owner, 2026-11-05: a remix's recipe holds what its run
-- used, and a remix pays the post it remixed in full).
--
-- B remixes A's post through A's recipe: the run start imports the copies A's
-- recipe holds of A's creation's inputs (generation_inputs/<B>/recipe-imports/
-- <A>/<A's creation>/<file>), and B's run keeps each as a kept input marked as a
-- recipe file, recording the copy it stands for (metadata.recipeFile,
-- src/lib/generation-input-media.ts). "Include creation references" used to
-- leave every such input out of B's recipe. Now the server copies those whose
-- copy sits in the folder of the recipe B's run remixed
-- (generations.remix_recipe_bundle_id, 20261105123244) into B's recipe files
-- like any other input, post_resource_files/<B>/generation-references/<B's
-- creation>/<file>, while B may still read them (src/lib/recipe-pass-on.ts).
-- Files of any other recipe never pass on.
--
-- A copy of a creation's input stops being served once that creation is removed
-- or archived, and a buyer's use of a recipe's files ends with their unlock
-- (owner, 2026-11-04; 20261103232019). B's copy of A's file sits under B's
-- creation, so those rules, read from its path, would never reach A's creation
-- or B's unlock. This records where each passed-on copy came from and holds the
-- copy to it:
--
-- 1. public.recipe_copy_sources: one row per passed-on copy, written by the
--    server with the copy, before any byte moves: the copy, the recipe file it
--    stands for, and whose right to that file it rests on (the kept input's
--    holder). It outlives the creation it was copied from, so deleting B's
--    creation, whose post keeps serving its recipe, loses nothing. Deleting the
--    holder's account keeps the row with no holder: purchases and bought
--    versions outlive an account (20260801150000), so its buyers keep the copy,
--    and it is then held to where it came from alone (that file's creation
--    removed or archived, up the chain), never to a purchase no one can read.
-- 2. public.recipe_copy_source_withheld_at(path, depth): whether a copy stands on
--    a recipe file its holder may no longer read: a refund or a retracted
--    purchase of the recipe it came through, that file's creation removed or
--    archived, or, down a chain (C remixed B, who remixed A), the same of the
--    copy that file itself came from. A chain longer than sixty-four copies is
--    no chain the copies make, and closes rather than follows (a copy is
--    recorded only after its source exists, so no real chain loops). With no holder (an
--    account deleted), only that file's creation, and its own source, count.
-- 3. public.recipe_file_readable_by (20261103232019) keeps its signature and its
--    answer for every other file, and now asks the above of a copy: a passed-on
--    copy is read, by its buyers and by its own publisher, only while it
--    stands. Its body moves to recipe_file_readable_at, which carries the depth.
-- 4. public.recipe_copies_withheld(paths): of a batch of copies, those withheld
--    from everyone but their publisher now (their creation removed or archived,
--    or standing on a file closed to their holder), which the server's readers
--    ask in place of reading the creations themselves (src/lib/recipe-copy-access.ts).
--    It reads each creation's marks once and walks only the copies with a record.
--    A copy spelled with a percent sign is withheld: no save writes one, and the
--    file route decodes it (#708's max review).
-- 5. public.remix_terms_for (20261105123244) records the recipe a run remixed
--    whenever its maker holds it, retired or back in draft included: the run
--    imports that recipe's copies, and a remix's recipe holds what its run used
--    (#708's max review; the hub's rule, 2026-11-06). Archiving or removing the
--    original creation still withholds the files. A run whose maker holds the
--    recipe is a paid-recipe remix while that recipe is paid, an earlier free
--    claim included (owner, 2026-11-06: "B's recipe must be paid"); a remix by
--    someone who never held it is unchanged.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─── Where each passed-on copy came from ────────────────────────────────────

CREATE TABLE public.recipe_copy_sources (
  -- The copy: post_resource_files/<publisher>/generation-references/<creation>/<file>.
  copy_path text PRIMARY KEY
    CHECK (copy_path ~ '^post_resource_files/[^/]+/generation-references/[^/]+/[^/]+$'),
  -- The recipe file the copied input stands for: a copy in another publisher's recipe files.
  source_file text NOT NULL
    CHECK (source_file ~ '^post_resource_files/[^/]+/generation-references/[^/]+/[^/]+$'),
  -- The kept input's holder, whose right to source_file the copy rests on; null
  -- once their account is deleted.
  holder_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  -- A copy never stands on a file of its own publisher's.
  CONSTRAINT recipe_copy_sources_other_publisher
    CHECK (split_part(copy_path, '/', 2) <> split_part(source_file, '/', 2))
);

-- Found by its holder when their account is deleted.
CREATE INDEX recipe_copy_sources_holder_idx ON public.recipe_copy_sources (holder_user_id);

ALTER TABLE public.recipe_copy_sources ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.recipe_copy_sources FROM PUBLIC, anon, authenticated;
-- Written once with its copy and never rewritten.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.recipe_copy_sources FROM service_role;
GRANT SELECT, INSERT ON TABLE public.recipe_copy_sources TO service_role;

COMMENT ON TABLE public.recipe_copy_sources IS
  'Where each copy a remix''s recipe passed on came from: the recipe file it stands for and whose right to that file it rests on. Written by the server with the copy (src/lib/recipe-pass-on.ts); read by recipe_copy_source_withheld_at.';

-- ─── Whether a copy stands on a file closed to its holder ───────────────────

-- PL/pgSQL, so the call into recipe_file_readable_at, made below, is resolved
-- when it runs.
CREATE OR REPLACE FUNCTION public.recipe_copy_source_withheld_at(p_path text, p_depth integer)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_source record;
BEGIN
  SELECT sources.source_file, sources.holder_user_id
  INTO v_source
  FROM public.recipe_copy_sources AS sources
  WHERE sources.copy_path = 'post_resource_files/' || regexp_replace(coalesce(p_path, ''), '^post_resource_files/', '');
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF coalesce(p_depth, 0) >= 64 THEN
    RETURN true;
  END IF;
  -- A holder whose account is gone: held to where the file came from alone.
  IF v_source.holder_user_id IS NULL THEN
    RETURN public.recipe_copy_withheld_at(v_source.source_file, coalesce(p_depth, 0) + 1);
  END IF;
  RETURN NOT public.recipe_file_readable_at(v_source.holder_user_id, v_source.source_file, coalesce(p_depth, 0) + 1);
END;
$$;

-- A copy of a creation's input withheld from everyone but its publisher: its
-- creation removed or archived (the two marks creationMayShareRecipe reads; a
-- creation deleted outright keeps its post serving), or standing on a file
-- closed to its holder. False for anything that is no such copy.
CREATE OR REPLACE FUNCTION public.recipe_copy_withheld_at(p_path text, p_depth integer)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  with file as (
    select regexp_replace(coalesce(p_path, ''), '^post_resource_files/', '') as path
  ), parts as (
    select
      path,
      split_part(path, '/', 2) as folder,
      case
        when split_part(path, '/', 3) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then split_part(path, '/', 3)::uuid
      end as creation_id
    from file
  )
  select coalesce((
    select parts.folder = 'generation-references'
      and (
        strpos(parts.path, '%') > 0
        or exists (
          select 1
          from public.generations creation
          where creation.id = parts.creation_id
            and (creation.archived_at is not null or creation.moderation_removed_at is not null)
        )
        or (
          exists (select 1 from public.recipe_copy_sources sources where sources.copy_path = 'post_resource_files/' || parts.path)
          and public.recipe_copy_source_withheld_at(parts.path, p_depth)
        )
      )
    from parts
  ), false);
$$;

-- ─── May this viewer read this recipe file now ──────────────────────────────

-- 20261103232019's recipe_file_readable_by, with the depth, and a copy held to
-- where it came from: its own publisher reads it only while it stands, and
-- anyone else only while it is not withheld (in place of the creation check
-- alone) and their purchase lists it.
CREATE OR REPLACE FUNCTION public.recipe_file_readable_at(p_viewer_user_id uuid, p_path text, p_depth integer)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  with file as (
    select regexp_replace(coalesce(p_path, ''), '^post_resource_files/', '') as path
  ), parts as (
    select
      path,
      split_part(path, '/', 1) as seller,
      jsonb_build_array(jsonb_build_object('storagePath', path)) as bare_item,
      jsonb_build_array(jsonb_build_object('storagePath', 'post_resource_files/' || path)) as prefixed_item
    from file
  )
  select coalesce((
    select p_viewer_user_id is not null
      and parts.seller <> ''
      and (
        (
          parts.seller = p_viewer_user_id::text
          and not (
            exists (select 1 from public.recipe_copy_sources sources where sources.copy_path = 'post_resource_files/' || parts.path)
            and public.recipe_copy_source_withheld_at(parts.path, p_depth)
          )
        )
        or (
          not public.recipe_copy_withheld_at(parts.path, p_depth)
          and exists (
            select 1
            from public.post_resource_bundle_purchases purchase
            where purchase.buyer_user_id = p_viewer_user_id
              and purchase.moderation_retracted_at is null
              and (
                exists (
                  select 1
                  from public.post_resource_bundles bundle
                  where bundle.id = purchase.bundle_id
                    and bundle.owner_user_id::text = parts.seller
                    and (
                      bundle.resource_items @> parts.bare_item
                      or bundle.resource_items @> parts.prefixed_item
                      or bundle.attachments @> parts.bare_item
                      or bundle.attachments @> parts.prefixed_item
                    )
                )
                or exists (
                  select 1
                  from public.post_resource_bundle_revisions revision
                  where revision.id = purchase.revision_id
                    and (
                      revision.resource_items @> parts.bare_item
                      or revision.resource_items @> parts.prefixed_item
                      or revision.attachments @> parts.bare_item
                      or revision.attachments @> parts.prefixed_item
                    )
                )
                or exists (
                  select 1
                  from public.post_resource_bundle_revision_supplements supplement
                  where supplement.revision_id = purchase.revision_id
                    and (
                      supplement.resource_items @> parts.bare_item
                      or supplement.resource_items @> parts.prefixed_item
                    )
                )
              )
          )
        )
      )
    from parts
  ), false);
$$;

-- The same signature and grants as before: the server's batch and the
-- generation_inputs read policy's helper keep asking it.
CREATE OR REPLACE FUNCTION public.recipe_file_readable_by(p_viewer_user_id uuid, p_path text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select public.recipe_file_readable_at(p_viewer_user_id, p_path, 0);
$$;

-- ─── The server's batch ─────────────────────────────────────────────────────

-- Those of the copies withheld from everyone but their publisher now, as given:
-- recipe_copy_withheld_at for each, with each creation's marks read once and the
-- walk asked only of the copies a record stands behind.
CREATE OR REPLACE FUNCTION public.recipe_copies_withheld(p_paths text[])
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  with requested as (
    select distinct
      requested.path as given,
      regexp_replace(coalesce(requested.path, ''), '^post_resource_files/', '') as path
    from unnest(coalesce(p_paths, '{}'::text[])) as requested(path)
  ), parts as (
    select
      given,
      path,
      case
        when split_part(path, '/', 3) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then split_part(path, '/', 3)::uuid
      end as creation_id
    from requested
    where split_part(path, '/', 2) = 'generation-references'
  ), closed_creations as (
    select creation.id
    from public.generations creation
    where creation.id in (select parts.creation_id from parts where parts.creation_id is not null)
      and (creation.archived_at is not null or creation.moderation_removed_at is not null)
  )
  select coalesce(array_agg(parts.given), '{}'::text[])
  from parts
  where strpos(parts.path, '%') > 0
    or parts.creation_id in (select closed_creations.id from closed_creations)
    or (
      exists (select 1 from public.recipe_copy_sources sources where sources.copy_path = 'post_resource_files/' || parts.path)
      and public.recipe_copy_source_withheld_at(parts.path, 0)
    );
$$;

-- ─── The recipe a run remixed, held ─────────────────────────────────────────

-- 20261105123244's remix_terms_for, but for the recipe it records: the one the
-- caller holds of the source's post, retired or back in draft included, before
-- the published one. A holder's run imports that recipe's copies, and its recipe
-- passes them on (src/lib/recipe-pass-on.ts).
CREATE OR REPLACE FUNCTION public.remix_terms_for(p_user_id uuid, p_source_generation_id uuid)
RETURNS TABLE (mode text, bundle_id uuid, origin_generation_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_source record;
  v_bundle_id uuid;
  v_bundle_status text;
  v_bought_paid boolean;
  v_held_bundle_id uuid;
  v_held_paid boolean;
  v_bundle_access text;
BEGIN
  IF p_source_generation_id IS NULL THEN
    RETURN;
  END IF;

  SELECT g.id, g.user_id, g.remix_recipe_mode, g.remix_recipe_bundle_id, g.remix_origin_generation_id
  INTO v_source
  FROM public.generations AS g
  WHERE g.id = p_source_generation_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- The caller's own creation, or one made as a guest since linked to them.
  IF v_source.user_id IN (SELECT public.linked_account_ids(p_user_id)) THEN
    RETURN QUERY SELECT v_source.remix_recipe_mode, v_source.remix_recipe_bundle_id,
      v_source.remix_origin_generation_id;
    RETURN;
  END IF;

  -- The post's recipe as it stands: its live one before a retired one.
  SELECT b.id, b.status, b.access_mode
  INTO v_bundle_id, v_bundle_status, v_bundle_access
  FROM public.posts AS p
  JOIN public.post_resource_bundles AS b ON b.post_id = p.id
  WHERE p.generation_id = v_source.id
  ORDER BY (b.retired_at IS NULL) DESC, b.created_at DESC
  LIMIT 1;
  -- The recipe of this post the caller holds, whatever its state now, and whether it is paid now.
  SELECT b.id, b.access_mode = 'paid'
  INTO v_held_bundle_id, v_held_paid
  FROM public.posts AS p
  JOIN public.post_resource_bundles AS b ON b.post_id = p.id
  JOIN public.post_resource_bundle_purchases AS purchase ON purchase.bundle_id = b.id
  WHERE p.generation_id = v_source.id
    AND purchase.buyer_user_id IN (SELECT public.linked_account_ids(p_user_id))
    AND purchase.moderation_retracted_at IS NULL
  ORDER BY purchase.created_at DESC
  LIMIT 1;
  v_bought_paid := public.remix_source_bought_paid(p_user_id, v_source.id);

  RETURN QUERY SELECT
    CASE
      WHEN v_bought_paid OR v_source.remix_recipe_mode = 'paid' THEN 'paid'
      -- A holder of the recipe, a free claim included, remixes a paid recipe while it is paid.
      WHEN v_held_bundle_id IS NOT NULL
        AND (coalesce(v_held_paid, false) OR (v_bundle_status = 'published' AND v_bundle_access = 'paid')) THEN 'paid'
      ELSE 'free'
    END,
    coalesce(v_held_bundle_id, CASE WHEN v_bundle_status = 'published' OR v_bought_paid THEN v_bundle_id END),
    coalesce(v_source.remix_origin_generation_id, v_source.id);
END;
$$;
REVOKE ALL ON FUNCTION public.remix_terms_for(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remix_terms_for(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.recipe_copy_source_withheld_at(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recipe_copy_withheld_at(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recipe_file_readable_at(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recipe_file_readable_by(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recipe_copies_withheld(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recipe_copy_source_withheld_at(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.recipe_copy_withheld_at(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.recipe_file_readable_at(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.recipe_file_readable_by(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.recipe_copies_withheld(text[]) TO service_role;

COMMIT;
