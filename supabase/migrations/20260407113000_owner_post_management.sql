ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS posts_owner_archived_created_idx
  ON public.posts (user_id, archived_at, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS generations_owner_archived_created_idx
  ON public.generations (user_id, archived_at, created_at DESC, id DESC);

DROP POLICY IF EXISTS "Posts are viewable by owner or public" ON public.posts;
CREATE POLICY "Posts are viewable by owner or public"
  ON public.posts FOR SELECT TO public
  USING (
    auth.uid() = user_id
    OR (
      archived_at IS NULL
      AND visibility IN ('public', 'unlisted')
    )
  );

CREATE TABLE IF NOT EXISTS public.post_deletion_audits (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id uuid,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  generation_id uuid,
  title text NOT NULL DEFAULT 'Deleted post',
  visibility text NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private')),
  source_kind text NOT NULL CHECK (source_kind IN ('ugc_copy', 'external', 'manual')),
  bundle_access_mode text CHECK (bundle_access_mode IN ('free', 'paid')),
  bundle_status text CHECK (bundle_status IN ('draft', 'published')),
  bundle_price_usd_cents integer,
  bundle_resource_kinds jsonb NOT NULL DEFAULT '[]'::jsonb,
  sales_count integer NOT NULL DEFAULT 0,
  earnings_usd_cents integer NOT NULL DEFAULT 0,
  had_paid_orders boolean NOT NULL DEFAULT false,
  deleted_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT post_deletion_audits_resource_kinds_array_check CHECK (jsonb_typeof(bundle_resource_kinds) = 'array')
);

CREATE INDEX IF NOT EXISTS post_deletion_audits_owner_deleted_idx
  ON public.post_deletion_audits (owner_user_id, deleted_at DESC, id DESC);

ALTER TABLE public.post_deletion_audits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners can view their own post deletion audits" ON public.post_deletion_audits;
CREATE POLICY "Owners can view their own post deletion audits"
  ON public.post_deletion_audits FOR SELECT TO authenticated
  USING (auth.uid() = owner_user_id);

DROP POLICY IF EXISTS "Owners can insert their own post deletion audits" ON public.post_deletion_audits;
CREATE POLICY "Owners can insert their own post deletion audits"
  ON public.post_deletion_audits FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = owner_user_id);
