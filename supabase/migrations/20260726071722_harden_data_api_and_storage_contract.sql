-- Make the Data API surface explicit. Supabase's platform defaults changed in
-- 2026; declaring grants here keeps clean replays and established projects on
-- the same contract.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES
  FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS
  FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES
  FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS
  FROM PUBLIC;

-- PostgreSQL combines schema defaults with the global built-in PUBLIC EXECUTE
-- default. A schema-scoped REVOKE cannot subtract that global grant, so remove
-- it at the owning-role level as well.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS
  FROM PUBLIC, anon, authenticated, service_role;

-- REVOKE at table scope does not remove a separately granted column
-- privilege. Remove both layers before rebuilding the five client contracts.
REVOKE ALL PRIVILEGES ON TABLE
  public.posts,
  public.generations,
  public.post_media,
  public.showcase_saves,
  public.workflow_shares
FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_table_name text;
  v_column_list text;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'posts',
    'generations',
    'post_media',
    'showcase_saves',
    'workflow_shares'
  ]
  LOOP
    SELECT string_agg(quote_ident(columns.column_name), ', ' ORDER BY columns.ordinal_position)
    INTO v_column_list
    FROM information_schema.columns
    WHERE columns.table_schema = 'public'
      AND columns.table_name = v_table_name;

    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',
      v_column_list,
      v_table_name
    );
  END LOOP;
END;
$$;

-- posts and post_media are service-layer resources. The RLS SELECT policy on
-- posts remains as defense in depth, and now includes the moderation state so
-- a future accidental grant still cannot expose a hidden or flagged post.
DROP POLICY IF EXISTS "Posts are viewable by owner or public" ON public.posts;
CREATE POLICY "Posts are viewable by owner or public"
  ON public.posts
  FOR SELECT
  TO anon, authenticated
  USING (
    (SELECT auth.uid()) = user_id
    OR (
      archived_at IS NULL
      AND review_status = 'visible'
      AND visibility IN ('public', 'unlisted')
    )
  );

DROP POLICY IF EXISTS "Post media is viewable by owner or visible post" ON public.post_media;
DROP POLICY IF EXISTS "Users can insert media for their own posts" ON public.post_media;
DROP POLICY IF EXISTS "Users can update media for their own posts" ON public.post_media;
DROP POLICY IF EXISTS "Users can delete media for their own posts" ON public.post_media;

-- Browser generation-resume reads only this safe owner-scoped projection.
-- Generation writes and all other columns remain backend-only.
DROP POLICY IF EXISTS "Anyone can view public generations" ON public.generations;
DROP POLICY IF EXISTS "Users can view accessible generations" ON public.generations;
DROP POLICY IF EXISTS "Users can view accessible ordinary generations" ON public.generations;
DROP POLICY IF EXISTS "Users can view own generations" ON public.generations;
DROP POLICY IF EXISTS "Users can view their own generations." ON public.generations;
CREATE POLICY "Users can resume their own generations"
  ON public.generations
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Saved-state rows are private relationships. A signed-in user can operate
-- only on their own rows; anonymous enumeration is never allowed.
DROP POLICY IF EXISTS "Anyone can view saves" ON public.showcase_saves;
DROP POLICY IF EXISTS "Users can view their own saves" ON public.showcase_saves;
CREATE POLICY "Users can view their own saves"
  ON public.showcase_saves
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert their own saves" ON public.showcase_saves;
CREATE POLICY "Users can insert their own saves"
  ON public.showcase_saves
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete their own saves" ON public.showcase_saves;
CREATE POLICY "Users can delete their own saves"
  ON public.showcase_saves
  FOR DELETE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Share graphs are resolved by an exact opaque id in the service layer. They
-- must not be listable or insertable with a normal user Data API session.
DROP POLICY IF EXISTS "Authenticated users can view workflow shares" ON public.workflow_shares;
DROP POLICY IF EXISTS "Users can create their own workflow shares" ON public.workflow_shares;

GRANT SELECT (
  id,
  user_id,
  prediction_id,
  status,
  created_at,
  duration,
  category,
  creation_mode
) ON TABLE public.generations TO authenticated;

GRANT SELECT, INSERT, DELETE ON TABLE public.showcase_saves TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.posts,
  public.generations,
  public.post_media,
  public.showcase_saves,
  public.workflow_shares
TO service_role;

-- A report is a moderation queue signal, not an automatic takedown. Preserve
-- any explicit staff review state and let only the service-only moderation RPC
-- hide content.
CREATE OR REPLACE FUNCTION public.increment_post_report_count()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.posts
  SET report_count = report_count + 1,
      updated_at = timezone('utc'::text, now())
  WHERE id = NEW.post_id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_post_report_count()
  FROM PUBLIC, anon, authenticated;

-- Reconcile bucket metadata by UPSERT, not UPDATE, so a clean replay creates
-- every bucket with the same limits as an established project.
INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'generated_videos',
  'generated_videos',
  false,
  262144000,
  ARRAY[
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-m4v'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'uploads',
  'uploads',
  false,
  262144000,
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif',
    'image/heic',
    'image/heif',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-m4v',
    'audio/mpeg',
    'audio/mp4',
    'audio/wav',
    'audio/x-wav',
    'audio/aac',
    'audio/ogg',
    'audio/webm'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'post_resource_files',
  'post_resource_files',
  false,
  52428800,
  ARRAY[
    'application/csv',
    'application/json',
    'application/pdf',
    'application/gzip',
    'application/octet-stream',
    'application/x-yaml',
    'application/x-gzip',
    'application/zip',
    'application/x-zip-compressed',
    'application/yaml',
    'text/comma-separated-values',
    'text/csv',
    'text/markdown',
    'text/plain',
    'text/x-markdown',
    'text/x-yaml',
    'text/yaml',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif',
    'video/mp4',
    'video/x-m4v',
    'video/quicktime',
    'video/webm',
    'audio/mpeg',
    'audio/wav',
    'audio/x-wav',
    'audio/mp4',
    'audio/aac',
    'audio/ogg',
    'audio/flac'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'showcase_media',
  'showcase_media',
  true,
  262144000,
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif',
    'image/heic',
    'image/heif',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-m4v'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- A hard takedown must also close the legacy generation publication flag in
-- the same transaction. Otherwise a generation-backed post can disappear from
-- the post feed while remaining eligible for an older public-generation path.
CREATE OR REPLACE FUNCTION public.resolve_post_report_for_ops(
  p_report_id uuid,
  p_reviewer_id uuid,
  p_action text,
  p_resolution_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_report public.post_reports%ROWTYPE;
  v_generation_id uuid;
  v_now timestamptz := timezone('utc'::text, now());
  v_note text := nullif(btrim(p_resolution_note), '');
  v_resolved_count integer := 0;
BEGIN
  IF p_report_id IS NULL OR p_reviewer_id IS NULL THEN
    RAISE EXCEPTION 'Report and reviewer are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('take_down', 'dismiss') THEN
    RAISE EXCEPTION 'Unsupported moderation action'
      USING ERRCODE = '22023';
  END IF;

  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'Resolution note must be 1000 characters or fewer'
      USING ERRCODE = '22001';
  END IF;

  PERFORM 1
  FROM auth.users
  WHERE id = p_reviewer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reviewer not found'
      USING ERRCODE = '23503';
  END IF;

  SELECT *
  INTO v_report
  FROM public.post_reports
  WHERE id = p_report_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post report not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Serialize every decision for the same post and capture the linked
  -- generation while the post lock is held.
  SELECT generation_id
  INTO v_generation_id
  FROM public.posts
  WHERE id = v_report.post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reported post not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
  INTO v_report
  FROM public.post_reports
  WHERE id = p_report_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post report not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_report.status <> 'open' THEN
    RETURN jsonb_build_object(
      'status', 'already_resolved',
      'report_id', v_report.id,
      'post_id', v_report.post_id,
      'report_status', v_report.status,
      'resolution_action', v_report.resolution_action,
      'reviewed_at', v_report.reviewed_at,
      'reviewed_by', v_report.reviewed_by
    );
  END IF;

  IF p_action = 'take_down' THEN
    UPDATE public.posts
    SET review_status = 'hidden',
        reviewed_at = v_now,
        reviewed_by = p_reviewer_id,
        updated_at = v_now
    WHERE id = v_report.post_id;

    IF v_generation_id IS NOT NULL THEN
      UPDATE public.generations
      SET is_public = false
      WHERE id = v_generation_id
        AND is_public IS DISTINCT FROM false;
    END IF;

    UPDATE public.post_resource_bundles
    SET status = 'draft',
        updated_at = v_now
    WHERE post_id = v_report.post_id
      AND status = 'published';

    UPDATE public.marketplace_assets
    SET status = 'unlisted',
        updated_at = v_now
    WHERE post_id = v_report.post_id
      AND status = 'active';

    UPDATE public.post_reports
    SET status = 'reviewed',
        reviewed_at = v_now,
        reviewed_by = p_reviewer_id,
        resolution_action = 'take_down',
        resolution_note = v_note,
        updated_at = v_now
    WHERE post_id = v_report.post_id
      AND status = 'open';

    GET DIAGNOSTICS v_resolved_count = ROW_COUNT;

    RETURN jsonb_build_object(
      'status', 'taken_down',
      'report_id', v_report.id,
      'post_id', v_report.post_id,
      'report_status', 'reviewed',
      'post_review_status', 'hidden',
      'resolved_report_count', v_resolved_count,
      'reviewed_at', v_now,
      'reviewed_by', p_reviewer_id
    );
  END IF;

  UPDATE public.post_reports
  SET status = 'dismissed',
      reviewed_at = v_now,
      reviewed_by = p_reviewer_id,
      resolution_action = 'dismiss',
      resolution_note = v_note,
      updated_at = v_now
  WHERE id = v_report.id
    AND status = 'open';

  IF NOT EXISTS (
    SELECT 1
    FROM public.post_reports
    WHERE post_id = v_report.post_id
      AND status = 'open'
  ) THEN
    UPDATE public.posts
    SET review_status = 'visible',
        reviewed_at = v_now,
        reviewed_by = p_reviewer_id,
        updated_at = v_now
    WHERE id = v_report.post_id
      AND review_status = 'flagged';
  END IF;

  RETURN jsonb_build_object(
    'status', 'dismissed',
    'report_id', v_report.id,
    'post_id', v_report.post_id,
    'report_status', 'dismissed',
    'reviewed_at', v_now,
    'reviewed_by', p_reviewer_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_post_report_for_ops(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_post_report_for_ops(uuid, uuid, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_hidden_generation_republish()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.is_public IS TRUE
    AND EXISTS (
      SELECT 1
      FROM public.posts
      WHERE generation_id = NEW.id
        AND review_status = 'hidden'
    ) THEN
    RAISE EXCEPTION 'Cannot publish a generation linked to hidden content'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_hidden_generation_republish()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS generations_prevent_hidden_insert_public
  ON public.generations;
CREATE TRIGGER generations_prevent_hidden_insert_public
BEFORE INSERT ON public.generations
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hidden_generation_republish();

DROP TRIGGER IF EXISTS generations_prevent_hidden_republish
  ON public.generations;
CREATE TRIGGER generations_prevent_hidden_republish
BEFORE UPDATE OF is_public ON public.generations
FOR EACH ROW
WHEN (NEW.is_public IS TRUE)
EXECUTE FUNCTION public.prevent_hidden_generation_republish();

-- One client intent can create at most one provider order. The stable receipt
-- lets the server recover an ambiguously completed provider request before it
-- retries order creation.
CREATE TABLE IF NOT EXISTS public.razorpay_checkout_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purchase_kind text NOT NULL CHECK (
    purchase_kind IN ('credits', 'marketplace', 'post_resource')
  ),
  client_intent_key text NOT NULL CHECK (
    length(client_intent_key) BETWEEN 16 AND 128
    AND client_intent_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  provider_receipt text NOT NULL UNIQUE,
  provider_order_id text UNIQUE,
  status text NOT NULL DEFAULT 'claimed' CHECK (
    status IN ('claimed', 'order_created', 'failed')
  ),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  claimed_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (user_id, purchase_kind, client_intent_key),
  CHECK (last_error IS NULL OR char_length(last_error) <= 500)
);

CREATE INDEX IF NOT EXISTS razorpay_checkout_intents_stale_claim_idx
  ON public.razorpay_checkout_intents (claimed_at, id)
  WHERE status = 'claimed' AND provider_order_id IS NULL;

ALTER TABLE public.razorpay_checkout_intents ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.razorpay_checkout_intents
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.razorpay_checkout_intents
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_razorpay_checkout_intent(
  p_user_id uuid,
  p_purchase_kind text,
  p_client_intent_key text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind text := lower(btrim(coalesce(p_purchase_kind, '')));
  v_key text := btrim(coalesce(p_client_intent_key, ''));
  v_hash text := lower(btrim(coalesce(p_request_hash, '')));
  v_intent public.razorpay_checkout_intents%ROWTYPE;
  v_intent_id uuid;
  v_receipt text;
  v_now timestamptz := timezone('utc'::text, now());
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Checkout user is required' USING ERRCODE = '22023';
  END IF;

  IF v_kind NOT IN ('credits', 'marketplace', 'post_resource') THEN
    RAISE EXCEPTION 'Unsupported checkout purchase kind' USING ERRCODE = '22023';
  END IF;

  IF length(v_key) NOT BETWEEN 16 AND 128
    OR v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' THEN
    RAISE EXCEPTION 'Invalid checkout intent key' USING ERRCODE = '22023';
  END IF;

  IF v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid checkout request hash' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || v_kind || ':' || v_key, 0)
  );

  SELECT *
  INTO v_intent
  FROM public.razorpay_checkout_intents
  WHERE user_id = p_user_id
    AND purchase_kind = v_kind
    AND client_intent_key = v_key
  FOR UPDATE;

  IF NOT FOUND THEN
    v_intent_id := gen_random_uuid();
    v_receipt := 'mb_' || replace(v_intent_id::text, '-', '');

    INSERT INTO public.razorpay_checkout_intents (
      id,
      user_id,
      purchase_kind,
      client_intent_key,
      request_hash,
      provider_receipt,
      status,
      claimed_at
    ) VALUES (
      v_intent_id,
      p_user_id,
      v_kind,
      v_key,
      v_hash,
      v_receipt,
      'claimed',
      v_now
    )
    ON CONFLICT (user_id, purchase_kind, client_intent_key) DO NOTHING
    RETURNING * INTO v_intent;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'status', 'claimed',
        'intent_id', v_intent.id,
        'provider_receipt', v_intent.provider_receipt,
        'provider_order_id', NULL
      );
    END IF;

    -- The advisory lock serializes normal callers. ON CONFLICT plus this
    -- re-lock also makes the result deterministic if a privileged writer
    -- inserts the same intent outside this RPC.
    SELECT *
    INTO v_intent
    FROM public.razorpay_checkout_intents
    WHERE user_id = p_user_id
      AND purchase_kind = v_kind
      AND client_intent_key = v_key
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Checkout intent conflict could not be recovered'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  IF v_intent.request_hash <> v_hash THEN
    RETURN jsonb_build_object(
      'status', 'payload_mismatch',
      'intent_id', v_intent.id,
      'provider_receipt', v_intent.provider_receipt,
      'provider_order_id', v_intent.provider_order_id
    );
  END IF;

  IF v_intent.provider_order_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'replay',
      'intent_id', v_intent.id,
      'provider_receipt', v_intent.provider_receipt,
      'provider_order_id', v_intent.provider_order_id
    );
  END IF;

  IF v_intent.status = 'claimed'
    AND v_intent.claimed_at > v_now - interval '5 minutes' THEN
    RETURN jsonb_build_object(
      'status', 'in_progress',
      'intent_id', v_intent.id,
      'provider_receipt', v_intent.provider_receipt,
      'provider_order_id', NULL
    );
  END IF;

  UPDATE public.razorpay_checkout_intents
  SET status = 'claimed',
      attempt_count = attempt_count + 1,
      claimed_at = v_now,
      last_error = NULL,
      updated_at = v_now
  WHERE id = v_intent.id;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'intent_id', v_intent.id,
    'provider_receipt', v_intent.provider_receipt,
    'provider_order_id', NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_razorpay_checkout_intent(
  p_intent_id uuid,
  p_user_id uuid,
  p_provider_order_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_id text := btrim(coalesce(p_provider_order_id, ''));
  v_intent public.razorpay_checkout_intents%ROWTYPE;
BEGIN
  IF p_intent_id IS NULL OR p_user_id IS NULL
    OR length(v_order_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Invalid checkout completion' USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_intent
  FROM public.razorpay_checkout_intents
  WHERE id = p_intent_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_intent.provider_order_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status',
      CASE
        WHEN v_intent.provider_order_id = v_order_id THEN 'replay'
        ELSE 'provider_order_conflict'
      END,
      'intent_id', v_intent.id,
      'provider_receipt', v_intent.provider_receipt,
      'provider_order_id', v_intent.provider_order_id
    );
  END IF;

  UPDATE public.razorpay_checkout_intents
  SET provider_order_id = v_order_id,
      status = 'order_created',
      last_error = NULL,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_intent.id;

  RETURN jsonb_build_object(
    'status', 'recorded',
    'intent_id', v_intent.id,
    'provider_receipt', v_intent.provider_receipt,
    'provider_order_id', v_order_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.abandon_razorpay_checkout_intent(
  p_intent_id uuid,
  p_user_id uuid,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_intent public.razorpay_checkout_intents%ROWTYPE;
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 500);
BEGIN
  IF p_intent_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Invalid checkout abandonment' USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_intent
  FROM public.razorpay_checkout_intents
  WHERE id = p_intent_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_intent.provider_order_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'order_created',
      'intent_id', v_intent.id,
      'provider_order_id', v_intent.provider_order_id
    );
  END IF;

  UPDATE public.razorpay_checkout_intents
  SET status = 'failed',
      last_error = v_error,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_intent.id;

  RETURN jsonb_build_object(
    'status', 'abandoned',
    'intent_id', v_intent.id,
    'provider_receipt', v_intent.provider_receipt
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_razorpay_checkout_intent(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_razorpay_checkout_intent(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.abandon_razorpay_checkout_intent(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_razorpay_checkout_intent(uuid, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_razorpay_checkout_intent(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.abandon_razorpay_checkout_intent(uuid, uuid, text)
  TO service_role;

-- Provider payment ids are one-to-one within each cash order surface.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_payment_id_unique_idx
  ON public.transactions (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_orders_payment_id_unique_idx
  ON public.marketplace_orders (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS post_resource_bundle_orders_payment_id_unique_idx
  ON public.post_resource_bundle_orders (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

-- A delayed capture must never revive an order that a refund/dispute already
-- failed. Both completion paths lock the order and accept only the single
-- created -> paid transition; paid replays and every terminal state fail
-- closed.
CREATE OR REPLACE FUNCTION public.complete_marketplace_purchase(
  p_razorpay_order_id text,
  p_razorpay_payment_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.marketplace_orders%ROWTYPE;
  v_asset public.marketplace_assets%ROWTYPE;
  v_purchase_id uuid;
BEGIN
  IF nullif(btrim(p_razorpay_order_id), '') IS NULL
    OR nullif(btrim(p_razorpay_payment_id), '') IS NULL THEN
    RETURN false;
  END IF;

  SELECT *
  INTO v_order
  FROM public.marketplace_orders
  WHERE razorpay_order_id = btrim(p_razorpay_order_id)
  FOR UPDATE;

  IF NOT FOUND OR v_order.status <> 'created' THEN
    RETURN false;
  END IF;

  SELECT *
  INTO v_asset
  FROM public.marketplace_assets
  WHERE id = v_order.asset_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.marketplace_orders
  SET status = 'paid',
      razorpay_payment_id = btrim(p_razorpay_payment_id),
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.id
    AND status = 'created';

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.marketplace_purchases (
    asset_id,
    buyer_user_id,
    order_id,
    price_usd_cents,
    amount_subunits,
    currency
  )
  VALUES (
    v_order.asset_id,
    v_order.buyer_user_id,
    v_order.id,
    v_asset.price_usd_cents,
    v_order.amount_subunits,
    v_order.currency
  )
  ON CONFLICT (asset_id, buyer_user_id) DO NOTHING
  RETURNING id INTO v_purchase_id;

  IF v_purchase_id IS NULL THEN
    -- A second checkout for content the buyer already owns must not leave a
    -- paid order without its own entitlement. Preserve the payment id for ops
    -- reconciliation, but make the local order terminal and non-fulfillable.
    UPDATE public.marketplace_orders
    SET status = 'failed',
        updated_at = timezone('utc'::text, now())
    WHERE id = v_order.id
      AND status = 'paid';

    RETURN false;
  END IF;

  UPDATE public.marketplace_assets
  SET sales_count = sales_count + 1,
      earnings_usd_cents = earnings_usd_cents + v_asset.price_usd_cents,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.asset_id;

  RETURN true;
END;
$$;

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
  v_purchase_id uuid;
BEGIN
  IF nullif(btrim(p_razorpay_order_id), '') IS NULL
    OR nullif(btrim(p_razorpay_payment_id), '') IS NULL THEN
    RETURN false;
  END IF;

  SELECT *
  INTO v_order
  FROM public.post_resource_bundle_orders
  WHERE razorpay_order_id = btrim(p_razorpay_order_id)
  FOR UPDATE;

  IF NOT FOUND OR v_order.status <> 'created' THEN
    RETURN false;
  END IF;

  SELECT *
  INTO v_bundle
  FROM public.post_resource_bundles
  WHERE id = v_order.bundle_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.post_resource_bundle_orders
  SET status = 'paid',
      razorpay_payment_id = btrim(p_razorpay_payment_id),
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.id
    AND status = 'created';

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.post_resource_bundle_purchases (
    bundle_id,
    buyer_user_id,
    order_id,
    price_usd_cents,
    amount_subunits,
    currency
  )
  VALUES (
    v_order.bundle_id,
    v_order.buyer_user_id,
    v_order.id,
    v_bundle.price_usd_cents,
    v_order.amount_subunits,
    v_order.currency
  )
  ON CONFLICT (bundle_id, buyer_user_id) DO NOTHING
  RETURNING id INTO v_purchase_id;

  IF v_purchase_id IS NULL THEN
    UPDATE public.post_resource_bundle_orders
    SET status = 'failed',
        updated_at = timezone('utc'::text, now())
    WHERE id = v_order.id
      AND status = 'paid';

    RETURN false;
  END IF;

  UPDATE public.post_resource_bundles
  SET sales_count = sales_count + 1,
      earnings_usd_cents = earnings_usd_cents + v_bundle.price_usd_cents,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.bundle_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_marketplace_purchase(text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_post_resource_bundle_purchase(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_marketplace_purchase(text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_post_resource_bundle_purchase(text, text)
  TO service_role;

-- Every cash entitlement adjustment is durable and idempotent by both provider
-- event and logical payment action. dispute.won is intentionally recorded as a
-- manual review; refunds remain irreversible and entitlements are never
-- silently re-created.
CREATE TABLE IF NOT EXISTS public.cash_purchase_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id text NOT NULL UNIQUE,
  provider_payment_id text NOT NULL,
  purchase_kind text NOT NULL CHECK (
    purchase_kind IN ('marketplace', 'post_resource')
  ),
  action text NOT NULL CHECK (action IN ('refund', 'dispute', 'restore')),
  outcome text NOT NULL CHECK (outcome IN ('adjusted', 'manual_review')),
  marketplace_order_id uuid REFERENCES public.marketplace_orders(id) ON DELETE SET NULL,
  post_resource_order_id uuid REFERENCES public.post_resource_bundle_orders(id) ON DELETE SET NULL,
  entitlement_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (purchase_kind, provider_payment_id, action),
  CHECK (length(provider_event_id) BETWEEN 1 AND 255),
  CHECK (length(provider_payment_id) BETWEEN 1 AND 255),
  CHECK (reason IS NULL OR char_length(reason) <= 500),
  CHECK (jsonb_typeof(entitlement_snapshot) = 'object'),
  CHECK (
    (purchase_kind = 'marketplace' AND post_resource_order_id IS NULL)
    OR (purchase_kind = 'post_resource' AND marketplace_order_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS cash_purchase_adjustments_payment_idx
  ON public.cash_purchase_adjustments (
    purchase_kind,
    provider_payment_id,
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS cash_purchase_adjustments_marketplace_order_idx
  ON public.cash_purchase_adjustments (marketplace_order_id)
  WHERE marketplace_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cash_purchase_adjustments_post_resource_order_idx
  ON public.cash_purchase_adjustments (post_resource_order_id)
  WHERE post_resource_order_id IS NOT NULL;

ALTER TABLE public.cash_purchase_adjustments ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.cash_purchase_adjustments
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cash_purchase_adjustments
  TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_marketplace_cash_adjustment(
  p_provider_event_id text,
  p_payment_id text,
  p_action text,
  p_reason text DEFAULT NULL,
  p_provider_order_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_id text := btrim(coalesce(p_provider_event_id, ''));
  v_payment_id text := btrim(coalesce(p_payment_id, ''));
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_provider_order_id text :=
    nullif(btrim(coalesce(p_provider_order_id, '')), '');
  v_existing public.cash_purchase_adjustments%ROWTYPE;
  v_order public.marketplace_orders%ROWTYPE;
  v_purchase public.marketplace_purchases%ROWTYPE;
BEGIN
  IF length(v_event_id) NOT BETWEEN 1 AND 255
    OR length(v_payment_id) NOT BETWEEN 1 AND 255
    OR (
      v_provider_order_id IS NOT NULL
      AND length(v_provider_order_id) NOT BETWEEN 1 AND 255
    )
    OR v_action NOT IN ('refund', 'dispute', 'restore') THEN
    RAISE EXCEPTION 'Invalid marketplace cash adjustment'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cash-event:' || v_event_id, 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('marketplace-payment:' || v_payment_id, 0)
  );

  SELECT *
  INTO v_existing
  FROM public.cash_purchase_adjustments
  WHERE provider_event_id = v_event_id
     OR (
       purchase_kind = 'marketplace'
       AND provider_payment_id = v_payment_id
       AND action = v_action
     )
  ORDER BY (provider_event_id = v_event_id) DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',
      CASE
        WHEN v_existing.outcome = 'manual_review' THEN 'manual_review'
        ELSE 'already_adjusted'
      END,
      'adjustment_id', v_existing.id,
      'action', v_existing.action
    );
  END IF;

  SELECT *
  INTO v_order
  FROM public.marketplace_orders
  WHERE razorpay_payment_id = v_payment_id
     OR (
       v_provider_order_id IS NOT NULL
       AND razorpay_order_id = v_provider_order_id
     )
  ORDER BY (razorpay_payment_id = v_payment_id) DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_provider_order_id IS NOT NULL
    AND v_order.razorpay_order_id IS DISTINCT FROM v_provider_order_id THEN
    RETURN jsonb_build_object('status', 'order_conflict');
  END IF;

  IF v_order.razorpay_payment_id IS NOT NULL
    AND v_order.razorpay_payment_id IS DISTINCT FROM v_payment_id THEN
    RETURN jsonb_build_object('status', 'payment_conflict');
  END IF;

  IF v_action = 'restore' THEN
    INSERT INTO public.cash_purchase_adjustments (
      provider_event_id,
      provider_payment_id,
      purchase_kind,
      action,
      outcome,
      marketplace_order_id,
      reason
    ) VALUES (
      v_event_id,
      v_payment_id,
      'marketplace',
      v_action,
      'manual_review',
      v_order.id,
      v_reason
    )
    RETURNING * INTO v_existing;

    RETURN jsonb_build_object(
      'status', 'manual_review',
      'adjustment_id', v_existing.id,
      'action', v_action
    );
  END IF;

  IF v_order.status = 'created' THEN
    UPDATE public.marketplace_orders
    SET status = 'failed',
        razorpay_payment_id = v_payment_id,
        updated_at = timezone('utc'::text, now())
    WHERE id = v_order.id
      AND status = 'created';

    INSERT INTO public.cash_purchase_adjustments (
      provider_event_id,
      provider_payment_id,
      purchase_kind,
      action,
      outcome,
      marketplace_order_id,
      entitlement_snapshot,
      reason
    ) VALUES (
      v_event_id,
      v_payment_id,
      'marketplace',
      v_action,
      'adjusted',
      v_order.id,
      jsonb_build_object(
        'prior_status', 'created',
        'entitlement_granted', false,
        'provider_order_id', v_order.razorpay_order_id
      ),
      v_reason
    )
    RETURNING * INTO v_existing;

    RETURN jsonb_build_object(
      'status', 'adjusted',
      'adjustment_id', v_existing.id,
      'action', v_action,
      'order_id', v_order.id,
      'capture_blocked', true
    );
  END IF;

  IF v_order.status <> 'paid' THEN
    RETURN jsonb_build_object('status', 'not_paid');
  END IF;

  SELECT *
  INTO v_purchase
  FROM public.marketplace_purchases
  WHERE order_id = v_order.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'entitlement_missing');
  END IF;

  DELETE FROM public.marketplace_purchases
  WHERE id = v_purchase.id;

  UPDATE public.marketplace_orders
  SET status = 'failed',
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.id;

  UPDATE public.marketplace_assets
  SET sales_count = greatest(0, sales_count - 1),
      earnings_usd_cents = greatest(
        0,
        earnings_usd_cents - v_purchase.price_usd_cents
      ),
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.asset_id;

  INSERT INTO public.cash_purchase_adjustments (
    provider_event_id,
    provider_payment_id,
    purchase_kind,
    action,
    outcome,
    marketplace_order_id,
    entitlement_snapshot,
    reason
  ) VALUES (
    v_event_id,
    v_payment_id,
    'marketplace',
    v_action,
    'adjusted',
    v_order.id,
    to_jsonb(v_purchase),
    v_reason
  )
  RETURNING * INTO v_existing;

  RETURN jsonb_build_object(
    'status', 'adjusted',
    'adjustment_id', v_existing.id,
    'action', v_action,
    'order_id', v_order.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_post_resource_cash_adjustment(
  p_provider_event_id text,
  p_payment_id text,
  p_action text,
  p_reason text DEFAULT NULL,
  p_provider_order_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_id text := btrim(coalesce(p_provider_event_id, ''));
  v_payment_id text := btrim(coalesce(p_payment_id, ''));
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_provider_order_id text :=
    nullif(btrim(coalesce(p_provider_order_id, '')), '');
  v_existing public.cash_purchase_adjustments%ROWTYPE;
  v_order public.post_resource_bundle_orders%ROWTYPE;
  v_purchase public.post_resource_bundle_purchases%ROWTYPE;
BEGIN
  IF length(v_event_id) NOT BETWEEN 1 AND 255
    OR length(v_payment_id) NOT BETWEEN 1 AND 255
    OR (
      v_provider_order_id IS NOT NULL
      AND length(v_provider_order_id) NOT BETWEEN 1 AND 255
    )
    OR v_action NOT IN ('refund', 'dispute', 'restore') THEN
    RAISE EXCEPTION 'Invalid post-resource cash adjustment'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cash-event:' || v_event_id, 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('post-resource-payment:' || v_payment_id, 0)
  );

  SELECT *
  INTO v_existing
  FROM public.cash_purchase_adjustments
  WHERE provider_event_id = v_event_id
     OR (
       purchase_kind = 'post_resource'
       AND provider_payment_id = v_payment_id
       AND action = v_action
     )
  ORDER BY (provider_event_id = v_event_id) DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',
      CASE
        WHEN v_existing.outcome = 'manual_review' THEN 'manual_review'
        ELSE 'already_adjusted'
      END,
      'adjustment_id', v_existing.id,
      'action', v_existing.action
    );
  END IF;

  SELECT *
  INTO v_order
  FROM public.post_resource_bundle_orders
  WHERE razorpay_payment_id = v_payment_id
     OR (
       v_provider_order_id IS NOT NULL
       AND razorpay_order_id = v_provider_order_id
     )
  ORDER BY (razorpay_payment_id = v_payment_id) DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_provider_order_id IS NOT NULL
    AND v_order.razorpay_order_id IS DISTINCT FROM v_provider_order_id THEN
    RETURN jsonb_build_object('status', 'order_conflict');
  END IF;

  IF v_order.razorpay_payment_id IS NOT NULL
    AND v_order.razorpay_payment_id IS DISTINCT FROM v_payment_id THEN
    RETURN jsonb_build_object('status', 'payment_conflict');
  END IF;

  IF v_action = 'restore' THEN
    INSERT INTO public.cash_purchase_adjustments (
      provider_event_id,
      provider_payment_id,
      purchase_kind,
      action,
      outcome,
      post_resource_order_id,
      reason
    ) VALUES (
      v_event_id,
      v_payment_id,
      'post_resource',
      v_action,
      'manual_review',
      v_order.id,
      v_reason
    )
    RETURNING * INTO v_existing;

    RETURN jsonb_build_object(
      'status', 'manual_review',
      'adjustment_id', v_existing.id,
      'action', v_action
    );
  END IF;

  IF v_order.status = 'created' THEN
    UPDATE public.post_resource_bundle_orders
    SET status = 'failed',
        razorpay_payment_id = v_payment_id,
        updated_at = timezone('utc'::text, now())
    WHERE id = v_order.id
      AND status = 'created';

    INSERT INTO public.cash_purchase_adjustments (
      provider_event_id,
      provider_payment_id,
      purchase_kind,
      action,
      outcome,
      post_resource_order_id,
      entitlement_snapshot,
      reason
    ) VALUES (
      v_event_id,
      v_payment_id,
      'post_resource',
      v_action,
      'adjusted',
      v_order.id,
      jsonb_build_object(
        'prior_status', 'created',
        'entitlement_granted', false,
        'provider_order_id', v_order.razorpay_order_id
      ),
      v_reason
    )
    RETURNING * INTO v_existing;

    RETURN jsonb_build_object(
      'status', 'adjusted',
      'adjustment_id', v_existing.id,
      'action', v_action,
      'order_id', v_order.id,
      'capture_blocked', true
    );
  END IF;

  IF v_order.status <> 'paid' THEN
    RETURN jsonb_build_object('status', 'not_paid');
  END IF;

  SELECT *
  INTO v_purchase
  FROM public.post_resource_bundle_purchases
  WHERE order_id = v_order.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'entitlement_missing');
  END IF;

  -- The paid -> failed transition occurs after entitlement deletion so
  -- reverse_post_resource_wallet_on_refund can reverse the exact sale ledger.
  DELETE FROM public.post_resource_bundle_purchases
  WHERE id = v_purchase.id;

  UPDATE public.post_resource_bundle_orders
  SET status = 'failed',
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.id;

  UPDATE public.post_resource_bundles
  SET sales_count = greatest(0, sales_count - 1),
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.bundle_id;

  INSERT INTO public.cash_purchase_adjustments (
    provider_event_id,
    provider_payment_id,
    purchase_kind,
    action,
    outcome,
    post_resource_order_id,
    entitlement_snapshot,
    reason
  ) VALUES (
    v_event_id,
    v_payment_id,
    'post_resource',
    v_action,
    'adjusted',
    v_order.id,
    to_jsonb(v_purchase),
    v_reason
  )
  RETURNING * INTO v_existing;

  RETURN jsonb_build_object(
    'status', 'adjusted',
    'adjustment_id', v_existing.id,
    'action', v_action,
    'order_id', v_order.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_marketplace_cash_adjustment(
  text, text, text, text, text
)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_post_resource_cash_adjustment(
  text, text, text, text, text
)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_marketplace_cash_adjustment(
  text, text, text, text, text
)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_post_resource_cash_adjustment(
  text, text, text, text, text
)
  TO service_role;

COMMENT ON TABLE public.razorpay_checkout_intents IS
  'Service-only durable idempotency claims for Razorpay Orders API creation.';
COMMENT ON TABLE public.cash_purchase_adjustments IS
  'Service-only exactly-once ledger for cash entitlement refunds and disputes.';
COMMENT ON FUNCTION public.reconcile_marketplace_cash_adjustment(
  text, text, text, text, text
) IS
  'Service-only atomic marketplace cash entitlement revocation; restore requires manual review.';
COMMENT ON FUNCTION public.reconcile_post_resource_cash_adjustment(
  text, text, text, text, text
) IS
  'Service-only atomic post-resource cash entitlement revocation; restore requires manual review.';

-- Auth deletion cannot be the final storage-cleanup step: signed upload tokens
-- issued before deletion can remain valid after the first sweep. Preserve the
-- manifest and make a delayed post-expiry resweep a durable worker job.
ALTER TABLE public.account_deletion_jobs
  DROP CONSTRAINT IF EXISTS account_deletion_jobs_status_check;

ALTER TABLE public.account_deletion_jobs
  ADD CONSTRAINT account_deletion_jobs_status_check
  CHECK (status IN (
    'requested',
    'storage_deleting',
    'storage_deleted',
    'auth_deleting',
    'resweep_waiting',
    'resweep_deleting',
    'completed',
    'failed'
  ));

ALTER TABLE public.account_deletion_jobs
  ADD COLUMN IF NOT EXISTS resweep_after timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz
    DEFAULT timezone('utc'::text, now()),
  ADD COLUMN IF NOT EXISTS initial_resume_stage text
    NOT NULL DEFAULT 'storage_deleting'
    CHECK (initial_resume_stage IN ('storage_deleting', 'auth_deleting')),
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS final_resweep_completed_at timestamptz;

ALTER TABLE public.account_deletion_jobs
  DROP CONSTRAINT IF EXISTS account_deletion_jobs_lease_shape_check;

ALTER TABLE public.account_deletion_jobs
  ADD CONSTRAINT account_deletion_jobs_lease_shape_check CHECK (
    (
      lease_token IS NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
    OR (
      lease_token IS NOT NULL
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND char_length(lease_owner) BETWEEN 1 AND 128
    )
  );

CREATE INDEX IF NOT EXISTS account_deletion_jobs_resweep_due_idx
  ON public.account_deletion_jobs (
    next_attempt_at,
    lease_expires_at,
    requested_at,
    user_id
  )
  WHERE status IN ('resweep_waiting', 'resweep_deleting');

CREATE OR REPLACE FUNCTION public.mark_account_deletion_stage(
  p_user_id uuid,
  p_status text,
  p_error_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.account_deletion_jobs%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_status NOT IN (
    'storage_deleting',
    'storage_deleted',
    'auth_deleting',
    'completed',
    'failed'
  ) THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT *
  INTO v_job
  FROM public.account_deletion_jobs
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object(
      'status', 'already_completed',
      'user_id', p_user_id
    );
  END IF;

  -- An ambiguous Auth API response can reach the route after the database
  -- trigger has already scheduled the resweep. Never let a legacy failure
  -- marker move that durable state backwards.
  IF v_job.status IN ('resweep_waiting', 'resweep_deleting') THEN
    RETURN jsonb_build_object(
      'status', 'resweep_pending',
      'user_id', p_user_id,
      'resweep_after', v_job.resweep_after,
      'next_attempt_at', v_job.next_attempt_at
    );
  END IF;

  -- Only finalize_account_deletion_resweep may redact the manifest. A legacy
  -- route completion call also covers the idempotent "auth user not found"
  -- case by scheduling, rather than completing, the required delayed resweep.
  IF p_status = 'completed' AND v_job.final_resweep_completed_at IS NULL THEN
    UPDATE public.account_deletion_jobs
    SET status = 'resweep_waiting',
        last_error = NULL,
        resweep_after = coalesce(
          resweep_after,
          timezone('utc'::text, now()) + interval '2 hours 15 minutes'
        ),
        next_attempt_at = greatest(
          coalesce(
            resweep_after,
            timezone('utc'::text, now()) + interval '2 hours 15 minutes'
          ),
          timezone('utc'::text, now()) + interval '2 hours 15 minutes'
        ),
        lease_token = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        completed_at = NULL,
        updated_at = timezone('utc'::text, now())
    WHERE user_id = p_user_id
    RETURNING * INTO v_job;

    RETURN jsonb_build_object(
      'status', 'resweep_pending',
      'user_id', p_user_id,
      'resweep_after', v_job.resweep_after,
      'next_attempt_at', v_job.next_attempt_at
    );
  END IF;

  UPDATE public.account_deletion_jobs
  SET status = p_status,
      initial_resume_stage = CASE
        WHEN p_status IN ('storage_deleted', 'auth_deleting')
          THEN 'auth_deleting'
        ELSE initial_resume_stage
      END,
      last_error = CASE
        WHEN p_status = 'failed'
          THEN left(coalesce(p_error_message, 'Unknown deletion error'), 1000)
        ELSE NULL
      END,
      storage_completed_at = CASE
        WHEN p_status = 'storage_deleted'
          THEN coalesce(storage_completed_at, timezone('utc'::text, now()))
        ELSE storage_completed_at
      END,
      auth_delete_started_at = CASE
        WHEN p_status = 'auth_deleting'
          THEN coalesce(auth_delete_started_at, timezone('utc'::text, now()))
        ELSE auth_delete_started_at
      END,
      completed_at = CASE
        WHEN p_status = 'completed'
          THEN coalesce(completed_at, timezone('utc'::text, now()))
        ELSE completed_at
      END,
      next_attempt_at = CASE
        WHEN p_status = 'failed'
          THEN timezone('utc'::text, now()) + interval '5 minutes'
        ELSE next_attempt_at
      END,
      lease_token = CASE WHEN p_status = 'failed' THEN NULL ELSE lease_token END,
      lease_owner = CASE WHEN p_status = 'failed' THEN NULL ELSE lease_owner END,
      lease_expires_at = CASE
        WHEN p_status = 'failed' THEN NULL
        ELSE lease_expires_at
      END,
      updated_at = timezone('utc'::text, now())
  WHERE user_id = p_user_id
  RETURNING * INTO v_job;

  RETURN jsonb_build_object(
    'status', v_job.status,
    'user_id', v_job.user_id,
    'attempt_count', v_job.attempt_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_account_deletion_initial(
  p_worker_id text,
  p_lease_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_worker_id text := btrim(coalesce(p_worker_id, ''));
  v_now timestamptz := timezone('utc'::text, now());
  v_job public.account_deletion_jobs%ROWTYPE;
  v_claimed_status text;
  v_lease_token uuid := gen_random_uuid();
BEGIN
  IF length(v_worker_id) NOT BETWEEN 1 AND 128
    OR p_lease_seconds NOT BETWEEN 30 AND 1800 THEN
    RAISE EXCEPTION 'Invalid account deletion initial lease'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_job
  FROM public.account_deletion_jobs
  WHERE status IN (
      'requested',
      'storage_deleting',
      'storage_deleted',
      'auth_deleting',
      'failed'
    )
    AND coalesce(next_attempt_at, v_now) <= v_now
    -- The request route owns the first pass. The scheduler only takes over a
    -- fresh, unleased non-failure row after a short stale grace, avoiding two
    -- workers starting the same deletion on the request's scheduler tick.
    AND (
      status = 'failed'
      OR updated_at <= v_now - interval '2 minutes'
    )
    AND (
      lease_token IS NULL
      OR lease_expires_at IS NULL
      OR lease_expires_at <= v_now
    )
  ORDER BY
    coalesce(next_attempt_at, requested_at),
    requested_at,
    user_id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_work');
  END IF;

  v_claimed_status := CASE
    WHEN v_job.status IN ('storage_deleted', 'auth_deleting')
      OR (
        v_job.status = 'failed'
        AND v_job.initial_resume_stage = 'auth_deleting'
      )
      THEN 'auth_deleting'
    ELSE 'storage_deleting'
  END;

  UPDATE public.account_deletion_jobs
  SET status = v_claimed_status,
      initial_resume_stage = v_claimed_status,
      lease_token = v_lease_token,
      lease_owner = v_worker_id,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      attempt_count = attempt_count + 1,
      last_attempt_at = v_now,
      last_error = NULL,
      updated_at = v_now
  WHERE user_id = v_job.user_id
  RETURNING * INTO v_job;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'user_id', v_job.user_id,
    'job_status', v_job.status,
    'storage_manifest', v_job.storage_manifest,
    'lease_token', v_job.lease_token,
    'lease_expires_at', v_job.lease_expires_at,
    'attempt_count', v_job.attempt_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_account_deletion_initial(
  p_user_id uuid,
  p_lease_token uuid,
  p_status text,
  p_error_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := timezone('utc'::text, now());
  v_job public.account_deletion_jobs%ROWTYPE;
  v_retry_minutes integer;
  v_resweep_after timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_lease_token IS NULL OR p_status NOT IN (
    'storage_deleted',
    'auth_deleting',
    'resweep_waiting',
    'failed'
  ) THEN
    RAISE EXCEPTION 'Invalid account deletion initial transition'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_job
  FROM public.account_deletion_jobs
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_job.status IN ('resweep_waiting', 'resweep_deleting', 'completed') THEN
    RETURN jsonb_build_object(
      'status',
      CASE
        WHEN v_job.status = 'completed' THEN 'already_completed'
        ELSE 'resweep_pending'
      END,
      'user_id', p_user_id
    );
  END IF;

  IF v_job.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN jsonb_build_object('status', 'lease_mismatch', 'user_id', p_user_id);
  END IF;

  IF p_status = 'storage_deleted' THEN
    IF v_job.status <> 'storage_deleting' THEN
      RETURN jsonb_build_object('status', 'invalid_transition', 'user_id', p_user_id);
    END IF;

    UPDATE public.account_deletion_jobs
    SET status = 'storage_deleted',
        initial_resume_stage = 'auth_deleting',
        storage_completed_at = coalesce(storage_completed_at, v_now),
        last_error = NULL,
        updated_at = v_now
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object('status', 'storage_deleted', 'user_id', p_user_id);
  END IF;

  IF p_status = 'auth_deleting' THEN
    IF v_job.status NOT IN ('storage_deleted', 'auth_deleting') THEN
      RETURN jsonb_build_object('status', 'invalid_transition', 'user_id', p_user_id);
    END IF;

    UPDATE public.account_deletion_jobs
    SET status = 'auth_deleting',
        initial_resume_stage = 'auth_deleting',
        auth_delete_started_at = coalesce(auth_delete_started_at, v_now),
        last_error = NULL,
        updated_at = v_now
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object('status', 'auth_deleting', 'user_id', p_user_id);
  END IF;

  IF p_status = 'resweep_waiting' THEN
    IF v_job.status <> 'auth_deleting' THEN
      RETURN jsonb_build_object('status', 'invalid_transition', 'user_id', p_user_id);
    END IF;

    v_resweep_after := v_now + interval '2 hours 15 minutes';

    UPDATE public.account_deletion_jobs
    SET status = 'resweep_waiting',
        resweep_after = coalesce(resweep_after, v_resweep_after),
        next_attempt_at = greatest(
          coalesce(resweep_after, v_resweep_after),
          v_resweep_after
        ),
        lease_token = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        completed_at = NULL,
        updated_at = v_now
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
      'status', 'resweep_pending',
      'user_id', p_user_id,
      'resweep_after', v_resweep_after
    );
  END IF;

  v_retry_minutes := least(60, greatest(5, v_job.attempt_count * 5));

  UPDATE public.account_deletion_jobs
  SET status = 'failed',
      initial_resume_stage = CASE
        WHEN v_job.status IN ('storage_deleted', 'auth_deleting')
          THEN 'auth_deleting'
        ELSE 'storage_deleting'
      END,
      last_error = left(
        coalesce(p_error_message, 'Unknown initial deletion error'),
        1000
      ),
      next_attempt_at = v_now + make_interval(mins => v_retry_minutes),
      lease_token = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = v_now
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'status', 'retry_scheduled',
    'user_id', p_user_id,
    'resume_stage', CASE
      WHEN v_job.status IN ('storage_deleted', 'auth_deleting')
        THEN 'auth_deleting'
      ELSE 'storage_deleting'
    END,
    'next_attempt_at', v_now + make_interval(mins => v_retry_minutes)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_account_deletion_job_after_auth_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_resweep_after timestamptz :=
    timezone('utc'::text, now()) + interval '2 hours 15 minutes';
BEGIN
  UPDATE public.account_deletion_jobs
  SET status = 'resweep_waiting',
      last_error = NULL,
      resweep_after = coalesce(resweep_after, v_resweep_after),
      next_attempt_at = greatest(
        coalesce(next_attempt_at, v_resweep_after),
        coalesce(resweep_after, v_resweep_after),
        v_resweep_after
      ),
      lease_token = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      completed_at = NULL,
      updated_at = timezone('utc'::text, now())
  WHERE user_id = OLD.id
    AND status = 'auth_deleting';

  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_account_deletion_resweep(
  p_worker_id text,
  p_lease_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_worker_id text := btrim(coalesce(p_worker_id, ''));
  v_now timestamptz := timezone('utc'::text, now());
  v_job public.account_deletion_jobs%ROWTYPE;
  v_lease_token uuid := gen_random_uuid();
BEGIN
  IF length(v_worker_id) NOT BETWEEN 1 AND 128
    OR p_lease_seconds NOT BETWEEN 30 AND 1800 THEN
    RAISE EXCEPTION 'Invalid account deletion resweep lease'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_job
  FROM public.account_deletion_jobs
  WHERE status IN ('resweep_waiting', 'resweep_deleting')
    AND coalesce(resweep_after, v_now) <= v_now
    AND coalesce(next_attempt_at, v_now) <= v_now
    AND (
      status = 'resweep_waiting'
      OR lease_expires_at IS NULL
      OR lease_expires_at <= v_now
    )
  ORDER BY
    coalesce(next_attempt_at, requested_at),
    requested_at,
    user_id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_work');
  END IF;

  UPDATE public.account_deletion_jobs
  SET status = 'resweep_deleting',
      lease_token = v_lease_token,
      lease_owner = v_worker_id,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      attempt_count = attempt_count + 1,
      last_attempt_at = v_now,
      last_error = NULL,
      updated_at = v_now
  WHERE user_id = v_job.user_id
  RETURNING * INTO v_job;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'user_id', v_job.user_id,
    'job_status', v_job.status,
    'storage_manifest', v_job.storage_manifest,
    'lease_token', v_job.lease_token,
    'lease_expires_at', v_job.lease_expires_at,
    'attempt_count', v_job.attempt_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_account_deletion_resweep(
  p_user_id uuid,
  p_lease_token uuid,
  p_succeeded boolean,
  p_error_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := timezone('utc'::text, now());
  v_job public.account_deletion_jobs%ROWTYPE;
  v_retry_minutes integer;
BEGIN
  IF p_user_id IS NULL OR p_lease_token IS NULL OR p_succeeded IS NULL THEN
    RAISE EXCEPTION 'Invalid account deletion resweep completion'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_job
  FROM public.account_deletion_jobs
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed', 'user_id', p_user_id);
  END IF;

  IF v_job.status <> 'resweep_deleting'
    OR v_job.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN jsonb_build_object('status', 'lease_mismatch', 'user_id', p_user_id);
  END IF;

  IF p_succeeded THEN
    UPDATE public.account_deletion_jobs
    SET status = 'completed',
        storage_manifest = jsonb_build_object(
          'retention_policy', storage_manifest->'retention_policy'
        ),
        last_error = NULL,
        next_attempt_at = NULL,
        lease_token = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        final_resweep_completed_at = v_now,
        completed_at = coalesce(completed_at, v_now),
        updated_at = v_now
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object('status', 'completed', 'user_id', p_user_id);
  END IF;

  v_retry_minutes := least(60, greatest(5, v_job.attempt_count * 5));

  UPDATE public.account_deletion_jobs
  SET status = 'resweep_waiting',
      last_error = left(
        coalesce(p_error_message, 'Unknown storage resweep error'),
        1000
      ),
      next_attempt_at = v_now + make_interval(mins => v_retry_minutes),
      lease_token = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = v_now
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'status', 'retry_scheduled',
    'user_id', p_user_id,
    'next_attempt_at', v_now + make_interval(mins => v_retry_minutes)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_account_deletion_requested(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.account_deletion_jobs
      WHERE user_id = p_user_id
    );
$$;

REVOKE ALL ON FUNCTION public.mark_account_deletion_stage(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_account_deletion_job_after_auth_delete()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_account_deletion_initial(text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_account_deletion_initial(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_account_deletion_resweep(text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_account_deletion_resweep(uuid, uuid, boolean, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_account_deletion_requested(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.mark_account_deletion_stage(uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_account_deletion_initial(text, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_account_deletion_initial(uuid, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_account_deletion_resweep(text, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_account_deletion_resweep(uuid, uuid, boolean, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.is_account_deletion_requested(uuid)
  TO service_role;

COMMENT ON FUNCTION public.claim_account_deletion_resweep(text, integer) IS
  'Leases one due post-token-expiry Storage resweep to a backend worker.';
COMMENT ON FUNCTION public.claim_account_deletion_initial(text, integer) IS
  'Leases one initial account deletion from its durable resume stage.';
COMMENT ON FUNCTION public.transition_account_deletion_initial(uuid, uuid, text, text) IS
  'Lease-enforced initial deletion transition, retry, or resweep scheduling.';
COMMENT ON FUNCTION public.finalize_account_deletion_resweep(uuid, uuid, boolean, text) IS
  'Completes or reschedules a leased Storage resweep; only success redacts the manifest.';
COMMENT ON FUNCTION public.is_account_deletion_requested(uuid) IS
  'Service-only upload guard: true from the first durable deletion request onward.';
