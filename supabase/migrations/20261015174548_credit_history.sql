-- Credit history: one newest-first list of every recorded movement of a credit
-- balance, read by GET /api/credits/history (src/lib/credit-history-service.ts)
-- for the web's /credits page and the app's Credit history screen. Decision D6
-- of the 2026-10-15 auth, onboarding, guests and pricing pass.
--
-- The balance has no single ledger: each way credits move writes a record of
-- its own. This function reads each of them and says, per row, what moved, in
-- which direction (a signed whole number of credits), when, and in plain words.
--
--   purchase    transactions whose grant reached the balance
--               (credit_purchase_succeeded_at). Both rails settle there: the web's
--               Razorpay orders and the app's store purchases. The store-side twin,
--               mobile_store_transactions, is not read, or every app purchase would
--               be listed twice.
--   reversal    credit_purchase_adjustments.base_credit_delta (refunds, disputes and
--               restores of a purchase); a transaction refunded before that ledger
--               existed (status 'refunded' with no balance-moving adjustment);
--               referral_credit_ledger reward_reversal and reward_restoration.
--   grant       credit_grants (welcome credits); referral_credit_ledger reward_grant.
--   spend       generations.cost, and generation_spend_audits for a creation the
--               person deleted; ai_usage_events.cost; creation_credit_reservations;
--               credit unlocks of recipes (post_resource_bundle_purchases) and of
--               marketplace resources (marketplace_purchases), told from cash, store
--               and free unlocks by their order reference ('credits_bundle_' and
--               'credits_asset_', as src/lib/viewer-unlocks.ts reads them).
--   refund      the refunded half of each spend source.
--   adjustment  admin_credit_adjustments.credits_delta.
--
-- Not listed, because no table records them: the sign-up credits the profile
-- trigger gave each account created before 2026-08-11 (50, then 25), and any
-- balance the legacy deduct/refund primitives (dropped 2026-07-25 and 2026-08-25)
-- moved without a source row. account_merges is deliberately not a source: when a
-- guest is linked, the guest's own rows (in p_user_ids) already say where those
-- credits came from, and a second entry for the transfer would count them twice.
-- promotional_credits moves only within the total and is never an entry.
--
-- p_user_ids is the identity set: an identity first, then guest identities linked
-- to it (profiles.merged_into_user_id), as resolveLinkedAccountIds returns them. A
-- set holding anything else is refused, so a caller's mistake cannot read another
-- account's history. Pages are keyset pages on (occurred_at, entry_id), newest
-- first: pass the last row's pair as p_before_occurred_at / p_before_id.
CREATE OR REPLACE FUNCTION public.list_credit_history(
  p_user_ids uuid[],
  p_before_occurred_at timestamp with time zone DEFAULT NULL,
  p_before_id text DEFAULT NULL,
  p_limit integer DEFAULT 31
)
RETURNS TABLE (
  entry_id text,
  kind text,
  amount integer,
  occurred_at timestamp with time zone,
  title text,
  detail text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
#variable_conflict use_column
BEGIN
  IF p_user_ids IS NULL
     OR cardinality(p_user_ids) = 0
     OR cardinality(p_user_ids) > 100
     OR array_position(p_user_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'list_credit_history needs 1 to 100 identity ids'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_user_ids) AS requested(user_id)
    WHERE requested.user_id <> p_user_ids[1]
      AND NOT EXISTS (
        SELECT 1
        FROM public.profiles AS linked
        WHERE linked.id = requested.user_id
          AND linked.merged_into_user_id = p_user_ids[1]
      )
  ) THEN
    RAISE EXCEPTION 'list_credit_history reads one identity and the guests linked to it'
      USING ERRCODE = '22023';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 101 THEN
    RAISE EXCEPTION 'list_credit_history limit must be 1 to 101'
      USING ERRCODE = '22023';
  END IF;

  IF (p_before_occurred_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'list_credit_history cursor needs both its time and its id'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH packs (mobile_product_id, credits, name) AS (
    -- contracts/credit-packs-v1.json; credit-history-migration.test.ts holds the two
    -- equal. A web order carries no product id, so its credits name the pack.
    VALUES
      ('magicbooklet.credits.starter', 500, 'Starter pack'),
      ('magicbooklet.credits.creator', 2000, 'Creator pack'),
      ('magicbooklet.credits.pro', 10000, 'Pro pack')
  ),
  purchases AS (
    SELECT
      t.id,
      t.credits,
      t.status,
      t.mobile_product_id,
      t.credit_purchase_succeeded_at,
      t.refunded_at,
      t.updated_at,
      coalesce(
        (SELECT p.name FROM packs AS p WHERE p.mobile_product_id = t.mobile_product_id),
        (SELECT p.name FROM packs AS p WHERE t.mobile_product_id IS NULL AND p.credits = t.credits),
        'Credit pack'
      ) AS pack_name
    FROM public.transactions AS t
    WHERE t.user_id = ANY (p_user_ids)
      AND t.credits > 0
  ),
  live_generations AS (
    SELECT
      g.id,
      g.cost,
      coalesce(g.refunded, false) AS refunded,
      g.created_at,
      g.completed_at,
      g.template_run_id,
      CASE
        WHEN g.creation_mode = 'motion' THEN 'motion'
        WHEN g.category IN ('image', 'video', 'audio') THEN g.category
      END AS medium
    FROM public.generations AS g
    WHERE g.user_id = ANY (p_user_ids)
      AND g.cost > 0
  ),
  deleted_generations AS (
    -- A deleted creation keeps its credit facts here (20260825130000), without its
    -- category or its refund time: the medium comes from the model catalog and the
    -- refund is placed at the creation's own time.
    SELECT
      a.generation_id,
      a.cost,
      a.refunded,
      coalesce(a.generation_created_at, a.deleted_at) AS created_at,
      m.kind AS medium
    FROM public.generation_spend_audits AS a
    LEFT JOIN public.generation_models AS m ON m.model_id = a.model
    WHERE a.user_id = ANY (p_user_ids)
      AND a.cost > 0
  ),
  generation_rows AS (
    SELECT
      'generation:' || g.id::text || ':charge' AS entry_id,
      'spend'::text AS kind,
      -g.cost AS amount,
      coalesce(g.created_at, g.completed_at) AS occurred_at,
      g.medium,
      false AS is_refund,
      CASE WHEN g.template_run_id IS NOT NULL THEN 'From a template' END AS detail
    FROM live_generations AS g
    UNION ALL
    SELECT
      'generation:' || g.id::text || ':refund',
      'refund',
      g.cost,
      coalesce(g.completed_at, g.created_at),
      g.medium,
      true,
      CASE WHEN g.template_run_id IS NOT NULL THEN 'From a template' END
    FROM live_generations AS g
    WHERE g.refunded
    UNION ALL
    SELECT
      'generation:' || d.generation_id::text || ':charge',
      'spend',
      -d.cost,
      d.created_at,
      d.medium,
      false,
      'Deleted creation'
    FROM deleted_generations AS d
    UNION ALL
    SELECT
      'generation:' || d.generation_id::text || ':refund',
      'refund',
      d.cost,
      d.created_at,
      d.medium,
      true,
      'Deleted creation'
    FROM deleted_generations AS d
    WHERE d.refunded
  ),
  entries AS (
    SELECT
      'purchase:' || pu.id::text AS entry_id,
      'purchase'::text AS kind,
      pu.credits AS amount,
      pu.credit_purchase_succeeded_at AS occurred_at,
      pu.pack_name AS title,
      CASE WHEN pu.mobile_product_id IS NULL THEN 'Bought on the web' ELSE 'Bought in the app' END AS detail
    FROM purchases AS pu
    WHERE pu.credit_purchase_succeeded_at IS NOT NULL

    UNION ALL
    -- Refunded before 2026-07-12, when refunds left no adjustment row. A refund
    -- after that date always leaves one, and a purchase refunded before its grant
    -- never has credit_purchase_succeeded_at.
    SELECT
      'purchase:' || pu.id::text || ':refund',
      'reversal',
      -pu.credits,
      coalesce(pu.refunded_at, pu.updated_at),
      'Purchase refunded',
      pu.pack_name
    FROM purchases AS pu
    WHERE pu.status = 'refunded'
      AND pu.credit_purchase_succeeded_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.credit_purchase_adjustments AS a
        WHERE a.transaction_id = pu.id
          AND a.base_credit_delta <> 0
      )

    UNION ALL
    SELECT
      'purchase-adjustment:' || a.id::text,
      'reversal',
      a.base_credit_delta,
      a.created_at,
      CASE
        WHEN a.base_credit_delta > 0 THEN 'Purchase restored'
        WHEN a.reason ILIKE '%dispute%' THEN 'Payment disputed'
        ELSE 'Purchase refunded'
      END,
      pu.pack_name
    FROM public.credit_purchase_adjustments AS a
    JOIN purchases AS pu ON pu.id = a.transaction_id
    WHERE a.base_credit_delta <> 0

    UNION ALL
    SELECT
      'grant:' || cg.id::text,
      'grant',
      cg.amount,
      cg.claimed_at,
      CASE
        WHEN starts_with(cg.program_key, 'welcome_credits') THEN 'Welcome credits'
        ELSE coalesce(nullif(btrim(program.display_name), ''), 'Bonus credits')
      END,
      NULL::text
    FROM public.credit_grants AS cg
    LEFT JOIN public.credit_grant_programs AS program ON program.program_key = cg.program_key
    WHERE cg.user_id = ANY (p_user_ids)

    UNION ALL
    SELECT
      'referral:' || l.id::text,
      CASE WHEN l.entry_kind = 'reward_grant' THEN 'grant' ELSE 'reversal' END,
      l.credit_delta,
      l.created_at,
      CASE l.entry_kind
        WHEN 'reward_grant' THEN 'Referral reward'
        WHEN 'reward_reversal' THEN 'Referral reward reversed'
        ELSE 'Referral reward restored'
      END,
      -- The invite screens' own words for the two rewards (InviteClient.tsx).
      CASE r.kind
        WHEN 'invitee_first_purchase' THEN 'First top-up bonus'
        WHEN 'inviter_purchase' THEN 'Friend top-up reward'
      END
    FROM public.referral_credit_ledger AS l
    LEFT JOIN public.referral_rewards AS r ON r.id = l.reward_id
    WHERE l.user_id = ANY (p_user_ids)

    UNION ALL
    -- The operator's reason is an internal note and stays out of the list.
    SELECT
      'adjustment:' || x.id::text,
      'adjustment',
      x.credits_delta,
      x.created_at,
      'Adjustment',
      'Made by Magicbooklet support'
    FROM public.admin_credit_adjustments AS x
    WHERE x.user_id = ANY (p_user_ids)
      AND x.credits_delta <> 0

    UNION ALL
    SELECT
      gr.entry_id,
      gr.kind,
      gr.amount,
      gr.occurred_at,
      CASE
        WHEN gr.is_refund THEN 'Refund: failed ' || CASE gr.medium
          WHEN 'image' THEN 'image'
          WHEN 'video' THEN 'video'
          WHEN 'motion' THEN 'motion video'
          WHEN 'audio' THEN 'audio'
          ELSE 'generation'
        END
        ELSE CASE gr.medium
          WHEN 'image' THEN 'Image generation'
          WHEN 'video' THEN 'Video generation'
          WHEN 'motion' THEN 'Motion video'
          WHEN 'audio' THEN 'Audio generation'
          ELSE 'Generation'
        END
      END,
      gr.detail
    FROM generation_rows AS gr

    UNION ALL
    SELECT
      'ai-usage:' || e.id::text || ':charge',
      'spend',
      -e.cost,
      e.created_at,
      CASE e.feature
        WHEN 'prompt_enhancement' THEN 'Prompt enhancement'
        WHEN 'workflow_blueprint' THEN 'Workflow blueprint'
        WHEN 'workflow_assistant' THEN 'Workflow assistant'
        ELSE 'AI assist'
      END,
      NULL::text
    FROM public.ai_usage_events AS e
    WHERE e.user_id = ANY (p_user_ids)
      AND e.cost > 0

    UNION ALL
    SELECT
      'ai-usage:' || e.id::text || ':refund',
      'refund',
      e.cost,
      coalesce(e.settled_at, e.created_at),
      'Refund: failed ' || CASE e.feature
        WHEN 'prompt_enhancement' THEN 'prompt enhancement'
        WHEN 'workflow_blueprint' THEN 'workflow blueprint'
        WHEN 'workflow_assistant' THEN 'assistant reply'
        ELSE 'AI assist'
      END,
      NULL::text
    FROM public.ai_usage_events AS e
    WHERE e.user_id = ANY (p_user_ids)
      AND e.cost > 0
      AND coalesce(e.refunded, false)

    UNION ALL
    -- Reservations held the legacy voice and sound generation paths (20260712123000).
    SELECT
      'reservation:' || c.id::text || ':charge',
      'spend',
      -c.credits,
      c.created_at,
      'Audio generation',
      NULL::text
    FROM public.creation_credit_reservations AS c
    WHERE c.user_id = ANY (p_user_ids)
      AND c.credits > 0

    UNION ALL
    SELECT
      'reservation:' || c.id::text || ':refund',
      'refund',
      c.credits,
      coalesce(c.refunded_at, c.created_at),
      'Refund: failed audio',
      NULL::text
    FROM public.creation_credit_reservations AS c
    WHERE c.user_id = ANY (p_user_ids)
      AND c.credits > 0
      AND c.status = 'refunded'

    UNION ALL
    -- A recipe paid in credits. Purchases copied from the legacy marketplace keep
    -- its 'credits_asset_' order reference and are listed here, once.
    SELECT
      'unlock:' || b.id::text,
      'spend',
      -b.price_usd_cents,
      b.created_at,
      'Recipe unlocked',
      nullif(btrim(b.post_title), '')
    FROM public.post_resource_bundle_purchases AS b
    JOIN public.post_resource_bundle_orders AS o ON o.id = b.order_id
    WHERE b.buyer_user_id = ANY (p_user_ids)
      AND b.price_usd_cents > 0
      AND (starts_with(o.razorpay_order_id, 'credits_bundle_')
        OR starts_with(o.razorpay_order_id, 'credits_asset_'))

    UNION ALL
    SELECT
      'marketplace-unlock:' || mp.id::text,
      'spend',
      -mp.price_usd_cents,
      mp.created_at,
      'Resource unlocked',
      nullif(btrim(asset.title), '')
    FROM public.marketplace_purchases AS mp
    JOIN public.marketplace_orders AS mo ON mo.id = mp.order_id
    LEFT JOIN public.marketplace_assets AS asset ON asset.id = mp.asset_id
    WHERE mp.buyer_user_id = ANY (p_user_ids)
      AND mp.price_usd_cents > 0
      AND starts_with(mo.razorpay_order_id, 'credits_asset_')
      AND NOT EXISTS (
        SELECT 1
        FROM public.post_resource_bundle_purchases AS copied
        WHERE copied.legacy_purchase_id = mp.id
      )
  )
  SELECT e.entry_id, e.kind, e.amount, e.occurred_at, e.title, e.detail
  FROM entries AS e
  -- A row with no time at all cannot be placed on the list or behind a cursor.
  WHERE e.occurred_at IS NOT NULL
    AND e.amount <> 0
    AND (
      p_before_occurred_at IS NULL
      OR e.occurred_at < p_before_occurred_at
      OR (e.occurred_at = p_before_occurred_at
        AND e.entry_id COLLATE "C" < p_before_id COLLATE "C")
    )
  ORDER BY e.occurred_at DESC, e.entry_id COLLATE "C" DESC
  LIMIT p_limit;
END;
$function$;

COMMENT ON FUNCTION public.list_credit_history(uuid[], timestamp with time zone, text, integer) IS
  'Credit history for an identity and the guests linked to it, newest first, keyset-paged on (occurred_at, entry_id). Service role only; GET /api/credits/history.';

REVOKE ALL ON FUNCTION public.list_credit_history(uuid[], timestamp with time zone, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_credit_history(uuid[], timestamp with time zone, text, integer) TO service_role;
