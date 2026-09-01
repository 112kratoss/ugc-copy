-- The account-deletion content freeze must not block account deletion itself.
--
-- 20260801150000 froze posts and post_resource_bundles while the owner's
-- deletion job exists, so the storage sweep cannot race new content. But
-- ON DELETE SET NULL referential actions are UPDATEs on the referencing
-- table: deleting auth.users cascades into generations, and every deleted
-- generation answers with `UPDATE posts SET generation_id = NULL` on rows
-- owned by the very account being erased. The freeze rejected Postgres's
-- own referential maintenance (SQLSTATE 55000, 'Account deletion is
-- already in progress'), the auth.users delete rolled back, and GoTrue
-- returned 500 -- so any account that had ever published a post from a
-- generation could not be deleted (production, 2026-09-01).
--
-- The two cases are distinguishable the same way the sold-post guards
-- already do it (20260801140000): a cascade from auth.users runs after the
-- parent row is deleted, so the owner lookup fails; an ordinary API write
-- always has a live owner. Erasure wins over the freeze.
--
-- The same cascade can reach two more bundle guards, so they get the same
-- exemption below: protect_sold_post_resource_bundle_content only exempted
-- DELETE (the marketplace_assets link answers erasure with a SET NULL
-- UPDATE on a sold bundle), and validate_post_resource_bundle_write raised
-- 'Attached post not found' when that maintenance UPDATE arrived after the
-- cascade had already removed the post.

CREATE OR REPLACE FUNCTION public.reject_post_write_during_account_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Account erasure in execution: the owner's auth.users row is already
  -- gone when its cascades reach posts, and the SET NULL maintenance
  -- UPDATE must pass or the whole auth deletion rolls back.
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.user_id) THEN
    RETURN NEW;
  END IF;

  -- Moderation must still be able to retract or restore an entitlement while
  -- deletion is pending. User-authored post mutations do not control this
  -- column, so a review-status transition is the narrow safe exemption.
  IF public.is_account_deletion_requested(NEW.user_id) THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Account deletion is already in progress'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF NEW.review_status IS NOT DISTINCT FROM OLD.review_status THEN
      RAISE EXCEPTION 'Account deletion is already in progress'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_post_resource_bundle_write_during_account_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Same erasure exemption as posts: cascades from auth.users (directly, or
  -- through marketplace_assets SET NULL) arrive after the owner is deleted.
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.owner_user_id) THEN
    RETURN NEW;
  END IF;

  IF public.is_account_deletion_requested(NEW.owner_user_id)
    AND NOT EXISTS (
      SELECT 1
      FROM public.posts
      WHERE id = NEW.post_id
        AND review_status = 'hidden'
    ) THEN
    RAISE EXCEPTION 'Account deletion is already in progress'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN NEW;
END;
$$;

-- Reading auth.users inside these guards requires trusted-owner execution;
-- API roles deliberately cannot see auth.users (same treatment as
-- 20260901090000 gave the sold-post guards).
ALTER FUNCTION public.reject_post_write_during_account_deletion()
  OWNER TO postgres;
ALTER FUNCTION public.reject_post_resource_bundle_write_during_account_deletion()
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.reject_post_write_during_account_deletion()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reject_post_resource_bundle_write_during_account_deletion()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.reject_post_write_during_account_deletion() IS
  'Freezes user post writes while a deletion job exists, but lets auth-user cascade maintenance through.';
COMMENT ON FUNCTION public.reject_post_resource_bundle_write_during_account_deletion() IS
  'Freezes user bundle writes while a deletion job exists, but lets auth-user cascade maintenance through.';

-- protect_sold_post_resource_bundle_content already exempted the erasure
-- cascade for DELETE; the marketplace_assets ON DELETE SET NULL answers the
-- same cascade with an UPDATE of legacy_asset_id, which the sold-content
-- branch would have rejected as RESOURCE_BUNDLE_LOCKED. Keep every other
-- rule exactly as 20260806120000 wrote it, and keep the trusted-owner
-- execution 20260901090000 added (CREATE OR REPLACE would otherwise reset
-- SECURITY DEFINER and the pinned search_path).
CREATE OR REPLACE FUNCTION public.protect_sold_post_resource_bundle_content()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_has_purchase boolean;
  v_has_pending_cash_order boolean;
BEGIN
  -- A creator deleting their account cascades after the parent auth row (and,
  -- depending on FK order, the post) is already gone. Erasure must keep the
  -- exemption established by 20260801140000/20260801150000; immutable detached
  -- revisions continue to preserve what buyers purchased. The cascade both
  -- deletes the bundle row and, through marketplace_assets, detaches
  -- legacy_asset_id first -- exempt the maintenance UPDATE as well.
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.owner_user_id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.post_resource_bundle_orders AS orders
      WHERE orders.bundle_id = OLD.id
        AND orders.status = 'created'
        AND orders.amount_subunits > 0
    ) INTO v_has_pending_cash_order;

    IF v_has_pending_cash_order THEN
      RAISE EXCEPTION 'RESOURCE_CHECKOUT_PENDING: pending paid checkouts require this package to be retained'
        USING ERRCODE = 'P0001', HINT = 'RESOURCE_CHECKOUT_PENDING';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.posts WHERE id = OLD.post_id) THEN
      RETURN OLD;
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.bundle_id = OLD.id
      AND purchases.price_usd_cents > 0
  ) INTO v_has_purchase;

  IF NOT v_has_purchase THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RESOURCE_BUNDLE_LOCKED: purchased packages cannot be retired or deleted'
      USING ERRCODE = 'P0001', HINT = 'RESOURCE_BUNDLE_LOCKED';
  END IF;

  IF NEW.post_id IS DISTINCT FROM OLD.post_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.legacy_asset_id IS DISTINCT FROM OLD.legacy_asset_id
    OR public.post_resource_bundle_content_fingerprint(NEW)
       IS DISTINCT FROM public.post_resource_bundle_content_fingerprint(OLD) THEN
    RAISE EXCEPTION 'RESOURCE_BUNDLE_LOCKED: purchased package content cannot be changed'
      USING ERRCODE = 'P0001', HINT = 'RESOURCE_BUNDLE_LOCKED';
  END IF;

  IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'RESOURCE_BUNDLE_LOCKED: purchased packages cannot be retired'
      USING ERRCODE = 'P0001', HINT = 'RESOURCE_BUNDLE_LOCKED';
  END IF;

  -- Clearing a historical retirement marker while restoring the unchanged
  -- package is safe; every other retirement rewrite remains forbidden.
  IF OLD.retired_at IS NOT NULL
    AND NEW.retired_at IS DISTINCT FROM OLD.retired_at
    AND NOT (NEW.retired_at IS NULL AND NEW.status = 'published') THEN
    RAISE EXCEPTION 'RESOURCE_BUNDLE_LOCKED: purchased package retirement is immutable'
      USING ERRCODE = 'P0001', HINT = 'RESOURCE_BUNDLE_LOCKED';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.protect_sold_post_resource_bundle_content()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.protect_sold_post_resource_bundle_content()
  FROM PUBLIC, anon, authenticated, service_role;

-- The bundle write validator dereferences the attached post. A bundle UPDATE
-- with no post row can only be erasure-cascade maintenance (post_id itself is
-- ON DELETE CASCADE, so the state is unreachable otherwise): pass it through
-- instead of raising 'Attached post not found' and rolling the erasure back.
-- Bundle INSERTs without a post remain invalid. Body otherwise unchanged.
CREATE OR REPLACE FUNCTION public.validate_post_resource_bundle_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
BEGIN
  SELECT *
  INTO v_post
  FROM public.posts
  WHERE id = NEW.post_id;

  IF NOT FOUND THEN
    IF TG_OP = 'UPDATE' THEN
      -- Mid-erasure referential maintenance (e.g. marketplace_assets
      -- ON DELETE SET NULL) can reach a bundle whose post the same cascade
      -- already removed. The bundle row itself is about to cascade away.
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Attached post not found';
  END IF;

  IF NEW.owner_user_id <> v_post.user_id THEN
    RAISE EXCEPTION 'Bundle owner must match post owner';
  END IF;

  IF NEW.status = 'published' AND v_post.visibility IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'Only public posts can publish resource bundles';
  END IF;

  IF NEW.access_mode = 'free' AND NEW.price_usd_cents <> 0 THEN
    RAISE EXCEPTION 'Free bundles must have a zero price';
  END IF;

  IF NEW.access_mode = 'paid'
    AND (NEW.price_usd_cents < 10 OR NEW.price_usd_cents % 10 <> 0) THEN
    RAISE EXCEPTION 'Paid bundles must cost at least 10 tokens and use 10-token increments';
  END IF;

  IF jsonb_typeof(coalesce(NEW.resource_sections, '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Resource sections must be an array';
  END IF;

  IF jsonb_typeof(coalesce(NEW.resource_items, '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Resource items must be an array';
  END IF;

  -- This also adds missing stable IDs and global scopes. Media-scope membership is
  -- checked by the API because new-post bundles are persisted before post_media.
  NEW.resource_items := public.normalize_post_resource_items(NEW.resource_items);

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.resource_sections, '[]'::jsonb)) AS section
    WHERE nullif(btrim(coalesce(section->>'id', '')), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Resource sections must include a stable id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.resource_sections, '[]'::jsonb)) AS section
    WHERE coalesce(nullif(btrim(section->>'kind'), ''), 'other') NOT IN (
      'global',
      'scene',
      'shot',
      'frame',
      'variation',
      'workflow_step',
      'asset_group',
      'chapter',
      'other'
    )
  ) THEN
    RAISE EXCEPTION 'Choose a valid resource section kind';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT btrim(section->>'id') AS section_id
      FROM jsonb_array_elements(coalesce(NEW.resource_sections, '[]'::jsonb)) AS section
      GROUP BY btrim(section->>'id')
      HAVING count(*) > 1
    ) duplicates
  ) THEN
    RAISE EXCEPTION 'Resource sections must have unique ids';
  END IF;

  IF EXISTS (
    WITH section_ids AS (
      SELECT btrim(section->>'id') AS section_id
      FROM jsonb_array_elements(coalesce(NEW.resource_sections, '[]'::jsonb)) AS section
      WHERE nullif(btrim(coalesce(section->>'id', '')), '') IS NOT NULL
    )
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.resource_items, '[]'::jsonb)) AS item
    WHERE nullif(btrim(coalesce(item->>'sectionId', '')), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM section_ids
        WHERE section_ids.section_id = btrim(item->>'sectionId')
      )
  ) THEN
    RAISE EXCEPTION 'Resource item sectionId must reference an existing resource section';
  END IF;

  IF nullif(btrim(coalesce(NEW.workflow_share_url, '')), '') IS NOT NULL
    AND NEW.workflow_share_url !~* '^https?://' THEN
    RAISE EXCEPTION 'Workflow links must start with http:// or https://';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.attachments, '[]'::jsonb)) AS attachment
    WHERE coalesce(attachment->>'kind', 'link') = 'link'
      AND nullif(btrim(coalesce(attachment->>'url', '')), '') IS NOT NULL
      AND attachment->>'url' !~* '^https?://'
  ) THEN
    RAISE EXCEPTION 'Unlock links must start with http:// or https://';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.resource_items, '[]'::jsonb)) AS item
    WHERE nullif(btrim(coalesce(item->>'externalUrl', '')), '') IS NOT NULL
      AND item->>'externalUrl' !~* '^https?://'
  ) THEN
    RAISE EXCEPTION 'Resource links must start with http:// or https://';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.attachments, '[]'::jsonb)) AS attachment
    WHERE coalesce(attachment->>'kind', 'link') = 'file'
      AND (
        nullif(btrim(coalesce(attachment->>'storagePath', '')), '') IS NULL
        OR btrim(attachment->>'storagePath') !~ ('^' || NEW.owner_user_id::text || '/')
        OR btrim(attachment->>'storagePath') LIKE '%..%'
        OR btrim(attachment->>'storagePath') ~ '[\\]'
      )
  ) THEN
    RAISE EXCEPTION 'Uploaded unlock files must belong to the creator publishing this post';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.resource_items, '[]'::jsonb)) AS item
    WHERE nullif(btrim(coalesce(item->>'storagePath', '')), '') IS NOT NULL
      AND (
        btrim(item->>'storagePath') !~ ('^' || NEW.owner_user_id::text || '/')
        OR btrim(item->>'storagePath') LIKE '%..%'
        OR btrim(item->>'storagePath') ~ '[\\]'
      )
  ) THEN
    RAISE EXCEPTION 'Uploaded resource files must belong to the creator publishing this post';
  END IF;

  IF nullif(btrim(coalesce(NEW.prompt_text, '')), '') IS NULL
    AND nullif(btrim(coalesce(NEW.notes_markdown, '')), '') IS NULL
    AND nullif(btrim(coalesce(NEW.workflow_share_url, '')), '') IS NULL
    AND NEW.workflow_snapshot IS NULL
    AND jsonb_array_length(coalesce(NEW.attachments, '[]'::jsonb)) = 0
    AND NEW.allow_remix IS NOT TRUE
    AND jsonb_array_length(coalesce(NEW.resource_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Add content for at least one unlock item before publishing';
  END IF;

  RETURN NEW;
END;
$$;
