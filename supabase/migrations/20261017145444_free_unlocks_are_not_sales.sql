-- Free unlocks are not sales (product decision 6, 2026-10-17).
--
-- A free recipe's unlock added to post_resource_bundles.sales_count exactly as
-- a paid one did, so a creator's "N sold" counted people who paid nothing
-- (production on 2026-10-17: 22 counted, 20 of them free unlocks). From here:
--
-- * sales_count counts paid unlocks only. The paid rails (credits, web cash,
--   store purchases) and the refunds that take one back are unchanged.
-- * free_unlock_count counts free unlocks: unlock_free_post_resource_bundle
--   bumps it in place of sales_count, and nothing else writes it.
-- * Every function that hands sales_count to the app's reads hands
--   free_unlock_count beside it.
--
-- No rule that decides money, freezing or listing reads either counter. The
-- sold-content freeze, the exposure sync, the quality gate and the delete guard
-- ask whether a purchase with a price (or any purchase) exists, and the
-- account-deletion freeze lets through only a refund's one-step sales_count
-- decrement, which a free unlock never was. "Best selling" keeps ordering on
-- sales_count, which now means paid sales, and earnings are untouched.

ALTER TABLE public.post_resource_bundles
  ADD COLUMN IF NOT EXISTS free_unlock_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.post_resource_bundles
  DROP CONSTRAINT IF EXISTS post_resource_bundles_free_unlock_count_check;
ALTER TABLE public.post_resource_bundles
  ADD CONSTRAINT post_resource_bundles_free_unlock_count_check
    CHECK (free_unlock_count >= 0);

-- The table's only grant is service_role's table-wide one
-- (20260801090000_close_post_resource_bundle_client_writes.sql), which covers
-- the new column; anon and authenticated read and write it through nothing.
COMMENT ON COLUMN public.post_resource_bundles.sales_count IS
  'Paid unlocks (credits, web cash, store purchases), less refunds. Free unlocks are counted in free_unlock_count since 2026-10-17.';
COMMENT ON COLUMN public.post_resource_bundles.free_unlock_count IS
  'Free unlocks, bumped only by unlock_free_post_resource_bundle. Public social proof; no money, freeze or listing rule reads it.';

-- ─── A free unlock is counted apart ──────────────────────────────────────────
-- The body of 20260806120000_freeze_sold_post_resource_bundles.sql, but for the
-- counter it bumps.

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

  -- A free unlock is not a sale: it is counted apart from sales_count.
  UPDATE public.post_resource_bundles
  SET free_unlock_count = free_unlock_count + 1,
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

-- ─── Counts already made: free purchases move out of sales_count ─────────────
--
-- A free unlock is a purchase that cost its buyer nothing (price_usd_cents = 0),
-- the line the freeze and the exposure sync draw between sold and not. It is
-- read off each purchase, never off the bundle's access mode today, so a recipe
-- that went from free to paid, or back, splits by what each buyer paid. That
-- also takes in the April 2026 import of legacy marketplace unlocks, whose order
-- references predate the free_bundle_ prefix but whose free unlocks the legacy
-- asset had already counted into sales_count. A refunded paid unlock left no
-- purchase and was taken off sales_count by its refund, so it plays no part.
--
-- Only what can be accounted for moves:
-- * the free purchases not yet counted in free_unlock_count, so a second run
--   moves nothing;
-- * at most what sales_count holds beyond the bundle's paid purchases, so the
--   paid count is never cut into and neither counter goes below zero.
-- An unlock whose buyer has since deleted their account left no purchase; its
-- count cannot be told free from paid and stays in sales_count.
--
-- It ends with the check the plan asks for: no bundle may count fewer sales than
-- it has paid purchases. One that does fails the migration and rolls the split
-- back with it, because that bundle's "N sold" would be wrong either way.
CREATE OR REPLACE FUNCTION public.split_post_resource_bundle_free_unlocks()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_moved_bundles integer;
  v_short_bundles integer;
BEGIN
  WITH free_purchases AS (
    SELECT purchases.bundle_id, count(*)::integer AS free_count
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.bundle_id IS NOT NULL
      AND purchases.price_usd_cents = 0
    GROUP BY purchases.bundle_id
  ), paid_purchases AS (
    SELECT purchases.bundle_id, count(*)::integer AS paid_count
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.bundle_id IS NOT NULL
      AND purchases.price_usd_cents > 0
    GROUP BY purchases.bundle_id
  ), moves AS (
    SELECT
      bundles.id,
      CASE
        -- A free recipe takes no paid unlock, and its paid purchases from a
        -- time it was paid are kept (a refund takes its count off with it). So
        -- every count beyond those purchases is a free unlock, the ones whose
        -- purchase row is gone included (production on 2026-10-17: three such
        -- counts on three free recipes, which a count of free purchases alone
        -- would have left as sales).
        WHEN bundles.access_mode = 'free' AND bundles.price_usd_cents = 0 THEN
          greatest(bundles.sales_count - coalesce(paid_purchases.paid_count, 0), 0)
        ELSE least(
          greatest(coalesce(free_purchases.free_count, 0) - bundles.free_unlock_count, 0),
          greatest(bundles.sales_count - coalesce(paid_purchases.paid_count, 0), 0)
        )
      END AS moved
    FROM public.post_resource_bundles AS bundles
    LEFT JOIN free_purchases ON free_purchases.bundle_id = bundles.id
    LEFT JOIN paid_purchases ON paid_purchases.bundle_id = bundles.id
  )
  UPDATE public.post_resource_bundles AS bundles
  SET sales_count = bundles.sales_count - moves.moved,
      free_unlock_count = bundles.free_unlock_count + moves.moved
  FROM moves
  WHERE bundles.id = moves.id
    AND moves.moved > 0;

  GET DIAGNOSTICS v_moved_bundles = ROW_COUNT;

  SELECT count(*)::integer
  INTO v_short_bundles
  FROM public.post_resource_bundles AS bundles
  WHERE bundles.sales_count < (
    SELECT count(*)
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.bundle_id = bundles.id
      AND purchases.price_usd_cents > 0
  );

  IF v_short_bundles > 0 THEN
    RAISE EXCEPTION 'FREE_UNLOCK_SPLIT_SHORT: % bundle(s) count fewer sales than paid purchases', v_short_bundles
      USING ERRCODE = 'P0001',
        HINT = 'Compare each bundle''s sales_count with its purchases where price_usd_cents > 0.';
  END IF;

  RETURN v_moved_bundles;
END;
$$;

REVOKE ALL ON FUNCTION public.split_post_resource_bundle_free_unlocks()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.split_post_resource_bundle_free_unlocks() IS
  '2026-10-17 backfill, kept so pgTAP runs it over a seeded mix: moves free purchases not yet counted as free unlocks out of sales_count (on a free recipe, every count beyond its paid purchases), never into a bundle''s paid purchases or below zero, then refuses a bundle counting fewer sales than paid purchases. Idempotent; owner only.';

-- One statement, so a failed split cannot leave a trigger off (as in
-- 20261003010001_mobile_notification_last_event_time.sql). Two triggers are set
-- aside for it:
-- * post_resource_bundles_set_updated_at: moving a count between two columns is
--   not an edit, and updated_at is the date a recipe shows as its last update
--   (the recipe panel, the marketplace card, the app);
-- * post_resource_bundles_freeze_for_account_deletion: a creator whose account
--   deletion is still retrying keeps counts on bundles that are about to go,
--   and this write is metadata only, like the refund decrement that freeze
--   already lets through.
-- The validation, sold-content and revision triggers stay on and pass a write
-- of two counters, and the marketplace listing trigger stays on so its copy of
-- sales_count, the top-sales key, follows the paid count.
DO $split$
DECLARE
  v_moved_bundles integer;
BEGIN
  ALTER TABLE public.post_resource_bundles DISABLE TRIGGER post_resource_bundles_set_updated_at;
  ALTER TABLE public.post_resource_bundles DISABLE TRIGGER post_resource_bundles_freeze_for_account_deletion;

  v_moved_bundles := public.split_post_resource_bundle_free_unlocks();

  ALTER TABLE public.post_resource_bundles ENABLE TRIGGER post_resource_bundles_set_updated_at;
  ALTER TABLE public.post_resource_bundles ENABLE TRIGGER post_resource_bundles_freeze_for_account_deletion;

  RAISE NOTICE 'free unlocks moved out of sales_count on % bundle(s)', v_moved_bundles;
END;
$split$;

-- ─── The reads that hand out sales_count hand out free_unlock_count ──────────
-- Each body is its latest one with the one column added; a new output column
-- changes the function's row type, so each is dropped and created again and
-- keeps its service-role-only grant. Nothing in SQL calls them.

-- Owner post rows (latest: 20260723120000_post_resource_media_scope.sql).
DROP FUNCTION IF EXISTS public.get_owner_post_bundle_summaries(uuid[]);

CREATE FUNCTION public.get_owner_post_bundle_summaries(p_post_ids uuid[])
RETURNS TABLE(
  id uuid,
  post_id uuid,
  access_mode text,
  status text,
  price_usd_cents integer,
  sales_count integer,
  free_unlock_count integer,
  earnings_usd_cents integer,
  resource_kinds text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    bundles.id,
    bundles.post_id,
    bundles.access_mode,
    bundles.status,
    bundles.price_usd_cents,
    bundles.sales_count,
    bundles.free_unlock_count,
    bundles.earnings_usd_cents,
    array_remove(ARRAY[
      CASE WHEN
        CASE
          WHEN jsonb_array_length(coalesce(bundles.resource_items, '[]'::jsonb)) > 0
            THEN bundles.resource_items @> '[{"type":"prompt"}]'::jsonb
          ELSE nullif(btrim(coalesce(bundles.prompt_text, '')), '') IS NOT NULL
        END
      THEN 'prompt' END,
      CASE WHEN
        CASE
          WHEN jsonb_array_length(coalesce(bundles.resource_items, '[]'::jsonb)) > 0
            THEN bundles.resource_items @> '[{"type":"workflow"}]'::jsonb
          ELSE nullif(btrim(coalesce(bundles.workflow_share_url, '')), '') IS NOT NULL
            OR bundles.workflow_snapshot IS NOT NULL
        END
      THEN 'workflow' END,
      CASE WHEN
        CASE
          WHEN jsonb_array_length(coalesce(bundles.resource_items, '[]'::jsonb)) > 0 THEN EXISTS (
            SELECT 1
            FROM jsonb_array_elements(bundles.resource_items) AS item
            WHERE coalesce(item->>'type', '') NOT IN (
              'prompt', 'workflow', 'settings', 'note', 'remix_access', 'remix_link'
            )
          )
          ELSE jsonb_typeof(coalesce(bundles.attachments, '[]'::jsonb)) = 'array'
            AND jsonb_array_length(coalesce(bundles.attachments, '[]'::jsonb)) > 0
        END
      THEN 'files' END,
      CASE WHEN
        CASE
          WHEN jsonb_array_length(coalesce(bundles.resource_items, '[]'::jsonb)) > 0
            THEN bundles.resource_items @> '[{"type":"settings"}]'::jsonb
              OR bundles.resource_items @> '[{"type":"note"}]'::jsonb
          ELSE nullif(btrim(coalesce(bundles.notes_markdown, '')), '') IS NOT NULL
        END
      THEN 'notes' END,
      CASE WHEN
        CASE
          WHEN jsonb_array_length(coalesce(bundles.resource_items, '[]'::jsonb)) > 0
            THEN bundles.resource_items @> '[{"type":"remix_access"}]'::jsonb
              OR bundles.resource_items @> '[{"type":"remix_link"}]'::jsonb
          ELSE bundles.allow_remix
        END
      THEN 'remix' END
    ], NULL)::text[] AS resource_kinds
  FROM public.post_resource_bundles AS bundles
  WHERE bundles.post_id = ANY(coalesce(p_post_ids, ARRAY[]::uuid[]));
$$;

REVOKE ALL ON FUNCTION public.get_owner_post_bundle_summaries(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_owner_post_bundle_summaries(uuid[])
  TO service_role;

COMMENT ON FUNCTION public.get_owner_post_bundle_summaries(uuid[]) IS
  'Backend-only compact unlock summaries for owner post lists.';

-- Owner totals (latest: 20260715090000_backend_read_path_performance.sql). It
-- returns jsonb, so it is replaced in place.
CREATE OR REPLACE FUNCTION public.get_owner_post_sales_summary(p_owner_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'salesCount', coalesce(sum(bundles.sales_count), 0)::bigint,
    'freeUnlockCount', coalesce(sum(bundles.free_unlock_count), 0)::bigint,
    'earningsUsdCents', coalesce(sum(bundles.earnings_usd_cents), 0)::bigint,
    'listingCount', count(*)::integer
  )
  FROM public.post_resource_bundles AS bundles
  JOIN public.posts AS posts ON posts.id = bundles.post_id
  WHERE posts.user_id = p_owner_id;
$$;

REVOKE ALL ON FUNCTION public.get_owner_post_sales_summary(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_owner_post_sales_summary(uuid)
  TO service_role;

COMMENT ON FUNCTION public.get_owner_post_sales_summary(uuid) IS
  'Backend-only lifetime seller totals without hydrating owner post rows. salesCount is paid unlocks; freeUnlockCount is free ones.';

-- Feed and post bundle summaries (latest:
-- 20260715101500_public_bundle_summary_hydration.sql). The count is handed out
-- for a published bundle only, like every other field here.
DROP FUNCTION IF EXISTS public.get_public_post_resource_bundle_summaries(uuid[]);

CREATE FUNCTION public.get_public_post_resource_bundle_summaries(
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
    CASE WHEN bundles.status = 'published' THEN bundles.allow_remix ELSE NULL END AS allow_remix,
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

-- The marketplace listing (latest: 20260810112000_index_marketplace_search.sql).
-- Its filters, its search and its four ORDER BY literals are byte-for-byte as
-- they were, so every sort still matches its index; top-sales stays on the
-- listing's sales_count.
DROP FUNCTION IF EXISTS public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer);

CREATE FUNCTION public.list_marketplace_resource_bundles(
  p_access_filter text DEFAULT 'all',
  p_resource_filter text DEFAULT 'all',
  p_tool_slug text DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_sort text DEFAULT 'recent',
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 24
)
RETURNS TABLE(
  id uuid, post_id uuid, owner_user_id uuid, legacy_asset_id uuid,
  access_mode text, status text, title text, summary text, preview_text text,
  prompt_text text, notes_markdown text, workflow_share_url text,
  workflow_snapshot jsonb, attachments jsonb, allow_remix boolean,
  resource_sections jsonb, resource_items jsonb, price_usd_cents integer,
  sales_count integer, free_unlock_count integer, earnings_usd_cents integer, created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order text;
  v_search_join text := '';
  v_search_filter text := 'AND coalesce(nullif(btrim($4), ''''), '''') = ''''';
BEGIN
  v_order := CASE coalesce(p_sort, 'recent')
    WHEN 'top-sales' THEN 'listings.sales_count DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
    WHEN 'price-low' THEN 'listings.price_usd_cents ASC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
    WHEN 'price-high' THEN 'listings.price_usd_cents DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
    ELSE 'listings.created_at DESC, listings.bundle_id DESC'
  END;

  IF coalesce(nullif(btrim(p_query), ''), '') <> '' THEN
    v_search_join := '
      JOIN public.marketplace_bundle_search_documents search
        ON search.bundle_id = listings.bundle_id';
    v_search_filter := '
      AND char_length(btrim($4)) >= 3
      AND search.search_text ILIKE (''%%'' || lower(btrim($4)) || ''%%'')';
  END IF;

  RETURN QUERY EXECUTE format($sql$
    SELECT
      bundles.id, bundles.post_id, bundles.owner_user_id, bundles.legacy_asset_id,
      bundles.access_mode, bundles.status, bundles.title, bundles.summary,
      bundles.preview_text, bundles.prompt_text, bundles.notes_markdown,
      bundles.workflow_share_url, bundles.workflow_snapshot, bundles.attachments,
      bundles.allow_remix, bundles.resource_sections, bundles.resource_items,
      bundles.price_usd_cents, bundles.sales_count, bundles.free_unlock_count, bundles.earnings_usd_cents,
      bundles.created_at, bundles.updated_at
    FROM public.marketplace_bundle_listings listings
    JOIN public.post_resource_bundles bundles ON bundles.id = listings.bundle_id
    %s
    WHERE listings.listable
      AND ($1 IS NULL OR $1 = 'all' OR listings.access_mode = $1)
      AND (
        $2 IS NULL OR $2 = 'all'
        OR ($2 = 'prompt' AND listings.has_prompt)
        OR ($2 = 'workflow' AND listings.has_workflow)
        OR ($2 = 'files' AND listings.has_files)
        OR ($2 = 'notes' AND listings.has_notes)
        OR ($2 = 'remix' AND listings.has_remix)
      )
      AND (coalesce(nullif($3, ''), '') = '' OR listings.tool_slug = $3)
      %s
    ORDER BY %s
    OFFSET greatest(coalesce($5, 0), 0)
    LIMIT greatest(coalesce($6, 24), 1)
  $sql$, v_search_join, v_search_filter, v_order)
  USING p_access_filter, p_resource_filter, p_tool_slug, p_query, p_offset, p_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer) IS
  'Marketplace listing backed by page-sized sort indexes and a trigger-maintained trigram search document. Public callers must require at least three search characters.';
