-- Recipes keep what they sell (recipe audit, 2026-10-27).
--
-- 1. A sold recipe can be corrected (owner decision D1: "i guess its fine to
--    be corrected"). 20260806120000_freeze_sold_post_resource_bundles.sql
--    froze a recipe's content, price, access mode and title after its first
--    paid purchase and refused to retire it, so a typo in a sold prompt or a
--    dead link could never be fixed. The revisions it was layered on
--    (20260801100000) already keep what buyers paid for: every content change
--    mints an immutable revision and each purchase pins the one it bought, so
--    buyers see the latest and keep their own. From here:
--
--    * apply_post_resource_bundle_mutation keeps its row lock -- a save and a
--      sale still serialize on the bundle row -- but no longer refuses a
--      recipe that has been bought.
--    * protect_sold_post_resource_bundle_content keeps a sold recipe on its
--      post and owner (post_id, owner_user_id, legacy_asset_id) and the
--      erasure and pending-checkout rules; it no longer freezes content or
--      retirement.
--    * Removing a recipe that anyone has (a purchase row, paid or free)
--      retires it again instead of deleting it: delisted (draft) with
--      retired_at set, and the buyers keep it. That is the
--      retire-instead-of-delete trigger of 20260801100000 (account-deletion
--      exemption from 20260801140000), which 20260806120000 dropped.
--    * A retired recipe stays retired: the exposure sync no longer promotes it
--      when its post is public again, and saving a recipe on the post again
--      (free or paid) clears the marker. Since content can change after a
--      sale, a sold draft is promoted only if it passes the quality gate, as
--      every other draft already was ("validated when listed, frozen since"
--      no longer holds).
--    * A sold recipe's title follows its post's title like any other
--      (sync_post_resource_bundle_title, 20261026150925).
--
--    Unchanged: ownership checks, revision capture and the purchase-pinned
--    revisions, the rule that a published recipe needs a public post
--    (post_resource_bundles_validate_write), the moderation and
--    account-deletion freezes, the card checkout's immutable quote, and the
--    tombstone path for a post with buyers (reject_sold_post_delete).
--
-- 2. A credits unlock charges the price the buyer confirmed (audit H4).
--    unlock_post_resource_bundle_with_credits takes an optional expected price
--    and, when it is given and differs from the live price read under the
--    bundle's row lock, spends nothing and answers `price_changed` with the
--    live price. Without it the call is the one every earlier client makes.
--
-- 3. A creation post's published recipe includes its Remix (audit H1): the
--    public summaries report allow_remix true for it, whatever is stored, as
--    every TypeScript read does (resolveRecipeAllowRemix). Read-time only;
--    nothing stored changes.

-- ─── 1a. The guarded mutation: lock, no refusal ───────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_post_resource_bundle_mutation(
  p_post_id uuid,
  p_owner_user_id uuid,
  p_post_title text,
  p_post_visibility text,
  p_bundle jsonb
)
RETURNS TABLE(bundle_id uuid, bundle_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_bundle_id uuid;
  v_bundle_id uuid;
  v_bundle_status text;
BEGIN
  -- Purchase completion takes this same row lock before inserting the canonical
  -- purchase. A save and a sale therefore serialize: whichever commits first
  -- decides which revision the buyer pins, and neither is refused.
  SELECT bundles.id
  INTO v_existing_bundle_id
  FROM public.post_resource_bundles AS bundles
  WHERE bundles.post_id = p_post_id
    AND bundles.owner_user_id = p_owner_user_id
  FOR UPDATE;

  -- accessMode 'none' deletes the row in here; for a recipe that anyone has,
  -- post_resource_bundles_retire_instead_of_delete turns that into a retirement.
  SELECT mutation.bundle_id, mutation.bundle_status
  INTO v_bundle_id, v_bundle_status
  FROM public.apply_post_resource_bundle_mutation_unlocked_20260806(
    p_post_id,
    p_owner_user_id,
    p_post_title,
    p_post_visibility,
    p_bundle
  ) AS mutation;

  -- A recipe saved again after it was retired is the post's recipe again. A
  -- save on a public post clears the marker by itself
  -- (post_resource_bundles_clear_retirement); one on a private post keeps the
  -- recipe a draft, and the marker would keep the exposure sync from ever
  -- listing it.
  IF v_bundle_id IS NOT NULL THEN
    UPDATE public.post_resource_bundles AS bundles
    SET retired_at = NULL
    WHERE bundles.id = v_bundle_id
      AND bundles.retired_at IS NOT NULL;
  END IF;

  RETURN QUERY SELECT v_bundle_id, v_bundle_status;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_post_resource_bundle_mutation(
  uuid, uuid, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_post_resource_bundle_mutation(
  uuid, uuid, text, text, jsonb
) TO service_role;

-- ─── 1b. The sold-recipe guard keeps identity, not content ───────────────────
-- As 20260901175000 wrote it, with the trusted-owner execution of
-- 20260901090000, minus the content and retirement freeze.

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
  -- depending on FK order, the post) is already gone. Erasure keeps the
  -- exemption established by 20260801140000/20260801150000 for the delete and
  -- for the marketplace_assets SET NULL maintenance update.
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

    -- A recipe that anyone has is retired rather than deleted by
    -- post_resource_bundles_retire_instead_of_delete, which fires after this.
    RETURN OLD;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.bundle_id = OLD.id
      AND purchases.price_usd_cents > 0
  ) INTO v_has_purchase;

  -- Content, price, access mode, title and retirement may all change: each
  -- content change is a new revision and every purchase keeps its own. What a
  -- sold recipe is attached to may not.
  IF v_has_purchase
    AND (
      NEW.post_id IS DISTINCT FROM OLD.post_id
      OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.legacy_asset_id IS DISTINCT FROM OLD.legacy_asset_id
    ) THEN
    RAISE EXCEPTION 'RESOURCE_BUNDLE_LOCKED: a purchased recipe stays with its post and creator'
      USING ERRCODE = 'P0001', HINT = 'RESOURCE_BUNDLE_LOCKED';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.protect_sold_post_resource_bundle_content()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.protect_sold_post_resource_bundle_content()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.protect_sold_post_resource_bundle_content() IS
  'Trusted trigger guard: a sold recipe stays with its post and creator, and a pending paid checkout keeps it from being deleted. Content may change; revisions keep what buyers bought.';

-- ─── 1c. Removing a recipe that anyone has retires it ────────────────────────
-- The 20260801140000 body, run with trusted-owner privileges like the other
-- delete guards: the API's service_role cannot read auth.users.

CREATE OR REPLACE FUNCTION public.retire_sold_post_resource_bundle_instead_of_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Account erasure, and a cascade from a post already deleted, take the row
  -- with them: there is no post or owner left to retire it for.
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.owner_user_id)
    OR NOT EXISTS (SELECT 1 FROM public.posts WHERE id = OLD.post_id) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.bundle_id = OLD.id
  ) THEN
    UPDATE public.post_resource_bundles
    SET status = 'draft',
        retired_at = coalesce(retired_at, timezone('utc'::text, now())),
        updated_at = timezone('utc'::text, now())
    WHERE id = OLD.id;

    -- Suppress the DELETE. Buyers keep the recipe and their pinned revision.
    RETURN NULL;
  END IF;

  RETURN OLD;
END;
$$;

ALTER FUNCTION public.retire_sold_post_resource_bundle_instead_of_delete()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.retire_sold_post_resource_bundle_instead_of_delete()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.retire_sold_post_resource_bundle_instead_of_delete() IS
  'Trusted trigger: deleting a recipe that anyone has (paid or free) retires it instead -- draft, retired_at set -- so its buyers keep it.';

DROP TRIGGER IF EXISTS post_resource_bundles_retire_instead_of_delete
  ON public.post_resource_bundles;
CREATE TRIGGER post_resource_bundles_retire_instead_of_delete
BEFORE DELETE ON public.post_resource_bundles
FOR EACH ROW
EXECUTE FUNCTION public.retire_sold_post_resource_bundle_instead_of_delete();

-- ─── 1d. A retired recipe stays retired; a sold draft passes the gate ────────
-- The 20260824100000 body with two changes: a retired recipe is never promoted,
-- and a sold draft is promoted only when it passes the quality gate.

CREATE OR REPLACE FUNCTION public.sync_post_resource_bundle_exposure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exposed boolean := NEW.visibility = 'public' AND NEW.archived_at IS NULL;
BEGIN
  IF v_exposed THEN
    -- A retired recipe was removed by its creator; only saving a recipe on the
    -- post again brings it back. Any other draft, sold or not, is listed only
    -- if it passes the gate a publishing write applies: a sold recipe's
    -- content can change now, including while its post was private, where a
    -- save is not graded.
    UPDATE public.post_resource_bundles AS bundles
    SET status = 'published',
        updated_at = timezone('utc'::text, now())
    WHERE bundles.post_id = NEW.id
      AND bundles.owner_user_id = NEW.user_id
      AND bundles.status IS DISTINCT FROM 'published'
      AND bundles.retired_at IS NULL
      AND public.post_resource_bundle_quality_issue_for(bundles.id) IS NULL;
  ELSE
    UPDATE public.post_resource_bundles AS bundles
    SET status = 'draft',
        updated_at = timezone('utc'::text, now())
    WHERE bundles.post_id = NEW.id
      AND bundles.owner_user_id = NEW.user_id
      AND bundles.status IS DISTINCT FROM 'draft';

    UPDATE public.marketplace_assets AS assets
    SET status = 'unlisted',
        updated_at = timezone('utc'::text, now())
    WHERE assets.post_id = NEW.id
      AND assets.seller_user_id = NEW.user_id
      AND assets.status = 'active';
  END IF;

  -- Unchanged: a linked marketplace asset that was unlisted by the post
  -- leaving public comes back only for a sold recipe on a post moderation
  -- still shows.
  IF v_exposed AND coalesce(NEW.review_status, 'visible') = 'visible' THEN
    UPDATE public.marketplace_assets AS assets
    SET status = 'active',
        updated_at = timezone('utc'::text, now())
    WHERE assets.post_id = NEW.id
      AND assets.seller_user_id = NEW.user_id
      AND assets.status = 'unlisted'
      AND EXISTS (
        SELECT 1
        FROM public.post_resource_bundles AS bundles
        JOIN public.post_resource_bundle_purchases AS purchases
          ON purchases.bundle_id = bundles.id
        WHERE bundles.post_id = NEW.id
          AND bundles.owner_user_id = NEW.user_id
          AND purchases.price_usd_cents > 0
      );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_post_resource_bundle_exposure()
  FROM PUBLIC, anon, authenticated;

-- ─── 1e. A sold recipe's title follows its post ──────────────────────────────
-- The 20261026150925 body without the sold check: writing the title mints a
-- revision like any content change, and buyers keep the one they bought.

CREATE OR REPLACE FUNCTION public.sync_post_resource_bundle_title(p_post_id uuid, p_owner_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_bundle_id uuid;
  v_title text;
BEGIN
  -- Purchase completion takes this row lock before it records a sale, so a
  -- sale and a retitle serialize.
  SELECT bundles.id
  INTO v_bundle_id
  FROM public.post_resource_bundles AS bundles
  WHERE bundles.post_id = p_post_id
    AND bundles.owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF v_bundle_id IS NULL THEN
    RETURN;
  END IF;

  SELECT coalesce(nullif(btrim(posts.title), ''), 'Attached unlock')
  INTO v_title
  FROM public.posts AS posts
  WHERE posts.id = p_post_id;

  UPDATE public.post_resource_bundles AS bundles
  SET title = v_title,
      updated_at = timezone('utc'::text, now())
  WHERE bundles.id = v_bundle_id
    AND bundles.title IS DISTINCT FROM v_title;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_post_resource_bundle_title(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 2. A credits unlock charges the confirmed price ─────────────────────────
-- The 20260712123000 body plus the optional expected price. The two-argument
-- function is dropped rather than overloaded: with both present, a call naming
-- only p_user_id and p_post_id would be ambiguous. The new parameter has a
-- default, so that call (every client before 2026-10-27) still resolves.

DROP FUNCTION IF EXISTS public.unlock_post_resource_bundle_with_credits(uuid, uuid);

CREATE FUNCTION public.unlock_post_resource_bundle_with_credits(
  p_user_id uuid,
  p_post_id uuid,
  p_expected_credit_cost integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bundle public.post_resource_bundles%ROWTYPE;
  v_credits integer;
  v_promotional_credits integer;
  v_marketplace_credits integer;
  v_order_id uuid;
  v_order_reference text;
  v_payment_reference text;
BEGIN
  SELECT * INTO v_bundle
  FROM public.post_resource_bundles
  WHERE post_id = p_post_id
  FOR UPDATE;

  IF NOT FOUND OR v_bundle.status <> 'published' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT credits, promotional_credits
  INTO v_credits, v_promotional_credits
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  v_marketplace_credits := greatest(
    0,
    least(v_credits, v_credits - v_promotional_credits)
  );

  IF v_bundle.owner_user_id = p_user_id THEN
    RETURN jsonb_build_object(
      'status', 'owned_by_user',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', v_bundle.price_usd_cents
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.post_resource_bundle_purchases
    WHERE bundle_id = v_bundle.id AND buyer_user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object(
      'status', 'already_owned',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', v_bundle.price_usd_cents
    );
  END IF;

  -- The price the buyer confirmed, compared under the row lock a reprice also
  -- takes: a recipe repriced after the buyer saw it spends nothing, and the
  -- answer carries the live price for them to confirm again. A recipe made
  -- free meanwhile is a price change to 0, answered before "not paid", so the
  -- client can take the free path rather than fail.
  IF p_expected_credit_cost IS NOT NULL
    AND p_expected_credit_cost IS DISTINCT FROM (
      CASE WHEN v_bundle.access_mode = 'paid' AND v_bundle.price_usd_cents > 0
        THEN v_bundle.price_usd_cents ELSE 0 END
    ) THEN
    RETURN jsonb_build_object(
      'status', 'price_changed',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', CASE WHEN v_bundle.access_mode = 'paid' AND v_bundle.price_usd_cents > 0
        THEN v_bundle.price_usd_cents ELSE 0 END
    );
  END IF;

  IF v_bundle.access_mode <> 'paid' OR v_bundle.price_usd_cents <= 0 THEN
    RETURN jsonb_build_object(
      'status', 'not_paid',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', v_bundle.price_usd_cents
    );
  END IF;

  IF v_credits < v_bundle.price_usd_cents
     OR v_marketplace_credits < v_bundle.price_usd_cents THEN
    RETURN jsonb_build_object(
      'status', 'insufficient_credits',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', v_bundle.price_usd_cents
    );
  END IF;

  v_order_reference := 'credits_bundle_' || v_bundle.id::text || '_' || p_user_id::text;
  v_payment_reference := 'credits_unlock_' || v_bundle.id::text || '_' || p_user_id::text;

  INSERT INTO public.post_resource_bundle_orders (
    bundle_id, buyer_user_id, razorpay_order_id, razorpay_payment_id,
    amount_subunits, currency, status
  ) VALUES (
    v_bundle.id, p_user_id, v_order_reference, v_payment_reference,
    v_bundle.price_usd_cents, 'USD', 'paid'
  )
  ON CONFLICT (razorpay_order_id) DO UPDATE
  SET razorpay_payment_id = EXCLUDED.razorpay_payment_id,
      amount_subunits = EXCLUDED.amount_subunits,
      currency = EXCLUDED.currency,
      status = 'paid',
      updated_at = timezone('utc'::text, now())
  RETURNING id INTO v_order_id;

  INSERT INTO public.post_resource_bundle_purchases (
    bundle_id, buyer_user_id, order_id, price_usd_cents, amount_subunits, currency
  ) VALUES (
    v_bundle.id, p_user_id, v_order_id,
    v_bundle.price_usd_cents, v_bundle.price_usd_cents, 'USD'
  );

  UPDATE public.profiles
  SET credits = credits - v_bundle.price_usd_cents
  WHERE id = p_user_id;

  UPDATE public.post_resource_bundles
  SET sales_count = sales_count + 1,
      earnings_usd_cents = earnings_usd_cents + v_bundle.price_usd_cents,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_bundle.id;

  RETURN jsonb_build_object(
    'status', 'completed',
    'remaining_credits', v_credits - v_bundle.price_usd_cents,
    'marketplace_spendable_credits', v_marketplace_credits - v_bundle.price_usd_cents,
    'post_id', v_bundle.post_id,
    'bundle_id', v_bundle.id,
    'owner_user_id', v_bundle.owner_user_id,
    'credit_cost', v_bundle.price_usd_cents
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_post_resource_bundle_with_credits(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_post_resource_bundle_with_credits(uuid, uuid, integer)
  TO service_role;

-- ─── 3. Public summaries: a creation post's recipe includes its Remix ────────
-- The 20261017145444 body; only allow_remix changes. A published recipe on a
-- post made from a creation that is not a template's result reports true, as
-- resolveRecipeAllowRemix does for every TypeScript read.

CREATE OR REPLACE FUNCTION public.get_public_post_resource_bundle_summaries(
  p_post_ids uuid[]
)
RETURNS TABLE(
  id uuid,
  post_id uuid,
  title text,
  access_mode text,
  price_usd_cents integer,
  preview_text text,
  prompt_text text,
  notes_markdown text,
  workflow_share_url text,
  workflow_snapshot jsonb,
  attachments jsonb,
  allow_remix boolean,
  resource_sections jsonb,
  resource_items jsonb,
  sales_count integer,
  free_unlock_count integer,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    CASE WHEN bundles.status = 'published' THEN bundles.id ELSE NULL END AS id,
    bundles.post_id,
    CASE WHEN bundles.status = 'published' THEN bundles.title ELSE NULL END AS title,
    CASE WHEN bundles.status = 'published' THEN bundles.access_mode ELSE NULL END AS access_mode,
    CASE WHEN bundles.status = 'published' THEN bundles.price_usd_cents ELSE NULL END AS price_usd_cents,
    CASE WHEN bundles.status = 'published' THEN bundles.preview_text ELSE NULL END AS preview_text,
    CASE WHEN bundles.status = 'published' THEN bundles.prompt_text ELSE NULL END AS prompt_text,
    CASE WHEN bundles.status = 'published' THEN bundles.notes_markdown ELSE NULL END AS notes_markdown,
    CASE WHEN bundles.status = 'published' THEN bundles.workflow_share_url ELSE NULL END AS workflow_share_url,
    CASE WHEN bundles.status = 'published' THEN bundles.workflow_snapshot ELSE NULL END AS workflow_snapshot,
    CASE WHEN bundles.status = 'published' THEN bundles.attachments ELSE NULL END AS attachments,
    CASE
      WHEN bundles.status = 'published' THEN (
        coalesce(bundles.allow_remix, false)
        OR EXISTS (
          SELECT 1
          FROM public.posts AS posts
          JOIN public.generations AS generations
            ON generations.id = posts.generation_id
          WHERE posts.id = bundles.post_id
            AND generations.template_run_id IS NULL
            AND generations.template_run_step_id IS NULL
        )
      )
      ELSE NULL
    END AS allow_remix,
    CASE WHEN bundles.status = 'published' THEN bundles.resource_sections ELSE NULL END AS resource_sections,
    CASE WHEN bundles.status = 'published' THEN bundles.resource_items ELSE NULL END AS resource_items,
    CASE WHEN bundles.status = 'published' THEN bundles.sales_count ELSE NULL END AS sales_count,
    CASE WHEN bundles.status = 'published' THEN bundles.free_unlock_count ELSE NULL END AS free_unlock_count,
    bundles.status
  FROM public.post_resource_bundles AS bundles
  WHERE bundles.post_id = ANY(coalesce(p_post_ids, ARRAY[]::uuid[]));
$$;

REVOKE ALL ON FUNCTION public.get_public_post_resource_bundle_summaries(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_post_resource_bundle_summaries(uuid[])
  TO service_role;
