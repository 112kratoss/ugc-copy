-- Freeze the exact package a buyer purchased while still allowing its post to
-- move between private and public. All purchase rails and bundle mutations
-- serialize on the bundle row, so whichever transaction obtains the lock first
-- defines whether the edit happened before or after the sale.

-- Preserve the fully validated resource mutation implementation under an
-- internal name. The public service-role RPC below becomes the single guarded
-- entry point without copying hundreds of lines of normalization logic.
DO $$
BEGIN
  IF to_regprocedure(
    'public.apply_post_resource_bundle_mutation_unlocked_20260806(uuid,uuid,text,text,jsonb)'
  ) IS NULL THEN
    ALTER FUNCTION public.apply_post_resource_bundle_mutation(uuid, uuid, text, text, jsonb)
      RENAME TO apply_post_resource_bundle_mutation_unlocked_20260806;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_post_resource_bundle_mutation_unlocked_20260806(
  uuid, uuid, text, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

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
BEGIN
  -- Purchase completion takes this same row lock before inserting the canonical
  -- purchase. An edit that loses the race therefore observes that purchase and
  -- fails; a checkout that loses buys the newly committed revision instead.
  SELECT bundles.id
  INTO v_existing_bundle_id
  FROM public.post_resource_bundles AS bundles
  WHERE bundles.post_id = p_post_id
    AND bundles.owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF v_existing_bundle_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.post_resource_bundle_purchases AS purchases
      WHERE purchases.bundle_id = v_existing_bundle_id
        AND purchases.price_usd_cents > 0
    ) THEN
    RAISE EXCEPTION 'RESOURCE_BUNDLE_LOCKED: this package has already been purchased'
      USING ERRCODE = 'P0001', HINT = 'RESOURCE_BUNDLE_LOCKED';
  END IF;

  RETURN QUERY
  SELECT mutation.bundle_id, mutation.bundle_status
  FROM public.apply_post_resource_bundle_mutation_unlocked_20260806(
    p_post_id,
    p_owner_user_id,
    p_post_title,
    p_post_visibility,
    p_bundle
  ) AS mutation;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_post_resource_bundle_mutation(
  uuid, uuid, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_post_resource_bundle_mutation(
  uuid, uuid, text, text, jsonb
) TO service_role;

-- Defense in depth for service-role maintenance code that updates the table
-- directly. Status may follow post visibility, sale counters may change, and a
-- previously retired package may be restored. Buyer-visible content, identity,
-- price, access mode, and a new retirement are immutable once purchased.
CREATE OR REPLACE FUNCTION public.protect_sold_post_resource_bundle_content()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_has_purchase boolean;
  v_has_pending_cash_order boolean;
BEGIN
  -- A creator deleting their account cascades after the parent auth row (and,
  -- depending on FK order, the post) is already gone. Erasure must keep the
  -- exemption established by 20260801140000/20260801150000; immutable detached
  -- revisions continue to preserve what buyers purchased.
  IF TG_OP = 'DELETE'
    AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.owner_user_id) THEN
    RETURN OLD;
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

DROP TRIGGER IF EXISTS post_resource_bundles_protect_sold_content
  ON public.post_resource_bundles;
CREATE TRIGGER post_resource_bundles_protect_sold_content
BEFORE UPDATE OR DELETE ON public.post_resource_bundles
FOR EACH ROW
EXECUTE FUNCTION public.protect_sold_post_resource_bundle_content();

-- The old delete trigger silently converted an attempted removal into a draft
-- retirement. That is no longer a valid operation for sold content: callers
-- receive the explicit conflict above instead.
DROP TRIGGER IF EXISTS post_resource_bundles_retire_instead_of_delete
  ON public.post_resource_bundles;

-- A normal post delete must take the same tombstone path while a cash checkout
-- can still be paid. Razorpay Orders do not expire, so hard-deleting after an
-- arbitrary timeout would eventually strand a captured payment. Account
-- deletion remains exempt; the order FK is detached below for reconciliation.
CREATE OR REPLACE FUNCTION public.reject_sold_post_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.post_resource_bundles AS bundles
    WHERE bundles.post_id = OLD.id
      AND (
        EXISTS (
          SELECT 1
          FROM public.post_resource_bundle_purchases AS purchases
          WHERE purchases.bundle_id = bundles.id
        )
        OR EXISTS (
          SELECT 1
          FROM public.post_resource_bundle_orders AS orders
          WHERE orders.bundle_id = bundles.id
            AND orders.status = 'created'
            AND orders.amount_subunits > 0
        )
      )
  ) THEN
    RAISE EXCEPTION 'Post % has retained unlocks or pending paid checkouts and must be tombstoned rather than deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_sold_post_delete()
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.protect_sold_post_resource_bundle_content()
  FROM PUBLIC, anon, authenticated;

-- Frozen content may still be delisted by making its post private/unlisted and
-- restored by making the post public. This trigger covers both manual and
-- generation-backed post mutation RPCs, plus any future service-only writer.
CREATE OR REPLACE FUNCTION public.sync_sold_post_resource_bundle_visibility()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.post_resource_bundles AS bundles
  SET status = CASE WHEN NEW.visibility = 'public' THEN 'published' ELSE 'draft' END,
      retired_at = CASE WHEN NEW.visibility = 'public' THEN NULL ELSE bundles.retired_at END,
      updated_at = timezone('utc'::text, now())
  WHERE bundles.post_id = NEW.id
    AND bundles.owner_user_id = NEW.user_id
    AND EXISTS (
      SELECT 1
      FROM public.post_resource_bundle_purchases AS purchases
      WHERE purchases.bundle_id = bundles.id
        AND purchases.price_usd_cents > 0
    )
    AND (
      bundles.status IS DISTINCT FROM CASE WHEN NEW.visibility = 'public' THEN 'published' ELSE 'draft' END
      OR (NEW.visibility = 'public' AND bundles.retired_at IS NOT NULL)
    );

  IF NEW.visibility = 'public' AND coalesce(NEW.review_status, 'visible') = 'visible' THEN
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

DROP TRIGGER IF EXISTS posts_sync_sold_resource_bundle_visibility ON public.posts;
CREATE TRIGGER posts_sync_sold_resource_bundle_visibility
AFTER UPDATE OF visibility ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.sync_sold_post_resource_bundle_visibility();

REVOKE ALL ON FUNCTION public.sync_sold_post_resource_bundle_visibility()
  FROM PUBLIC, anon, authenticated;

-- Return the current bundle state even when callers intentionally omit a frozen
-- sold payload. This makes private -> public restoration observable to clients.
CREATE OR REPLACE FUNCTION public.upsert_post_with_resource_bundle(
  p_post jsonb,
  p_bundle jsonb DEFAULT NULL,
  p_has_bundle boolean DEFAULT true
)
RETURNS TABLE(post_id uuid, visibility text, bundle_id uuid, bundle_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post_id uuid := nullif(p_post->>'id', '')::uuid;
  v_generation_id uuid := nullif(p_post->>'generation_id', '')::uuid;
  v_user_id uuid := nullif(p_post->>'user_id', '')::uuid;
  v_visibility text := coalesce(nullif(p_post->>'visibility', ''), 'private');
  v_category text := coalesce(nullif(p_post->>'category', ''), 'image');
  v_post_format text := coalesce(nullif(p_post->>'post_format', ''), 'media');
  v_source_kind text := coalesce(nullif(p_post->>'source_kind', ''), 'external');
  v_result_post_id uuid;
  v_result_visibility text;
  v_bundle_id uuid;
  v_bundle_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Post owner is required';
  END IF;

  IF v_post_id IS NULL AND v_generation_id IS NOT NULL THEN
    SELECT id INTO v_post_id
    FROM public.posts
    WHERE generation_id = v_generation_id;
  END IF;

  IF v_post_id IS NULL THEN
    v_post_id := gen_random_uuid();
  END IF;

  INSERT INTO public.posts AS target (
    id, user_id, visibility, category, title, description, prompt, body,
    post_format, source_kind, source_tool, source_tool_slug, generation_id,
    showcase_asset_path, output_url
  )
  VALUES (
    v_post_id, v_user_id, v_visibility, v_category,
    nullif(btrim(p_post->>'title'), ''),
    nullif(btrim(p_post->>'description'), ''),
    nullif(btrim(p_post->>'prompt'), ''),
    nullif(btrim(p_post->>'body'), ''),
    v_post_format, v_source_kind,
    nullif(btrim(p_post->>'source_tool'), ''),
    nullif(btrim(p_post->>'source_tool_slug'), ''),
    v_generation_id,
    nullif(btrim(p_post->>'showcase_asset_path'), ''),
    nullif(btrim(p_post->>'output_url'), '')
  )
  ON CONFLICT (id) DO UPDATE
  SET visibility = EXCLUDED.visibility,
      category = EXCLUDED.category,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      prompt = EXCLUDED.prompt,
      body = EXCLUDED.body,
      post_format = EXCLUDED.post_format,
      source_kind = EXCLUDED.source_kind,
      source_tool = EXCLUDED.source_tool,
      source_tool_slug = EXCLUDED.source_tool_slug,
      generation_id = EXCLUDED.generation_id,
      showcase_asset_path = EXCLUDED.showcase_asset_path,
      output_url = EXCLUDED.output_url,
      updated_at = timezone('utc'::text, now())
  WHERE target.user_id = v_user_id
  RETURNING target.id, target.visibility INTO v_result_post_id, v_result_visibility;

  IF v_result_post_id IS NULL THEN
    RAISE EXCEPTION 'Post not found or not owned by user';
  END IF;

  IF p_has_bundle THEN
    SELECT mutation.bundle_id, mutation.bundle_status
    INTO v_bundle_id, v_bundle_status
    FROM public.apply_post_resource_bundle_mutation(
      v_result_post_id, v_user_id, p_post->>'title', v_result_visibility, p_bundle
    ) AS mutation;
  END IF;

  IF v_result_visibility <> 'public' THEN
    UPDATE public.post_resource_bundles AS bundles
    SET status = 'draft', updated_at = timezone('utc'::text, now())
    WHERE bundles.post_id = v_result_post_id
      AND bundles.owner_user_id = v_user_id
      AND bundles.status = 'published';

    UPDATE public.marketplace_assets AS assets
    SET status = 'unlisted', updated_at = timezone('utc'::text, now())
    WHERE assets.post_id = v_result_post_id
      AND assets.seller_user_id = v_user_id
      AND assets.status = 'active';
  END IF;

  IF v_bundle_id IS NULL THEN
    SELECT bundles.id, bundles.status
    INTO v_bundle_id, v_bundle_status
    FROM public.post_resource_bundles AS bundles
    WHERE bundles.post_id = v_result_post_id
      AND bundles.owner_user_id = v_user_id;
  END IF;

  RETURN QUERY SELECT v_result_post_id, v_result_visibility, v_bundle_id, v_bundle_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_post_with_resource_bundle(
  p_post_id uuid,
  p_owner_user_id uuid,
  p_post_patch jsonb,
  p_has_bundle boolean DEFAULT false,
  p_bundle jsonb DEFAULT NULL
)
RETURNS TABLE(post_id uuid, visibility text, bundle_id uuid, bundle_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_patch jsonb := coalesce(p_post_patch, '{}'::jsonb);
  v_result_post_id uuid;
  v_result_visibility text;
  v_result_title text;
  v_bundle_id uuid;
  v_bundle_status text;
BEGIN
  PERFORM 1
  FROM public.posts
  WHERE id = p_post_id AND user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND OR v_bundle.status <> 'published' THEN
    RAISE EXCEPTION 'Post not found or not owned by user';
  END IF;

  UPDATE public.posts AS target
  SET visibility = CASE WHEN v_patch ? 'visibility' THEN v_patch->>'visibility' ELSE target.visibility END,
      category = CASE WHEN v_patch ? 'category' THEN v_patch->>'category' ELSE target.category END,
      title = CASE WHEN v_patch ? 'title' THEN nullif(btrim(v_patch->>'title'), '') ELSE target.title END,
      description = CASE WHEN v_patch ? 'description' THEN nullif(btrim(v_patch->>'description'), '') ELSE target.description END,
      body = CASE WHEN v_patch ? 'body' THEN nullif(btrim(v_patch->>'body'), '') ELSE target.body END,
      post_format = CASE WHEN v_patch ? 'post_format' THEN v_patch->>'post_format' ELSE target.post_format END,
      source_tool = CASE WHEN v_patch ? 'source_tool' THEN nullif(btrim(v_patch->>'source_tool'), '') ELSE target.source_tool END,
      source_tool_slug = CASE WHEN v_patch ? 'source_tool_slug' THEN nullif(btrim(v_patch->>'source_tool_slug'), '') ELSE target.source_tool_slug END,
      updated_at = timezone('utc'::text, now())
  WHERE target.id = p_post_id AND target.user_id = p_owner_user_id
  RETURNING target.id, target.visibility, target.title
  INTO v_result_post_id, v_result_visibility, v_result_title;

  IF p_has_bundle THEN
    SELECT mutation.bundle_id, mutation.bundle_status
    INTO v_bundle_id, v_bundle_status
    FROM public.apply_post_resource_bundle_mutation(
      v_result_post_id, p_owner_user_id, v_result_title, v_result_visibility, p_bundle
    ) AS mutation;
  END IF;

  IF v_result_visibility <> 'public' THEN
    UPDATE public.post_resource_bundles AS bundles
    SET status = 'draft', updated_at = timezone('utc'::text, now())
    WHERE bundles.post_id = v_result_post_id
      AND bundles.owner_user_id = p_owner_user_id
      AND bundles.status = 'published';

    UPDATE public.marketplace_assets AS assets
    SET status = 'unlisted', updated_at = timezone('utc'::text, now())
    WHERE assets.post_id = v_result_post_id
      AND assets.seller_user_id = p_owner_user_id
      AND assets.status = 'active';
  END IF;

  IF v_bundle_id IS NULL THEN
    SELECT bundles.id, bundles.status
    INTO v_bundle_id, v_bundle_status
    FROM public.post_resource_bundles AS bundles
    WHERE bundles.post_id = v_result_post_id
      AND bundles.owner_user_id = p_owner_user_id;
  END IF;

  RETURN QUERY SELECT v_result_post_id, v_result_visibility, v_bundle_id, v_bundle_status;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)
  TO service_role;

-- Storage objects are prepared first. This RPC then commits post fields, bundle
-- state, and proof-media rows as one PostgreSQL transaction. Any media failure
-- rolls the preceding post/bundle mutation back automatically.
CREATE OR REPLACE FUNCTION public.update_post_with_resource_bundle_and_media(
  p_post_id uuid,
  p_owner_user_id uuid,
  p_post_patch jsonb,
  p_has_bundle boolean DEFAULT false,
  p_bundle jsonb DEFAULT NULL,
  p_media_items jsonb DEFAULT '[]'::jsonb
)
RETURNS TABLE(post_id uuid, visibility text, bundle_id uuid, bundle_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO v_result
  FROM public.update_post_with_resource_bundle(
    p_post_id, p_owner_user_id, p_post_patch, p_has_bundle, p_bundle
  );

  -- A new object must never inherit a removed proof's durable identity. Retained
  -- rows keep both their key and underlying storage/external location.
  IF EXISTS (
    SELECT 1
    FROM public.post_media AS existing
    JOIN jsonb_array_elements(coalesce(p_media_items, '[]'::jsonb)) AS incoming
      ON incoming->>'mediaKey' = existing.media_key
    WHERE existing.post_id = p_post_id
      AND (
        existing.storage_path IS DISTINCT FROM nullif(btrim(coalesce(incoming->>'storagePath', '')), '')
        OR existing.external_url IS DISTINCT FROM nullif(btrim(coalesce(incoming->>'externalUrl', '')), '')
      )
  ) THEN
    RAISE EXCEPTION 'New uploads must use a new post media key';
  END IF;

  PERFORM public.replace_post_media(p_post_id, p_owner_user_id, p_media_items);

  RETURN QUERY
  SELECT v_result.post_id, v_result.visibility, v_result.bundle_id, v_result.bundle_status;
END;
$$;

REVOKE ALL ON FUNCTION public.update_post_with_resource_bundle_and_media(
  uuid, uuid, jsonb, boolean, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_post_with_resource_bundle_and_media(
  uuid, uuid, jsonb, boolean, jsonb, jsonb
) TO service_role;

-- A provider order can live for minutes between checkout creation and payment
-- capture. Preserve the token quote, exact immutable bundle revision, and proof
-- media that were current when the local order was recorded. Completion must
-- settle this quote, never whatever the seller happens to publish later.
ALTER TABLE public.post_resource_bundle_orders
  ADD COLUMN IF NOT EXISTS quoted_price_usd_cents integer,
  ADD COLUMN IF NOT EXISTS quoted_revision_id uuid,
  ADD COLUMN IF NOT EXISTS quoted_content_fingerprint text,
  ADD COLUMN IF NOT EXISTS quoted_media jsonb;

-- Orders are payment records, including while a creator account is being
-- erased. Detach instead of cascading so an already captured provider payment
-- remains identifiable and refundable even though normal creator deletion is
-- forced onto the tombstone path above.
ALTER TABLE public.post_resource_bundle_orders
  ALTER COLUMN bundle_id DROP NOT NULL;
ALTER TABLE public.post_resource_bundle_orders
  DROP CONSTRAINT IF EXISTS post_resource_bundle_orders_bundle_id_fkey;
ALTER TABLE public.post_resource_bundle_orders
  ADD CONSTRAINT post_resource_bundle_orders_bundle_id_fkey
    FOREIGN KEY (bundle_id) REFERENCES public.post_resource_bundles(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.post_resource_bundle_orders'::regclass
      AND conname = 'post_resource_bundle_orders_quoted_revision_id_fkey'
  ) THEN
    ALTER TABLE public.post_resource_bundle_orders
      ADD CONSTRAINT post_resource_bundle_orders_quoted_revision_id_fkey
      FOREIGN KEY (quoted_revision_id)
      REFERENCES public.post_resource_bundle_revisions(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.post_resource_bundle_orders'::regclass
      AND conname = 'post_resource_bundle_orders_quote_complete_check'
  ) THEN
    ALTER TABLE public.post_resource_bundle_orders
      ADD CONSTRAINT post_resource_bundle_orders_quote_complete_check CHECK (
        (
          quoted_price_usd_cents IS NULL
          AND quoted_revision_id IS NULL
          AND quoted_content_fingerprint IS NULL
          AND quoted_media IS NULL
        )
        OR (
          quoted_price_usd_cents IS NOT NULL
          AND quoted_price_usd_cents >= 0
          AND quoted_revision_id IS NOT NULL
          AND nullif(btrim(quoted_content_fingerprint), '') IS NOT NULL
          AND quoted_media IS NOT NULL
          AND jsonb_typeof(quoted_media) = 'array'
        )
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS post_resource_bundle_orders_quoted_revision_idx
  ON public.post_resource_bundle_orders (quoted_revision_id)
  WHERE quoted_revision_id IS NOT NULL;

COMMENT ON COLUMN public.post_resource_bundle_orders.quoted_price_usd_cents IS
  'Token price accepted when this checkout was recorded; authoritative for settlement.';
COMMENT ON COLUMN public.post_resource_bundle_orders.quoted_revision_id IS
  'Immutable resource revision accepted by this checkout and pinned by its purchase.';
COMMENT ON COLUMN public.post_resource_bundle_orders.quoted_content_fingerprint IS
  'Defense-in-depth fingerprint of the quoted immutable revision.';
COMMENT ON COLUMN public.post_resource_bundle_orders.quoted_media IS
  'Order-time proof-media identity copied to the purchase so old revision scopes remain navigable.';

CREATE OR REPLACE FUNCTION public.snapshot_post_resource_proof_media(p_post_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'source_media_id', media.id,
        'media_key', media.media_key,
        'storage_path', media.storage_path,
        'external_url', media.external_url,
        'preview_storage_path', media.preview_storage_path,
        'rendition_storage_path', media.rendition_storage_path,
        'preview_thumbhash', media.preview_thumbhash,
        'media_kind', media.media_kind,
        'content_type', media.content_type,
        'original_name', media.original_name,
        'width', media.width,
        'height', media.height,
        'duration_seconds', media.duration_seconds,
        'sort_order', media.sort_order
      )
      ORDER BY media.sort_order
    ),
    '[]'::jsonb
  )
  FROM public.post_media AS media
  WHERE media.post_id = p_post_id;
$$;

REVOKE ALL ON FUNCTION public.snapshot_post_resource_proof_media(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Historical created orders did not persist the token price or revision that
-- produced their provider amount. Guessing from the current bundle can
-- over-credit a seller after an edit, so leave those rows unquoted and make
-- completion fail closed. Operations can reconcile a captured legacy payment
-- from provider records and populate an exact quote deliberately.

CREATE OR REPLACE FUNCTION public.protect_post_resource_bundle_order_quote()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- During a rolling deploy an older app instance may still attempt the old
    -- two-step cash/free flow. Rejecting its unquoted local order prevents the
    -- caller from exposing a checkout or reporting a false free entitlement.
    IF NEW.status = 'created' AND NEW.quoted_revision_id IS NULL THEN
      RAISE EXCEPTION 'Created post resource orders require an immutable quote';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.quoted_revision_id IS NOT NULL
    AND (
      NEW.quoted_price_usd_cents IS DISTINCT FROM OLD.quoted_price_usd_cents
      OR NEW.quoted_revision_id IS DISTINCT FROM OLD.quoted_revision_id
      OR NEW.quoted_content_fingerprint IS DISTINCT FROM OLD.quoted_content_fingerprint
      OR NEW.quoted_media IS DISTINCT FROM OLD.quoted_media
    ) THEN
    RAISE EXCEPTION 'Post resource bundle order quotes are immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS post_resource_bundle_orders_protect_quote
  ON public.post_resource_bundle_orders;
CREATE TRIGGER post_resource_bundle_orders_protect_quote
BEFORE INSERT OR UPDATE ON public.post_resource_bundle_orders
FOR EACH ROW
EXECUTE FUNCTION public.protect_post_resource_bundle_order_quote();

REVOKE ALL ON FUNCTION public.protect_post_resource_bundle_order_quote()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_post_resource_bundle_cash_quote(
  p_post_id uuid,
  p_buyer_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bundle public.post_resource_bundles%ROWTYPE;
  v_revision public.post_resource_bundle_revisions%ROWTYPE;
BEGIN
  IF p_post_id IS NULL OR p_buyer_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_bundle
  FROM public.post_resource_bundles
  WHERE post_id = p_post_id
  FOR UPDATE;

  IF NOT FOUND OR v_bundle.status <> 'published' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_bundle.owner_user_id = p_buyer_user_id THEN
    RETURN jsonb_build_object('status', 'owned_by_user');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.bundle_id = v_bundle.id
      AND purchases.buyer_user_id = p_buyer_user_id
  ) THEN
    RETURN jsonb_build_object('status', 'already_owned');
  END IF;

  IF v_bundle.access_mode = 'free' OR v_bundle.price_usd_cents = 0 THEN
    RETURN jsonb_build_object('status', 'free');
  END IF;

  IF v_bundle.access_mode <> 'paid' OR v_bundle.price_usd_cents < 100 THEN
    RETURN jsonb_build_object(
      'status', 'credits_only',
      'price_usd_cents', v_bundle.price_usd_cents
    );
  END IF;

  SELECT * INTO v_revision
  FROM public.post_resource_bundle_revisions
  WHERE bundle_id = v_bundle.id
  ORDER BY revision_number DESC
  LIMIT 1;

  IF NOT FOUND
    OR v_revision.content_fingerprint
       IS DISTINCT FROM public.post_resource_bundle_content_fingerprint(v_bundle) THEN
    RETURN jsonb_build_object('status', 'quote_unavailable');
  END IF;

  RETURN jsonb_build_object(
    'status', 'quoted',
    'bundle_id', v_bundle.id,
    'post_id', v_bundle.post_id,
    'owner_user_id', v_bundle.owner_user_id,
    'title', v_bundle.title,
    'price_usd_cents', v_bundle.price_usd_cents,
    'revision_id', v_revision.id,
    'content_fingerprint', v_revision.content_fingerprint
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_post_resource_bundle_cash_quote(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_post_resource_bundle_cash_quote(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_post_resource_bundle_cash_order(
  p_post_id uuid,
  p_bundle_id uuid,
  p_buyer_user_id uuid,
  p_razorpay_order_id text,
  p_amount_subunits integer,
  p_currency text,
  p_expected_price_usd_cents integer,
  p_expected_revision_id uuid,
  p_expected_content_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bundle public.post_resource_bundles%ROWTYPE;
  v_revision public.post_resource_bundle_revisions%ROWTYPE;
  v_existing public.post_resource_bundle_orders%ROWTYPE;
  v_order_id uuid;
  v_quoted_media jsonb;
BEGIN
  IF p_post_id IS NULL
    OR p_bundle_id IS NULL
    OR p_buyer_user_id IS NULL
    OR nullif(btrim(coalesce(p_razorpay_order_id, '')), '') IS NULL
    OR p_amount_subunits IS NULL
    OR p_amount_subunits <= 0
    OR p_currency IS NULL
    OR p_currency NOT IN ('INR', 'USD')
    OR p_expected_price_usd_cents IS NULL
    OR p_expected_price_usd_cents < 100
    OR p_expected_revision_id IS NULL
    OR nullif(btrim(coalesce(p_expected_content_fingerprint, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_bundle
  FROM public.post_resource_bundles
  WHERE id = p_bundle_id AND post_id = p_post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_bundle.owner_user_id = p_buyer_user_id THEN
    RETURN jsonb_build_object('status', 'owned_by_user');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.bundle_id = v_bundle.id
      AND purchases.buyer_user_id = p_buyer_user_id
  ) THEN
    RETURN jsonb_build_object('status', 'already_owned');
  END IF;

  -- An exact retry of an order that was already frozen stays a replay even if
  -- the seller edited or delisted the live bundle after the first response was
  -- lost. Terminal orders and any identity mismatch are never reusable.
  SELECT * INTO v_existing
  FROM public.post_resource_bundle_orders
  WHERE razorpay_order_id = btrim(p_razorpay_order_id)
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.bundle_id = v_bundle.id
      AND v_existing.buyer_user_id = p_buyer_user_id
      AND v_existing.status = 'created'
      AND v_existing.amount_subunits = p_amount_subunits
      AND v_existing.currency = p_currency
      AND v_existing.quoted_price_usd_cents = p_expected_price_usd_cents
      AND v_existing.quoted_revision_id = p_expected_revision_id
      AND v_existing.quoted_content_fingerprint = btrim(p_expected_content_fingerprint) THEN
      RETURN jsonb_build_object('status', 'replay', 'order_id', v_existing.id);
    END IF;

    RETURN jsonb_build_object('status', 'order_conflict');
  END IF;

  IF v_bundle.status <> 'published' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO v_revision
  FROM public.post_resource_bundle_revisions
  WHERE bundle_id = v_bundle.id
  ORDER BY revision_number DESC
  LIMIT 1;

  IF v_bundle.access_mode <> 'paid'
    OR v_bundle.price_usd_cents IS DISTINCT FROM p_expected_price_usd_cents
    OR v_revision.id IS DISTINCT FROM p_expected_revision_id
    OR v_revision.content_fingerprint IS DISTINCT FROM btrim(p_expected_content_fingerprint)
    OR public.post_resource_bundle_content_fingerprint(v_bundle)
       IS DISTINCT FROM btrim(p_expected_content_fingerprint) THEN
    RETURN jsonb_build_object('status', 'quote_changed');
  END IF;

  v_quoted_media := public.snapshot_post_resource_proof_media(v_bundle.post_id);

  INSERT INTO public.post_resource_bundle_orders (
    bundle_id,
    buyer_user_id,
    razorpay_order_id,
    amount_subunits,
    currency,
    status,
    quoted_price_usd_cents,
    quoted_revision_id,
    quoted_content_fingerprint,
    quoted_media
  ) VALUES (
    v_bundle.id,
    p_buyer_user_id,
    btrim(p_razorpay_order_id),
    p_amount_subunits,
    p_currency,
    'created',
    p_expected_price_usd_cents,
    p_expected_revision_id,
    btrim(p_expected_content_fingerprint),
    v_quoted_media
  )
  ON CONFLICT (razorpay_order_id) DO NOTHING
  RETURNING id INTO v_order_id;

  IF v_order_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'created', 'order_id', v_order_id);
  END IF;

  SELECT * INTO v_existing
  FROM public.post_resource_bundle_orders
  WHERE razorpay_order_id = btrim(p_razorpay_order_id)
  FOR UPDATE;

  IF FOUND
    AND v_existing.bundle_id = v_bundle.id
    AND v_existing.buyer_user_id = p_buyer_user_id
    AND v_existing.status = 'created'
    AND v_existing.amount_subunits = p_amount_subunits
    AND v_existing.currency = p_currency
    AND v_existing.quoted_price_usd_cents = p_expected_price_usd_cents
    AND v_existing.quoted_revision_id = p_expected_revision_id
    AND v_existing.quoted_content_fingerprint = btrim(p_expected_content_fingerprint) THEN
    RETURN jsonb_build_object('status', 'replay', 'order_id', v_existing.id);
  END IF;

  RETURN jsonb_build_object('status', 'order_conflict');
END;
$$;

REVOKE ALL ON FUNCTION public.record_post_resource_bundle_cash_order(
  uuid, uuid, uuid, text, integer, text, integer, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_post_resource_bundle_cash_order(
  uuid, uuid, uuid, text, integer, text, integer, uuid, text
) TO service_role;

-- Free acquisition is one locked transaction. A seller racing this call either
-- changes the bundle first (and this returns not_free) or changes it afterwards,
-- while the buyer remains pinned to the exact free revision they opened.
CREATE OR REPLACE FUNCTION public.unlock_free_post_resource_bundle(
  p_buyer_user_id uuid,
  p_post_id uuid,
  p_order_reference text,
  p_payment_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bundle public.post_resource_bundles%ROWTYPE;
  v_revision public.post_resource_bundle_revisions%ROWTYPE;
  v_order_id uuid;
  v_purchase_id uuid;
  v_quoted_media jsonb;
BEGIN
  IF p_buyer_user_id IS NULL
    OR p_post_id IS NULL
    OR nullif(btrim(coalesce(p_order_reference, '')), '') IS NULL
    OR nullif(btrim(coalesce(p_payment_reference, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_bundle
  FROM public.post_resource_bundles
  WHERE post_id = p_post_id
  FOR UPDATE;

  IF NOT FOUND OR v_bundle.status <> 'published' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_bundle.owner_user_id = p_buyer_user_id THEN
    RETURN jsonb_build_object(
      'status', 'owned_by_user',
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id
    );
  END IF;

  IF v_bundle.access_mode <> 'free' OR v_bundle.price_usd_cents <> 0 THEN
    RETURN jsonb_build_object('status', 'not_free');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.bundle_id = v_bundle.id
      AND purchases.buyer_user_id = p_buyer_user_id
  ) THEN
    RETURN jsonb_build_object(
      'status', 'already_owned',
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id
    );
  END IF;

  SELECT * INTO v_revision
  FROM public.post_resource_bundle_revisions
  WHERE bundle_id = v_bundle.id
  ORDER BY revision_number DESC
  LIMIT 1;

  IF NOT FOUND
    OR v_revision.content_fingerprint
       IS DISTINCT FROM public.post_resource_bundle_content_fingerprint(v_bundle) THEN
    RETURN jsonb_build_object('status', 'quote_unavailable');
  END IF;

  v_quoted_media := public.snapshot_post_resource_proof_media(v_bundle.post_id);

  INSERT INTO public.post_resource_bundle_orders (
    bundle_id,
    buyer_user_id,
    razorpay_order_id,
    razorpay_payment_id,
    amount_subunits,
    currency,
    status,
    quoted_price_usd_cents,
    quoted_revision_id,
    quoted_content_fingerprint,
    quoted_media
  ) VALUES (
    v_bundle.id,
    p_buyer_user_id,
    btrim(p_order_reference),
    btrim(p_payment_reference),
    0,
    'USD',
    'paid',
    0,
    v_revision.id,
    v_revision.content_fingerprint,
    v_quoted_media
  )
  ON CONFLICT (razorpay_order_id) DO NOTHING
  RETURNING id INTO v_order_id;

  IF v_order_id IS NULL THEN
    RETURN jsonb_build_object('status', 'order_conflict');
  END IF;

  INSERT INTO public.post_resource_bundle_purchases (
    bundle_id,
    buyer_user_id,
    order_id,
    revision_id,
    price_usd_cents,
    amount_subunits,
    currency
  ) VALUES (
    v_bundle.id,
    p_buyer_user_id,
    v_order_id,
    v_revision.id,
    0,
    0,
    'USD'
  )
  ON CONFLICT (bundle_id, buyer_user_id) DO NOTHING
  RETURNING id INTO v_purchase_id;

  IF v_purchase_id IS NULL THEN
    DELETE FROM public.post_resource_bundle_orders WHERE id = v_order_id;
    RETURN jsonb_build_object(
      'status', 'already_owned',
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id
    );
  END IF;

  UPDATE public.post_resource_bundles
  SET sales_count = sales_count + 1,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_bundle.id;

  RETURN jsonb_build_object(
    'status', 'completed',
    'bundle_id', v_bundle.id,
    'owner_user_id', v_bundle.owner_user_id,
    'purchase_id', v_purchase_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_free_post_resource_bundle(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_free_post_resource_bundle(uuid, uuid, text, text)
  TO service_role;

-- Completion locks the same bundle row as edits, but settlement comes from the
-- order quote rather than the mutable live row. A paid checkout therefore pins
-- and credits exactly what the buyer accepted even if a still-unsold listing was
-- edited after the provider order was opened.
CREATE OR REPLACE FUNCTION public.complete_post_resource_bundle_purchase(
  p_razorpay_order_id text,
  p_razorpay_payment_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.post_resource_bundle_orders%ROWTYPE;
  v_bundle public.post_resource_bundles%ROWTYPE;
  v_revision public.post_resource_bundle_revisions%ROWTYPE;
  v_purchase_id uuid;
BEGIN
  IF nullif(btrim(p_razorpay_order_id), '') IS NULL
    OR nullif(btrim(p_razorpay_payment_id), '') IS NULL THEN
    RETURN false;
  END IF;

  -- Read the bundle identity first without retaining an order lock, then acquire
  -- locks in the same bundle -> order order used by quote recording and bundle
  -- deletion. Re-read the order under lock before changing anything.
  SELECT * INTO v_order
  FROM public.post_resource_bundle_orders
  WHERE razorpay_order_id = btrim(p_razorpay_order_id);

  IF NOT FOUND OR v_order.status <> 'created' THEN
    RETURN false;
  END IF;

  SELECT * INTO v_bundle
  FROM public.post_resource_bundles
  WHERE id = v_order.bundle_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT * INTO v_order
  FROM public.post_resource_bundle_orders AS orders
  WHERE orders.id = v_order.id
  FOR UPDATE;

  IF NOT FOUND OR v_order.status <> 'created' THEN
    RETURN false;
  END IF;

  -- Rows that could not be backfilled during rollout are unsafe to guess. Leave
  -- them unfulfilled for reconciliation rather than settling the current bundle.
  IF v_order.quoted_price_usd_cents IS NULL
    OR v_order.quoted_revision_id IS NULL
    OR nullif(btrim(coalesce(v_order.quoted_content_fingerprint, '')), '') IS NULL
    OR v_order.quoted_media IS NULL THEN
    RETURN false;
  END IF;

  SELECT * INTO v_revision
  FROM public.post_resource_bundle_revisions
  WHERE id = v_order.quoted_revision_id
    AND bundle_id = v_order.bundle_id;

  IF NOT FOUND
    OR v_revision.content_fingerprint IS DISTINCT FROM v_order.quoted_content_fingerprint
    OR v_revision.price_usd_cents IS DISTINCT FROM v_order.quoted_price_usd_cents THEN
    RETURN false;
  END IF;

  UPDATE public.post_resource_bundle_orders
  SET status = 'paid',
      razorpay_payment_id = btrim(p_razorpay_payment_id),
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.id AND status = 'created';

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.post_resource_bundle_purchases (
    bundle_id, buyer_user_id, order_id, revision_id,
    price_usd_cents, amount_subunits, currency
  )
  VALUES (
    v_order.bundle_id, v_order.buyer_user_id, v_order.id,
    v_order.quoted_revision_id, v_order.quoted_price_usd_cents,
    v_order.amount_subunits, v_order.currency
  )
  ON CONFLICT (bundle_id, buyer_user_id) DO NOTHING
  RETURNING id INTO v_purchase_id;

  IF v_purchase_id IS NULL THEN
    UPDATE public.post_resource_bundle_orders
    SET status = 'failed', updated_at = timezone('utc'::text, now())
    WHERE id = v_order.id AND status = 'paid';
    RETURN false;
  END IF;

  UPDATE public.post_resource_bundles
  SET sales_count = sales_count + 1,
      earnings_usd_cents = earnings_usd_cents + v_order.quoted_price_usd_cents,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.bundle_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_post_resource_bundle_purchase(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_post_resource_bundle_purchase(text, text)
  TO service_role;
