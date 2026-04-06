CREATE TABLE IF NOT EXISTS public.posts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'unlisted', 'private')),
  category text NOT NULL CHECK (category IN ('image', 'video', 'motion', 'ugc-ad')),
  title text,
  description text,
  prompt text,
  source_kind text NOT NULL CHECK (source_kind IN ('ugc_copy', 'external')),
  source_tool text,
  generation_id uuid UNIQUE REFERENCES public.generations(id) ON DELETE SET NULL,
  showcase_asset_path text,
  output_url text,
  save_count integer NOT NULL DEFAULT 0,
  remix_count integer NOT NULL DEFAULT 0,
  share_count integer NOT NULL DEFAULT 0,
  share_visit_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.post_saves (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  post_id uuid REFERENCES public.posts(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS public.post_share_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id uuid REFERENCES public.posts(id) ON DELETE CASCADE NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('share_click', 'share_visit')),
  source_surface text NOT NULL CHECK (
    source_surface IN (
      'create-image',
      'create-video',
      'create-motion',
      'my-creations',
      'creator-profile',
      'showcase',
      'detail-page'
    )
  ),
  channel text CHECK (channel IN ('native-share', 'copy-link')),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.marketplace_assets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  seller_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  post_id uuid UNIQUE REFERENCES public.posts(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('workflow', 'prompt_pack', 'guide')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  preview text NOT NULL DEFAULT '',
  price_usd_cents integer NOT NULL CHECK (price_usd_cents = 0 OR price_usd_cents >= 100),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'unlisted', 'deleted')),
  sales_count integer NOT NULL DEFAULT 0,
  earnings_usd_cents integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.marketplace_asset_content (
  asset_id uuid PRIMARY KEY REFERENCES public.marketplace_assets(id) ON DELETE CASCADE,
  workflow_graph jsonb,
  prompt_pack text,
  guide_markdown text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.marketplace_orders (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  asset_id uuid REFERENCES public.marketplace_assets(id) ON DELETE CASCADE NOT NULL,
  buyer_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  razorpay_order_id text UNIQUE NOT NULL,
  razorpay_payment_id text,
  amount_subunits integer NOT NULL,
  currency text NOT NULL CHECK (currency IN ('INR', 'USD')),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed')),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.marketplace_purchases (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  asset_id uuid REFERENCES public.marketplace_assets(id) ON DELETE CASCADE NOT NULL,
  buyer_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  order_id uuid REFERENCES public.marketplace_orders(id) ON DELETE CASCADE NOT NULL,
  price_usd_cents integer NOT NULL,
  amount_subunits integer NOT NULL,
  currency text NOT NULL CHECK (currency IN ('INR', 'USD')),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (asset_id, buyer_user_id)
);

CREATE INDEX IF NOT EXISTS posts_public_recent_idx
  ON public.posts (created_at DESC, id DESC)
  WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS posts_public_category_recent_idx
  ON public.posts (category, created_at DESC, id DESC)
  WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS posts_public_top_saves_idx
  ON public.posts (save_count DESC, created_at DESC, id DESC)
  WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS posts_public_top_remixes_idx
  ON public.posts (remix_count DESC, created_at DESC, id DESC)
  WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS posts_generation_lookup_idx
  ON public.posts (generation_id)
  WHERE generation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS post_saves_post_id_idx
  ON public.post_saves (post_id);

CREATE INDEX IF NOT EXISTS post_share_events_post_created_idx
  ON public.post_share_events (post_id, created_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_assets_status_created_idx
  ON public.marketplace_assets (status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS marketplace_assets_sales_idx
  ON public.marketplace_assets (sales_count DESC, created_at DESC, id DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS marketplace_orders_buyer_created_idx
  ON public.marketplace_orders (buyer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_orders_asset_created_idx
  ON public.marketplace_orders (asset_id, created_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_purchases_buyer_created_idx
  ON public.marketplace_purchases (buyer_user_id, created_at DESC);

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_saves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_share_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_asset_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_purchases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Posts are viewable by owner or public" ON public.posts;
CREATE POLICY "Posts are viewable by owner or public"
  ON public.posts FOR SELECT TO public
  USING (visibility IN ('public', 'unlisted') OR auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own posts" ON public.posts;
CREATE POLICY "Users can insert their own posts"
  ON public.posts FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own posts" ON public.posts;
CREATE POLICY "Users can update their own posts"
  ON public.posts FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own posts" ON public.posts;
CREATE POLICY "Users can delete their own posts"
  ON public.posts FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Post saves are viewable by everyone" ON public.post_saves;
CREATE POLICY "Post saves are viewable by everyone"
  ON public.post_saves FOR SELECT TO public
  USING (true);

DROP POLICY IF EXISTS "Users can insert their own post saves" ON public.post_saves;
CREATE POLICY "Users can insert their own post saves"
  ON public.post_saves FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own post saves" ON public.post_saves;
CREATE POLICY "Users can delete their own post saves"
  ON public.post_saves FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Post share events are viewable by everyone" ON public.post_share_events;
CREATE POLICY "Post share events are viewable by everyone"
  ON public.post_share_events FOR SELECT TO public
  USING (true);

DROP POLICY IF EXISTS "Sellers can view their own assets" ON public.marketplace_assets;
CREATE POLICY "Sellers can view their own assets"
  ON public.marketplace_assets FOR SELECT TO public
  USING (status IN ('active', 'unlisted') OR auth.uid() = seller_user_id);

DROP POLICY IF EXISTS "Sellers can insert their own assets" ON public.marketplace_assets;
CREATE POLICY "Sellers can insert their own assets"
  ON public.marketplace_assets FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = seller_user_id);

DROP POLICY IF EXISTS "Sellers can update their own assets" ON public.marketplace_assets;
CREATE POLICY "Sellers can update their own assets"
  ON public.marketplace_assets FOR UPDATE TO authenticated
  USING (auth.uid() = seller_user_id)
  WITH CHECK (auth.uid() = seller_user_id);

DROP POLICY IF EXISTS "Sellers can delete their own assets" ON public.marketplace_assets;
CREATE POLICY "Sellers can delete their own assets"
  ON public.marketplace_assets FOR DELETE TO authenticated
  USING (auth.uid() = seller_user_id);

DROP POLICY IF EXISTS "Asset content is viewable by seller or buyer" ON public.marketplace_asset_content;
CREATE POLICY "Asset content is viewable by seller or buyer"
  ON public.marketplace_asset_content FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.marketplace_assets assets
      WHERE assets.id = marketplace_asset_content.asset_id
        AND assets.seller_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.marketplace_purchases purchases
      WHERE purchases.asset_id = marketplace_asset_content.asset_id
        AND purchases.buyer_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Sellers can insert their own asset content" ON public.marketplace_asset_content;
CREATE POLICY "Sellers can insert their own asset content"
  ON public.marketplace_asset_content FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.marketplace_assets assets
      WHERE assets.id = marketplace_asset_content.asset_id
        AND assets.seller_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Sellers can update their own asset content" ON public.marketplace_asset_content;
CREATE POLICY "Sellers can update their own asset content"
  ON public.marketplace_asset_content FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.marketplace_assets assets
      WHERE assets.id = marketplace_asset_content.asset_id
        AND assets.seller_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.marketplace_assets assets
      WHERE assets.id = marketplace_asset_content.asset_id
        AND assets.seller_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Buyers can view their own marketplace orders" ON public.marketplace_orders;
CREATE POLICY "Buyers can view their own marketplace orders"
  ON public.marketplace_orders FOR SELECT TO authenticated
  USING (auth.uid() = buyer_user_id);

DROP POLICY IF EXISTS "Buyers can view their own marketplace purchases" ON public.marketplace_purchases;
CREATE POLICY "Buyers can view their own marketplace purchases"
  ON public.marketplace_purchases FOR SELECT TO authenticated
  USING (auth.uid() = buyer_user_id);

CREATE OR REPLACE FUNCTION public.touch_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS posts_set_updated_at ON public.posts;
CREATE TRIGGER posts_set_updated_at
BEFORE UPDATE ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at_column();

DROP TRIGGER IF EXISTS marketplace_assets_set_updated_at ON public.marketplace_assets;
CREATE TRIGGER marketplace_assets_set_updated_at
BEFORE UPDATE ON public.marketplace_assets
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at_column();

DROP TRIGGER IF EXISTS marketplace_asset_content_set_updated_at ON public.marketplace_asset_content;
CREATE TRIGGER marketplace_asset_content_set_updated_at
BEFORE UPDATE ON public.marketplace_asset_content
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at_column();

DROP TRIGGER IF EXISTS marketplace_orders_set_updated_at ON public.marketplace_orders;
CREATE TRIGGER marketplace_orders_set_updated_at
BEFORE UPDATE ON public.marketplace_orders
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at_column();

CREATE OR REPLACE FUNCTION public.toggle_post_save(p_post_id uuid, p_user_id uuid)
RETURNS boolean AS $$
DECLARE
  v_exists boolean;
  v_visibility text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT visibility
  INTO v_visibility
  FROM public.posts
  WHERE id = p_post_id;

  IF NOT FOUND OR v_visibility IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'Post is private or not found';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.post_saves
    WHERE post_id = p_post_id AND user_id = p_user_id
  ) INTO v_exists;

  IF v_exists THEN
    DELETE FROM public.post_saves
    WHERE post_id = p_post_id AND user_id = p_user_id;

    UPDATE public.posts
    SET save_count = GREATEST(0, save_count - 1)
    WHERE id = p_post_id;

    RETURN false;
  END IF;

  INSERT INTO public.post_saves (post_id, user_id)
  VALUES (p_post_id, p_user_id);

  UPDATE public.posts
  SET save_count = save_count + 1
  WHERE id = p_post_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.increment_post_remix_count(p_post_id uuid)
RETURNS void AS $$
DECLARE
  v_visibility text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT visibility
  INTO v_visibility
  FROM public.posts
  WHERE id = p_post_id;

  IF NOT FOUND OR v_visibility IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'Post is private or not found';
  END IF;

  UPDATE public.posts
  SET remix_count = remix_count + 1
  WHERE id = p_post_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.record_post_share_event(
  p_post_id uuid,
  p_event_type text,
  p_source_surface text,
  p_channel text DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS void AS $$
DECLARE
  v_visibility text;
BEGIN
  SELECT visibility
  INTO v_visibility
  FROM public.posts
  WHERE id = p_post_id;

  IF v_visibility IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'Only public posts can record share events'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.post_share_events (
    post_id,
    event_type,
    source_surface,
    channel,
    actor_user_id
  )
  VALUES (
    p_post_id,
    p_event_type,
    p_source_surface,
    p_channel,
    p_actor_user_id
  );

  IF p_event_type = 'share_click' THEN
    UPDATE public.posts
    SET share_count = share_count + 1
    WHERE id = p_post_id;
  ELSIF p_event_type = 'share_visit' THEN
    UPDATE public.posts
    SET share_visit_count = share_visit_count + 1
    WHERE id = p_post_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.complete_marketplace_purchase(
  p_razorpay_order_id text,
  p_razorpay_payment_id text
)
RETURNS boolean AS $$
DECLARE
  v_order public.marketplace_orders%ROWTYPE;
  v_asset public.marketplace_assets%ROWTYPE;
BEGIN
  SELECT *
  INTO v_order
  FROM public.marketplace_orders
  WHERE razorpay_order_id = p_razorpay_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_order.status = 'paid' THEN
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
      razorpay_payment_id = p_razorpay_payment_id,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.id;

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
  ON CONFLICT (asset_id, buyer_user_id) DO NOTHING;

  UPDATE public.marketplace_assets
  SET sales_count = sales_count + 1,
      earnings_usd_cents = earnings_usd_cents + v_asset.price_usd_cents,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.asset_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.toggle_post_save(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.toggle_post_save(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.toggle_post_save(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.increment_post_remix_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_post_remix_count(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.increment_post_remix_count(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.record_post_share_event(uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_post_share_event(uuid, text, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.record_post_share_event(uuid, text, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_post_share_event(uuid, text, text, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.complete_marketplace_purchase(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_marketplace_purchase(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.complete_marketplace_purchase(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_marketplace_purchase(text, text) TO service_role;

INSERT INTO public.posts (
  user_id,
  visibility,
  category,
  title,
  description,
  prompt,
  source_kind,
  generation_id,
  showcase_asset_path,
  output_url,
  save_count,
  remix_count,
  share_count,
  share_visit_count,
  created_at,
  updated_at
)
SELECT
  generations.user_id,
  'public',
  CASE
    WHEN generations.category IN ('image', 'video', 'motion', 'ugc-ad') THEN generations.category
    WHEN generations.model = 'kling-3.0/video' OR generations.model LIKE '%/video' THEN 'video'
    WHEN generations.model LIKE 'kling-%' THEN 'motion'
    ELSE 'image'
  END,
  generations.title,
  COALESCE(generations.description, ''),
  generations.prompt,
  'ugc_copy',
  generations.id,
  generations.showcase_asset_path,
  generations.output_url,
  COALESCE(generations.save_count, 0),
  COALESCE(generations.remix_count, 0),
  COALESCE(generations.share_count, 0),
  COALESCE(generations.share_visit_count, 0),
  generations.created_at,
  generations.created_at
FROM public.generations
WHERE generations.is_public = true
  AND generations.status = 'succeeded'
  AND (generations.category IS NULL OR generations.category <> 'audio')
ON CONFLICT (generation_id) DO UPDATE
SET
  visibility = EXCLUDED.visibility,
  category = EXCLUDED.category,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  prompt = EXCLUDED.prompt,
  showcase_asset_path = EXCLUDED.showcase_asset_path,
  output_url = EXCLUDED.output_url,
  save_count = EXCLUDED.save_count,
  remix_count = EXCLUDED.remix_count,
  share_count = EXCLUDED.share_count,
  share_visit_count = EXCLUDED.share_visit_count,
  updated_at = timezone('utc'::text, now());

INSERT INTO public.post_saves (user_id, post_id, created_at)
SELECT
  showcase_saves.user_id,
  posts.id,
  showcase_saves.created_at
FROM public.showcase_saves
JOIN public.posts
  ON posts.generation_id = showcase_saves.generation_id
ON CONFLICT (user_id, post_id) DO NOTHING;

UPDATE public.posts
SET save_count = 0
WHERE generation_id IS NOT NULL;

UPDATE public.posts
SET save_count = counts.save_count
FROM (
  SELECT post_id, COUNT(*)::integer AS save_count
  FROM public.post_saves
  GROUP BY post_id
) AS counts
WHERE counts.post_id = posts.id;
