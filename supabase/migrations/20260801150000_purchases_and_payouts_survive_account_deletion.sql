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
  ADD COLUMN IF NOT EXISTS post_title text;

CREATE OR REPLACE FUNCTION public.capture_post_resource_purchase_context()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seller text;
  v_title text;
BEGIN
  SELECT coalesce(nullif(btrim(profiles.display_name), ''), profiles.username),
         coalesce(nullif(btrim(posts.title), ''), nullif(btrim(posts.body), ''))
  INTO v_seller, v_title
  FROM public.post_resource_bundles AS bundles
  LEFT JOIN public.profiles AS profiles ON profiles.id = bundles.owner_user_id
  LEFT JOIN public.posts AS posts ON posts.id = bundles.post_id
  WHERE bundles.id = NEW.bundle_id;

  NEW.seller_display_name := coalesce(NEW.seller_display_name, v_seller);
  NEW.post_title := coalesce(NEW.post_title, left(coalesce(v_title, ''), 200));

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

-- ---------------------------------------------------------------------------
-- 3. The buyer library reads detached purchases
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_viewer_post_resource_unlocks(
  p_buyer_user_id uuid,
  p_limit integer DEFAULT 24,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
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
      purchases.bundle_id,
      purchases.created_at AS purchased_at,
      purchases.price_usd_cents AS purchase_price_usd_cents,
      purchases.revision_id,
      purchases.seller_display_name,
      purchases.post_title AS captured_post_title
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.buyer_user_id = p_buyer_user_id
  )
  SELECT
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
  ORDER BY owned.purchased_at DESC, owned.bundle_id DESC NULLS LAST
  LIMIT greatest(1, least(coalesce(p_limit, 24), 48))
  OFFSET greatest(0, coalesce(p_offset, 0));
$$;

REVOKE ALL ON FUNCTION public.list_viewer_post_resource_unlocks(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_viewer_post_resource_unlocks(uuid, integer, integer)
  TO service_role;

-- The purchased-revision projection must not require a live bundle either.
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
  WHERE purchases.bundle_id IS NOT DISTINCT FROM p_bundle_id
    AND purchases.buyer_user_id = p_buyer_user_id
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
