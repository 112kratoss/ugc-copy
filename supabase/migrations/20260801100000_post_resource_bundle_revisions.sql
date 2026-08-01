-- Buyers keep what they bought.
--
-- Until now a creator could gut a sold bundle, reprice it, or set it back to
-- "no unlock" -- which deleted the row and cascaded every buyer's entitlement
-- away, with the creator keeping the wallet balance. Three changes close that:
--
--   1. Every published state of a bundle is snapshotted into an immutable
--      revision, and each purchase pins the revision that was live when the
--      buyer paid. Later edits reach buyers as improvements, but the purchased
--      revision stays readable forever.
--   2. A bundle that has been bought can no longer be deleted. Setting it back
--      to "no unlock" retires it instead: delisted, no new sales, buyers
--      unaffected.
--   3. A post that has been bought can no longer be hard-deleted. The owner
--      delete path tombstones it, so the buyer's library keeps the title and
--      cover that give their purchase context.
--
-- All three are enforced by triggers rather than inside the callers, because
-- the callers are many (three purchase RPCs, the mutation RPC, the delete
-- service, ops tooling) and the invariant is one.

-- ---------------------------------------------------------------------------
-- 1. Immutable revisions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.post_resource_bundle_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id uuid NOT NULL REFERENCES public.post_resource_bundles(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  content_fingerprint text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  preview_text text NOT NULL DEFAULT '',
  access_mode text NOT NULL,
  price_usd_cents integer NOT NULL,
  prompt_text text,
  notes_markdown text,
  workflow_share_url text,
  workflow_snapshot jsonb,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  allow_remix boolean NOT NULL DEFAULT false,
  resource_sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  resource_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (bundle_id, revision_number)
);

CREATE INDEX IF NOT EXISTS post_resource_bundle_revisions_bundle_latest_idx
  ON public.post_resource_bundle_revisions (bundle_id, revision_number DESC);

ALTER TABLE public.post_resource_bundle_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "No client access to post_resource_bundle_revisions"
  ON public.post_resource_bundle_revisions;
CREATE POLICY "No client access to post_resource_bundle_revisions"
  ON public.post_resource_bundle_revisions
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.post_resource_bundle_revisions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.post_resource_bundle_revisions TO service_role;

-- A revision is a historical fact. Nothing may rewrite or erase one while the
-- purchase that points at it still exists.
CREATE OR REPLACE FUNCTION public.reject_post_resource_bundle_revision_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Post resource bundle revisions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS post_resource_bundle_revisions_immutable
  ON public.post_resource_bundle_revisions;
CREATE TRIGGER post_resource_bundle_revisions_immutable
BEFORE UPDATE ON public.post_resource_bundle_revisions
FOR EACH ROW
EXECUTE FUNCTION public.reject_post_resource_bundle_revision_rewrite();

-- The fingerprint covers exactly the fields a buyer paid for. Storefront copy
-- (title/summary/preview) is included because a bundle sold as one thing must
-- not be relabelled as another; sales_count and the wallet columns are not,
-- since they change on every sale and would spam revisions.
CREATE OR REPLACE FUNCTION public.post_resource_bundle_content_fingerprint(
  p_bundle public.post_resource_bundles
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT md5(
    jsonb_build_object(
      'title', p_bundle.title,
      'summary', p_bundle.summary,
      'preview_text', p_bundle.preview_text,
      'access_mode', p_bundle.access_mode,
      'price_usd_cents', p_bundle.price_usd_cents,
      'prompt_text', p_bundle.prompt_text,
      'notes_markdown', p_bundle.notes_markdown,
      'workflow_share_url', p_bundle.workflow_share_url,
      'workflow_snapshot', coalesce(p_bundle.workflow_snapshot, 'null'::jsonb),
      'attachments', coalesce(p_bundle.attachments, '[]'::jsonb),
      'allow_remix', p_bundle.allow_remix,
      'resource_sections', coalesce(p_bundle.resource_sections, '[]'::jsonb),
      'resource_items', coalesce(p_bundle.resource_items, '[]'::jsonb)
    )::text
  );
$$;

CREATE OR REPLACE FUNCTION public.capture_post_resource_bundle_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fingerprint text;
  v_latest public.post_resource_bundle_revisions%ROWTYPE;
BEGIN
  v_fingerprint := public.post_resource_bundle_content_fingerprint(NEW);

  SELECT *
  INTO v_latest
  FROM public.post_resource_bundle_revisions
  WHERE bundle_id = NEW.id
  ORDER BY revision_number DESC
  LIMIT 1;

  -- A sale bumps sales_count and the wallet columns without touching content.
  IF FOUND AND v_latest.content_fingerprint = v_fingerprint THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.post_resource_bundle_revisions (
    bundle_id,
    revision_number,
    content_fingerprint,
    title,
    summary,
    preview_text,
    access_mode,
    price_usd_cents,
    prompt_text,
    notes_markdown,
    workflow_share_url,
    workflow_snapshot,
    attachments,
    allow_remix,
    resource_sections,
    resource_items
  )
  VALUES (
    NEW.id,
    coalesce(v_latest.revision_number, 0) + 1,
    v_fingerprint,
    NEW.title,
    NEW.summary,
    NEW.preview_text,
    NEW.access_mode,
    NEW.price_usd_cents,
    NEW.prompt_text,
    NEW.notes_markdown,
    NEW.workflow_share_url,
    NEW.workflow_snapshot,
    coalesce(NEW.attachments, '[]'::jsonb),
    NEW.allow_remix,
    coalesce(NEW.resource_sections, '[]'::jsonb),
    coalesce(NEW.resource_items, '[]'::jsonb)
  )
  ON CONFLICT (bundle_id, revision_number) DO NOTHING;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS post_resource_bundles_capture_revision
  ON public.post_resource_bundles;
CREATE TRIGGER post_resource_bundles_capture_revision
AFTER INSERT OR UPDATE ON public.post_resource_bundles
FOR EACH ROW
EXECUTE FUNCTION public.capture_post_resource_bundle_revision();

-- Backfill: every existing bundle gets revision 1 from its current content, so
-- existing purchases have something real to pin to.
INSERT INTO public.post_resource_bundle_revisions (
  bundle_id,
  revision_number,
  content_fingerprint,
  title,
  summary,
  preview_text,
  access_mode,
  price_usd_cents,
  prompt_text,
  notes_markdown,
  workflow_share_url,
  workflow_snapshot,
  attachments,
  allow_remix,
  resource_sections,
  resource_items,
  created_at
)
SELECT
  bundles.id,
  1,
  public.post_resource_bundle_content_fingerprint(bundles),
  bundles.title,
  bundles.summary,
  bundles.preview_text,
  bundles.access_mode,
  bundles.price_usd_cents,
  bundles.prompt_text,
  bundles.notes_markdown,
  bundles.workflow_share_url,
  bundles.workflow_snapshot,
  coalesce(bundles.attachments, '[]'::jsonb),
  bundles.allow_remix,
  coalesce(bundles.resource_sections, '[]'::jsonb),
  coalesce(bundles.resource_items, '[]'::jsonb),
  bundles.created_at
FROM public.post_resource_bundles AS bundles
ON CONFLICT (bundle_id, revision_number) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Purchases pin the revision they bought
-- ---------------------------------------------------------------------------

ALTER TABLE public.post_resource_bundle_purchases
  ADD COLUMN IF NOT EXISTS revision_id uuid
    REFERENCES public.post_resource_bundle_revisions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS post_resource_bundle_purchases_revision_idx
  ON public.post_resource_bundle_purchases (revision_id)
  WHERE revision_id IS NOT NULL;

-- Pinning happens here rather than in each of the three purchase RPCs (cash,
-- credits, mobile) so a fourth rail cannot forget it.
CREATE OR REPLACE FUNCTION public.pin_post_resource_bundle_purchase_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.revision_id IS NULL THEN
    SELECT id
    INTO NEW.revision_id
    FROM public.post_resource_bundle_revisions
    WHERE bundle_id = NEW.bundle_id
    ORDER BY revision_number DESC
    LIMIT 1;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS post_resource_bundle_purchases_pin_revision
  ON public.post_resource_bundle_purchases;
CREATE TRIGGER post_resource_bundle_purchases_pin_revision
BEFORE INSERT ON public.post_resource_bundle_purchases
FOR EACH ROW
EXECUTE FUNCTION public.pin_post_resource_bundle_purchase_revision();

UPDATE public.post_resource_bundle_purchases AS purchases
SET revision_id = revisions.id
FROM public.post_resource_bundle_revisions AS revisions
WHERE purchases.revision_id IS NULL
  AND revisions.bundle_id = purchases.bundle_id
  AND revisions.revision_number = 1;

-- ---------------------------------------------------------------------------
-- 3. A sold bundle retires; it never deletes
-- ---------------------------------------------------------------------------

ALTER TABLE public.post_resource_bundles
  ADD COLUMN IF NOT EXISTS retired_at timestamptz;

COMMENT ON COLUMN public.post_resource_bundles.retired_at IS
  'Set when a creator removes an unlock that already had buyers. The row and its revisions stay so entitlements keep resolving; status is draft so it can never be sold again until republished.';

CREATE OR REPLACE FUNCTION public.retire_sold_post_resource_bundle_instead_of_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.post_resource_bundle_purchases
    WHERE bundle_id = OLD.id
  ) THEN
    UPDATE public.post_resource_bundles
    SET status = 'draft',
        retired_at = coalesce(retired_at, timezone('utc'::text, now())),
        updated_at = timezone('utc'::text, now())
    WHERE id = OLD.id;

    -- Suppress the DELETE. Buyers keep their pinned revision.
    RETURN NULL;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS post_resource_bundles_retire_instead_of_delete
  ON public.post_resource_bundles;
CREATE TRIGGER post_resource_bundles_retire_instead_of_delete
BEFORE DELETE ON public.post_resource_bundles
FOR EACH ROW
EXECUTE FUNCTION public.retire_sold_post_resource_bundle_instead_of_delete();

-- Republishing clears the retirement marker.
CREATE OR REPLACE FUNCTION public.clear_post_resource_bundle_retirement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'published' THEN
    NEW.retired_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS post_resource_bundles_clear_retirement
  ON public.post_resource_bundles;
CREATE TRIGGER post_resource_bundles_clear_retirement
BEFORE INSERT OR UPDATE ON public.post_resource_bundles
FOR EACH ROW
EXECUTE FUNCTION public.clear_post_resource_bundle_retirement();

-- ---------------------------------------------------------------------------
-- 4. A sold post tombstones; it never hard-deletes
-- ---------------------------------------------------------------------------

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS tombstoned_at timestamptz;

COMMENT ON COLUMN public.posts.tombstoned_at IS
  'Set when an owner deletes a post whose unlock already had buyers. The row survives, private and archived, so the buyer library can still show what the purchase was attached to. Invisible on every public surface.';

CREATE INDEX IF NOT EXISTS posts_tombstoned_idx
  ON public.posts (tombstoned_at)
  WHERE tombstoned_at IS NOT NULL;

-- Without this, deleting the post would cascade into the bundle, and the
-- bundle's own retire trigger would suppress that child delete and leave a
-- dangling reference. Refusing the delete outright forces callers onto the
-- tombstone path, which is the behaviour buyers were promised.
CREATE OR REPLACE FUNCTION public.reject_sold_post_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.post_resource_bundle_purchases AS purchases
    JOIN public.post_resource_bundles AS bundles
      ON bundles.id = purchases.bundle_id
    WHERE bundles.post_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Post % has purchased unlocks and must be tombstoned rather than deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS posts_reject_sold_delete ON public.posts;
CREATE TRIGGER posts_reject_sold_delete
BEFORE DELETE ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.reject_sold_post_delete();

-- ---------------------------------------------------------------------------
-- 5. Backend read projections
-- ---------------------------------------------------------------------------

-- The revision a buyer actually paid for, for the unlock library and the
-- "version you purchased" toggle. Returns nothing unless the caller passes the
-- buyer's own id, so the projection cannot be used to browse other people's
-- entitlements.
CREATE OR REPLACE FUNCTION public.get_purchased_post_resource_bundle_revision(
  p_bundle_id uuid,
  p_buyer_user_id uuid
)
RETURNS TABLE(
  revision_id uuid,
  revision_number integer,
  is_latest boolean,
  content_fingerprint text,
  title text,
  summary text,
  preview_text text,
  access_mode text,
  price_usd_cents integer,
  prompt_text text,
  notes_markdown text,
  workflow_share_url text,
  workflow_snapshot jsonb,
  attachments jsonb,
  allow_remix boolean,
  resource_sections jsonb,
  resource_items jsonb,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    revisions.id,
    revisions.revision_number,
    revisions.revision_number = (
      SELECT max(latest.revision_number)
      FROM public.post_resource_bundle_revisions AS latest
      WHERE latest.bundle_id = p_bundle_id
    ) AS is_latest,
    revisions.content_fingerprint,
    revisions.title,
    revisions.summary,
    revisions.preview_text,
    revisions.access_mode,
    revisions.price_usd_cents,
    revisions.prompt_text,
    revisions.notes_markdown,
    revisions.workflow_share_url,
    revisions.workflow_snapshot,
    revisions.attachments,
    revisions.allow_remix,
    revisions.resource_sections,
    revisions.resource_items,
    revisions.created_at
  FROM public.post_resource_bundle_purchases AS purchases
  JOIN public.post_resource_bundle_revisions AS revisions
    ON revisions.id = purchases.revision_id
  WHERE purchases.bundle_id = p_bundle_id
    AND purchases.buyer_user_id = p_buyer_user_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_purchased_post_resource_bundle_revision(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_purchased_post_resource_bundle_revision(uuid, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.post_resource_bundle_content_fingerprint(public.post_resource_bundles)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_resource_bundle_content_fingerprint(public.post_resource_bundles)
  TO service_role;
