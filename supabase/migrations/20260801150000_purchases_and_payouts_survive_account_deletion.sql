-- Two things must outlive the account that created them: what a buyer paid for,
-- and a payout the platform still owes.
--
-- Both were cascading away. A creator deleting their account erased their posts,
-- bundles and revisions, taking every buyer's purchase with them -- which
-- contradicts the guarantee the rest of this work makes, that only a moderation
-- take-down retracts access. Separately, an open payout request vanished with
-- the account, leaving no record that money was owed.

-- ---------------------------------------------------------------------------
-- 1. A payout request is a financial record, not user-owned data
-- ---------------------------------------------------------------------------

ALTER TABLE public.creator_payout_requests
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.creator_payout_requests
  DROP CONSTRAINT IF EXISTS creator_payout_requests_user_id_fkey;

ALTER TABLE public.creator_payout_requests
  ADD CONSTRAINT creator_payout_requests_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.creator_payout_requests.user_id IS
  'Null once the creator deletes their account. The request survives so an operator can still reconcile or settle money that was already owed.';

-- Keep the identity needed to settle a detached request. Without this, a
-- payout that outlives its account is unreconcilable in practice.
ALTER TABLE public.creator_payout_requests
  ADD COLUMN IF NOT EXISTS detached_user_id uuid,
  ADD COLUMN IF NOT EXISTS detached_at timestamptz;

CREATE OR REPLACE FUNCTION public.retain_creator_payout_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Fires as the FK nulls user_id during account deletion.
  IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL THEN
    NEW.detached_user_id := OLD.user_id;
    NEW.detached_at := timezone('utc'::text, now());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS creator_payout_requests_retain_identity
  ON public.creator_payout_requests;
CREATE TRIGGER creator_payout_requests_retain_identity
BEFORE UPDATE ON public.creator_payout_requests
FOR EACH ROW
EXECUTE FUNCTION public.retain_creator_payout_identity();

-- The one-open-request-per-creator guard must not treat every detached row as
-- the same creator; partial-index NULLs would collapse them together.
DROP INDEX IF EXISTS public.creator_payout_requests_one_open_per_user_idx;
CREATE UNIQUE INDEX IF NOT EXISTS creator_payout_requests_one_open_per_user_idx
  ON public.creator_payout_requests (user_id)
  WHERE status = 'requested' AND user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. A purchase outlives the creator who sold it
-- ---------------------------------------------------------------------------

-- The revision is the thing a buyer actually paid for: it holds the prompt,
-- notes, workflow, attachments and items as published. Detaching it from the
-- bundle lets it survive the creator's account going away, while the purchase
-- keeps pointing at it (that FK is already ON DELETE RESTRICT).
ALTER TABLE public.post_resource_bundle_revisions
  ALTER COLUMN bundle_id DROP NOT NULL;

ALTER TABLE public.post_resource_bundle_revisions
  DROP CONSTRAINT IF EXISTS post_resource_bundle_revisions_bundle_id_fkey;

ALTER TABLE public.post_resource_bundle_revisions
  ADD CONSTRAINT post_resource_bundle_revisions_bundle_id_fkey
    FOREIGN KEY (bundle_id) REFERENCES public.post_resource_bundles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.post_resource_bundle_revisions.bundle_id IS
  'Null once the bundle is gone (creator account deletion). The revision itself is what a buyer bought and must remain readable.';

-- Carry enough context for the buyer library to render a detached purchase:
-- who sold it and what it was attached to, captured while both still exist.
ALTER TABLE public.post_resource_bundle_purchases
  ADD COLUMN IF NOT EXISTS seller_display_name text,
  ADD COLUMN IF NOT EXISTS post_title text,
  ADD COLUMN IF NOT EXISTS moderation_retracted_at timestamptz;

COMMENT ON COLUMN public.post_resource_bundle_purchases.moderation_retracted_at IS
  'Set while moderation has retracted this entitlement. It survives post and bundle deletion so a taken-down unlock cannot reappear after creator account deletion.';

CREATE OR REPLACE FUNCTION public.capture_post_resource_purchase_context()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seller text;
  v_title text;
  v_review_status text;
BEGIN
  SELECT coalesce(nullif(btrim(profiles.display_name), ''), profiles.username),
         coalesce(nullif(btrim(posts.title), ''), nullif(btrim(posts.body), '')),
         posts.review_status
  INTO v_seller, v_title, v_review_status
  FROM public.post_resource_bundles AS bundles
  LEFT JOIN public.profiles AS profiles ON profiles.id = bundles.owner_user_id
  LEFT JOIN public.posts AS posts ON posts.id = bundles.post_id
  WHERE bundles.id = NEW.bundle_id;

  NEW.seller_display_name := coalesce(NEW.seller_display_name, v_seller);
  NEW.post_title := coalesce(NEW.post_title, left(coalesce(v_title, ''), 200));
  IF v_review_status = 'hidden' THEN
    NEW.moderation_retracted_at := coalesce(
      NEW.moderation_retracted_at,
      timezone('utc'::text, now())
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS post_resource_bundle_purchases_capture_context
  ON public.post_resource_bundle_purchases;
CREATE TRIGGER post_resource_bundle_purchases_capture_context
BEFORE INSERT ON public.post_resource_bundle_purchases
FOR EACH ROW
EXECUTE FUNCTION public.capture_post_resource_purchase_context();

UPDATE public.post_resource_bundle_purchases AS purchases
SET seller_display_name = coalesce(
      purchases.seller_display_name,
      nullif(btrim(profiles.display_name), ''),
      profiles.username
    ),
    post_title = coalesce(
      purchases.post_title,
      left(coalesce(nullif(btrim(posts.title), ''), nullif(btrim(posts.body), ''), ''), 200)
    )
FROM public.post_resource_bundles AS bundles
LEFT JOIN public.profiles AS profiles ON profiles.id = bundles.owner_user_id
LEFT JOIN public.posts AS posts ON posts.id = bundles.post_id
WHERE bundles.id = purchases.bundle_id;

-- Moderation is the only event that retracts an entitlement. Persist the
-- moderation decision on the purchase itself before account deletion can
-- remove the post that previously carried that state.
UPDATE public.post_resource_bundle_purchases AS purchases
SET moderation_retracted_at = coalesce(
  purchases.moderation_retracted_at,
  timezone('utc'::text, now())
)
FROM public.post_resource_bundles AS bundles
JOIN public.posts AS posts ON posts.id = bundles.post_id
WHERE bundles.id = purchases.bundle_id
  AND posts.review_status = 'hidden';

CREATE OR REPLACE FUNCTION public.sync_post_resource_purchase_moderation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.review_status = 'hidden' THEN
      UPDATE public.post_resource_bundle_purchases AS purchases
      SET moderation_retracted_at = coalesce(
        purchases.moderation_retracted_at,
        timezone('utc'::text, now())
      )
      FROM public.post_resource_bundles AS bundles
      WHERE bundles.id = purchases.bundle_id
        AND bundles.post_id = OLD.id;
    END IF;

    RETURN OLD;
  END IF;

  UPDATE public.post_resource_bundle_purchases AS purchases
  SET moderation_retracted_at = CASE
    WHEN NEW.review_status = 'hidden' THEN coalesce(
      purchases.moderation_retracted_at,
      timezone('utc'::text, now())
    )
    ELSE NULL
  END
  FROM public.post_resource_bundles AS bundles
  WHERE bundles.id = purchases.bundle_id
    AND bundles.post_id = NEW.id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_post_resource_purchase_moderation()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS posts_sync_purchase_moderation_update ON public.posts;
CREATE TRIGGER posts_sync_purchase_moderation_update
AFTER UPDATE OF review_status ON public.posts
FOR EACH ROW
WHEN (OLD.review_status IS DISTINCT FROM NEW.review_status)
EXECUTE FUNCTION public.sync_post_resource_purchase_moderation();

DROP TRIGGER IF EXISTS posts_sync_purchase_moderation_delete ON public.posts;
CREATE TRIGGER posts_sync_purchase_moderation_delete
BEFORE DELETE ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.sync_post_resource_purchase_moderation();

-- The purchase itself must not cascade with the bundle any more.
ALTER TABLE public.post_resource_bundle_purchases
  ALTER COLUMN bundle_id DROP NOT NULL;

ALTER TABLE public.post_resource_bundle_purchases
  DROP CONSTRAINT IF EXISTS post_resource_bundle_purchases_bundle_id_fkey;

ALTER TABLE public.post_resource_bundle_purchases
  ADD CONSTRAINT post_resource_bundle_purchases_bundle_id_fkey
    FOREIGN KEY (bundle_id) REFERENCES public.post_resource_bundles(id) ON DELETE SET NULL;

-- Orders are the payment trail; they may go with the bundle, but the purchase
-- must not follow them.
ALTER TABLE public.post_resource_bundle_purchases
  ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE public.post_resource_bundle_purchases
  DROP CONSTRAINT IF EXISTS post_resource_bundle_purchases_order_id_fkey;

ALTER TABLE public.post_resource_bundle_purchases
  ADD CONSTRAINT post_resource_bundle_purchases_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.post_resource_bundle_orders(id) ON DELETE SET NULL;

-- UNIQUE (bundle_id, buyer_user_id) stays exactly as it was. Postgres treats
-- NULLs as distinct, so detached purchases coexist without any special casing,
-- and -- critically -- complete_post_resource_bundle_purchase infers this
-- constraint via ON CONFLICT (bundle_id, buyer_user_id) to make settlement
-- exactly-once. A partial index would not satisfy that inference and would
-- silently break double-charge protection.

-- The buyer library walks only active entitlements and sorts by purchase time.
-- Keep the moderation predicate in the index so hidden purchases do not bloat
-- the hot path, while purchase UUID remains the stable tie-breaker.
CREATE INDEX IF NOT EXISTS post_resource_bundle_purchases_active_buyer_idx
  ON public.post_resource_bundle_purchases (buyer_user_id, created_at DESC, id DESC)
  INCLUDE (bundle_id, revision_id)
  WHERE moderation_retracted_at IS NULL;

CREATE OR REPLACE FUNCTION public.reject_post_resource_bundle_write_during_account_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
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

REVOKE ALL ON FUNCTION public.reject_post_resource_bundle_write_during_account_deletion()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS post_resource_bundles_freeze_for_account_deletion
  ON public.post_resource_bundles;
CREATE TRIGGER post_resource_bundles_freeze_for_account_deletion
BEFORE INSERT OR UPDATE ON public.post_resource_bundles
FOR EACH ROW
EXECUTE FUNCTION public.reject_post_resource_bundle_write_during_account_deletion();

CREATE OR REPLACE FUNCTION public.reject_post_write_during_account_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
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

REVOKE ALL ON FUNCTION public.reject_post_write_during_account_deletion()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS posts_freeze_for_account_deletion ON public.posts;
CREATE TRIGGER posts_freeze_for_account_deletion
BEFORE INSERT OR UPDATE ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.reject_post_write_during_account_deletion();

-- ---------------------------------------------------------------------------
-- 3. Purchased revision file escrow
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.post_resource_bundle_revision_files (
  revision_id uuid NOT NULL
    REFERENCES public.post_resource_bundle_revisions(id) ON DELETE CASCADE,
  source_bucket text NOT NULL,
  source_path text NOT NULL,
  retained_bucket text NOT NULL DEFAULT 'post_resource_files',
  retained_path text NOT NULL,
  copied_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (revision_id, source_bucket, source_path),
  UNIQUE (retained_bucket, retained_path),
  CHECK (btrim(source_bucket) <> ''),
  CHECK (btrim(source_path) <> ''),
  CHECK (btrim(retained_bucket) <> ''),
  CHECK (btrim(retained_path) <> '')
);

COMMENT ON TABLE public.post_resource_bundle_revision_files IS
  'Service-only map from a purchased revision source object to the neutral retained copy used after creator deletion.';

CREATE INDEX IF NOT EXISTS post_resource_bundle_revision_files_revision_idx
  ON public.post_resource_bundle_revision_files (revision_id);

ALTER TABLE public.post_resource_bundle_revision_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "No client access to post_resource_bundle_revision_files"
  ON public.post_resource_bundle_revision_files;
CREATE POLICY "No client access to post_resource_bundle_revision_files"
  ON public.post_resource_bundle_revision_files
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.post_resource_bundle_revision_files
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.post_resource_bundle_revision_files TO service_role;

CREATE TABLE IF NOT EXISTS public.post_resource_bundle_revision_supplements (
  revision_id uuid PRIMARY KEY
    REFERENCES public.post_resource_bundle_revisions(id) ON DELETE CASCADE,
  resource_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  prepared_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CHECK (jsonb_typeof(resource_items) = 'array')
);

COMMENT ON TABLE public.post_resource_bundle_revision_supplements IS
  'Service-only immutable supplement for legacy generation-reference items that were resolved dynamically and were absent from the original purchased revision.';

ALTER TABLE public.post_resource_bundle_revision_supplements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "No client access to post_resource_bundle_revision_supplements"
  ON public.post_resource_bundle_revision_supplements;
CREATE POLICY "No client access to post_resource_bundle_revision_supplements"
  ON public.post_resource_bundle_revision_supplements
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.post_resource_bundle_revision_supplements
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.post_resource_bundle_revision_supplements TO service_role;

CREATE OR REPLACE FUNCTION public.list_creator_purchased_revisions_for_retention(
  p_creator_user_id uuid
)
RETURNS TABLE(
  revision_id uuid,
  bundle_id uuid,
  post_id uuid,
  generation_id uuid,
  allow_remix boolean,
  attachments jsonb,
  resource_items jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT
    revisions.id,
    bundles.id,
    bundles.post_id,
    posts.generation_id,
    revisions.allow_remix,
    revisions.attachments,
    revisions.resource_items
  FROM public.post_resource_bundles AS bundles
  JOIN public.post_resource_bundle_purchases AS purchases
    ON purchases.bundle_id = bundles.id
  JOIN public.post_resource_bundle_revisions AS revisions
    ON revisions.id = purchases.revision_id
  LEFT JOIN public.posts AS posts
    ON posts.id = bundles.post_id
  WHERE bundles.owner_user_id = p_creator_user_id;
$$;

REVOKE ALL ON FUNCTION public.list_creator_purchased_revisions_for_retention(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_creator_purchased_revisions_for_retention(uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 4. The buyer library reads detached purchases
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.list_viewer_post_resource_unlocks(uuid, integer, integer);
CREATE OR REPLACE FUNCTION public.list_viewer_post_resource_unlocks(
  p_buyer_user_id uuid,
  p_limit integer DEFAULT 24,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  purchase_id uuid,
  bundle_id uuid,
  post_id uuid,
  bundle_title text,
  preview_text text,
  access_mode text,
  price_usd_cents integer,
  purchased_at timestamptz,
  purchase_price_usd_cents integer,
  purchased_revision_number integer,
  has_newer_revision boolean,
  bundle_retired boolean,
  post_title text,
  post_body text,
  post_category text,
  post_format text,
  post_showcase_asset_path text,
  post_output_url text,
  post_tombstoned boolean,
  post_visibility text,
  owner_user_id uuid,
  owner_username text,
  owner_display_name text,
  owner_avatar_url text,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH owned AS (
    SELECT
      purchases.id AS purchase_id,
      purchases.bundle_id,
      purchases.created_at AS purchased_at,
      purchases.price_usd_cents AS purchase_price_usd_cents,
      purchases.revision_id,
      purchases.seller_display_name,
      purchases.post_title AS captured_post_title
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.buyer_user_id = p_buyer_user_id
      AND purchases.moderation_retracted_at IS NULL
  )
  SELECT
    owned.purchase_id,
    owned.bundle_id,
    bundles.post_id,
    -- A detached purchase falls back to the revision it pinned, which is the
    -- thing the buyer actually paid for.
    coalesce(bundles.title, revisions.title, 'Unlock'),
    coalesce(bundles.preview_text, revisions.preview_text, ''),
    coalesce(bundles.access_mode, revisions.access_mode),
    coalesce(bundles.price_usd_cents, revisions.price_usd_cents),
    owned.purchased_at,
    owned.purchase_price_usd_cents,
    revisions.revision_number,
    coalesce(
      revisions.revision_number < (
        SELECT max(latest.revision_number)
        FROM public.post_resource_bundle_revisions AS latest
        WHERE latest.bundle_id = owned.bundle_id
      ),
      false
    ) AS has_newer_revision,
    -- A bundle that no longer exists can certainly not be bought again.
    coalesce(bundles.retired_at IS NOT NULL, true) AS bundle_retired,
    coalesce(posts.title, owned.captured_post_title),
    posts.body,
    posts.category,
    posts.post_format,
    posts.showcase_asset_path,
    posts.output_url,
    coalesce(posts.tombstoned_at IS NOT NULL, true) AS post_tombstoned,
    posts.visibility,
    profiles.id,
    profiles.username,
    coalesce(profiles.display_name, owned.seller_display_name),
    profiles.avatar_url,
    count(*) OVER () AS total_count
  FROM owned
  LEFT JOIN public.post_resource_bundles AS bundles
    ON bundles.id = owned.bundle_id
  LEFT JOIN public.post_resource_bundle_revisions AS revisions
    ON revisions.id = owned.revision_id
  LEFT JOIN public.posts AS posts
    ON posts.id = bundles.post_id
  LEFT JOIN public.profiles AS profiles
    ON profiles.id = bundles.owner_user_id
  -- A moderation take-down retracts the unlock for everyone, buyers included.
  WHERE posts.id IS NULL OR posts.review_status = 'visible'
  ORDER BY owned.purchased_at DESC, owned.purchase_id DESC
  LIMIT greatest(1, least(coalesce(p_limit, 24), 48))
  OFFSET greatest(0, coalesce(p_offset, 0));
$$;

REVOKE ALL ON FUNCTION public.list_viewer_post_resource_unlocks(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_viewer_post_resource_unlocks(uuid, integer, integer)
  TO service_role;

-- Purchase UUID is the permanent entitlement identity. This projection is
-- intentionally buyer-scoped and returns no row for a moderated purchase.
CREATE OR REPLACE FUNCTION public.get_viewer_post_resource_unlock(
  p_purchase_id uuid,
  p_buyer_user_id uuid
)
RETURNS TABLE(
  purchase_id uuid,
  bundle_id uuid,
  post_id uuid,
  revision_id uuid,
  purchased_at timestamptz,
  purchase_price_usd_cents integer,
  seller_display_name text,
  captured_post_title text,
  bundle_retired boolean,
  post_tombstoned boolean,
  post_visibility text,
  post_review_status text,
  current_revision_id uuid,
  purchased_revision_number integer,
  current_revision_number integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    purchases.id,
    purchases.bundle_id,
    bundles.post_id,
    purchases.revision_id,
    purchases.created_at,
    purchases.price_usd_cents,
    purchases.seller_display_name,
    purchases.post_title,
    coalesce(bundles.retired_at IS NOT NULL, false),
    coalesce(posts.tombstoned_at IS NOT NULL, false),
    posts.visibility,
    posts.review_status,
    current_revision.id,
    purchased_revision.revision_number,
    current_revision.revision_number
  FROM public.post_resource_bundle_purchases AS purchases
  JOIN public.post_resource_bundle_revisions AS purchased_revision
    ON purchased_revision.id = purchases.revision_id
  LEFT JOIN public.post_resource_bundles AS bundles
    ON bundles.id = purchases.bundle_id
  LEFT JOIN public.posts AS posts
    ON posts.id = bundles.post_id
  LEFT JOIN LATERAL (
    SELECT revisions.id, revisions.revision_number
    FROM public.post_resource_bundle_revisions AS revisions
    WHERE revisions.bundle_id = purchases.bundle_id
    ORDER BY revisions.revision_number DESC
    LIMIT 1
  ) AS current_revision ON true
  WHERE purchases.id = p_purchase_id
    AND purchases.buyer_user_id = p_buyer_user_id
    AND purchases.moderation_retracted_at IS NULL
    AND (posts.id IS NULL OR posts.review_status = 'visible')
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_viewer_post_resource_unlock(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_viewer_post_resource_unlock(uuid, uuid)
  TO service_role;

-- Legacy Showcase callers resolve purchases by a live bundle id. Detached
-- purchases are deliberately excluded because NULL cannot identify one
-- entitlement; buyer-library callers use the purchase-UUID projection above.
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
    coalesce(
      revisions.revision_number = (
        SELECT max(latest.revision_number)
        FROM public.post_resource_bundle_revisions AS latest
        WHERE latest.bundle_id = p_bundle_id
      ),
      true
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
    AND purchases.moderation_retracted_at IS NULL
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_purchased_post_resource_bundle_revision(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_purchased_post_resource_bundle_revision(uuid, uuid)
  TO service_role;

-- The immutability guard blocked every UPDATE, including the FK's own SET NULL
-- when a bundle is deleted -- which made the detach above impossible. Guard the
-- content instead: that is what "immutable" was ever meant to protect. The only
-- permitted change is bundle_id falling to NULL as the bundle goes away.
CREATE OR REPLACE FUNCTION public.reject_post_resource_bundle_revision_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.bundle_id IS NOT NULL
    AND NEW.bundle_id IS NULL
    AND public.post_resource_bundle_revision_content_matches(OLD, NEW) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Post resource bundle revisions are immutable';
END;
$$;

CREATE OR REPLACE FUNCTION public.post_resource_bundle_revision_content_matches(
  p_old public.post_resource_bundle_revisions,
  p_new public.post_resource_bundle_revisions
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_old.id = p_new.id
    AND p_old.revision_number = p_new.revision_number
    AND p_old.content_fingerprint = p_new.content_fingerprint
    AND p_old.title IS NOT DISTINCT FROM p_new.title
    AND p_old.summary IS NOT DISTINCT FROM p_new.summary
    AND p_old.preview_text IS NOT DISTINCT FROM p_new.preview_text
    AND p_old.access_mode IS NOT DISTINCT FROM p_new.access_mode
    AND p_old.price_usd_cents IS NOT DISTINCT FROM p_new.price_usd_cents
    AND p_old.prompt_text IS NOT DISTINCT FROM p_new.prompt_text
    AND p_old.notes_markdown IS NOT DISTINCT FROM p_new.notes_markdown
    AND p_old.workflow_share_url IS NOT DISTINCT FROM p_new.workflow_share_url
    AND p_old.workflow_snapshot IS NOT DISTINCT FROM p_new.workflow_snapshot
    AND p_old.attachments IS NOT DISTINCT FROM p_new.attachments
    AND p_old.allow_remix IS NOT DISTINCT FROM p_new.allow_remix
    AND p_old.resource_sections IS NOT DISTINCT FROM p_new.resource_sections
    AND p_old.resource_items IS NOT DISTINCT FROM p_new.resource_items
    AND p_old.created_at IS NOT DISTINCT FROM p_new.created_at;
$$;

REVOKE ALL ON FUNCTION public.post_resource_bundle_revision_content_matches(
  public.post_resource_bundle_revisions, public.post_resource_bundle_revisions
) FROM PUBLIC, anon, authenticated;

-- Extend the orphan-retention projection from 20260801130000 with neutral
-- escrow objects. Once the final purchase referencing a revision disappears,
-- this function stops returning its retained paths and the normal orphan
-- cleanup can remove them.
CREATE OR REPLACE FUNCTION public.list_referenced_post_resource_storage_paths()
RETURNS TABLE(storage_path text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH purchased_revisions AS (
    SELECT DISTINCT purchases.revision_id
    FROM public.post_resource_bundle_purchases AS purchases
  ),
  revision_paths AS (
    SELECT jsonb_array_elements(
             coalesce(revisions.resource_items, '[]'::jsonb)
             || coalesce(revisions.attachments, '[]'::jsonb)
           )->>'storagePath' AS path
    FROM public.post_resource_bundle_revisions AS revisions
    JOIN purchased_revisions ON purchased_revisions.revision_id = revisions.id
  ),
  supplement_paths AS (
    SELECT jsonb_array_elements(supplements.resource_items)->>'storagePath' AS path
    FROM public.post_resource_bundle_revision_supplements AS supplements
    JOIN purchased_revisions ON purchased_revisions.revision_id = supplements.revision_id
  ),
  retained_paths AS (
    SELECT files.retained_path AS path
    FROM public.post_resource_bundle_revision_files AS files
    JOIN purchased_revisions ON purchased_revisions.revision_id = files.revision_id
    WHERE files.retained_bucket = 'post_resource_files'
  ),
  live_paths AS (
    SELECT jsonb_array_elements(
             coalesce(bundles.resource_items, '[]'::jsonb)
             || coalesce(bundles.attachments, '[]'::jsonb)
           )->>'storagePath' AS path
    FROM public.post_resource_bundles AS bundles
  )
  SELECT DISTINCT path
  FROM (
    SELECT path FROM revision_paths
    UNION ALL
    SELECT path FROM supplement_paths
    UNION ALL
    SELECT path FROM retained_paths
    UNION ALL
    SELECT path FROM live_paths
  ) AS combined
  WHERE path IS NOT NULL AND btrim(path) <> '';
$$;

REVOKE ALL ON FUNCTION public.list_referenced_post_resource_storage_paths()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_referenced_post_resource_storage_paths()
  TO service_role;
