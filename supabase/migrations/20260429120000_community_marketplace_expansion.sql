ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS source_tool_slug text,
  ADD COLUMN IF NOT EXISTS report_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'visible' CHECK (review_status IN ('visible', 'flagged', 'hidden')),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

UPDATE public.posts
SET source_tool_slug = lower(regexp_replace(trim(source_tool), '[^a-z0-9]+', '-', 'g'))
WHERE source_tool IS NOT NULL
  AND trim(source_tool) <> ''
  AND source_tool_slug IS NULL;

CREATE INDEX IF NOT EXISTS posts_public_review_recent_idx
  ON public.posts (visibility, review_status, created_at DESC, id DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS posts_public_tool_recent_idx
  ON public.posts (source_tool_slug, created_at DESC, id DESC)
  WHERE visibility = 'public' AND review_status <> 'hidden' AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS posts_public_category_tool_recent_idx
  ON public.posts (category, source_tool_slug, created_at DESC, id DESC)
  WHERE visibility = 'public' AND review_status <> 'hidden' AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.post_reports (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  bundle_id uuid REFERENCES public.post_resource_bundles(id) ON DELETE SET NULL,
  reporter_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (reason IN ('spam', 'stolen_content', 'misleading_unlock', 'unsafe_content', 'payment_issue', 'other')),
  details text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS post_reports_post_created_idx
  ON public.post_reports (post_id, created_at DESC);

CREATE INDEX IF NOT EXISTS post_reports_status_created_idx
  ON public.post_reports (status, created_at DESC);

ALTER TABLE public.post_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can insert post reports" ON public.post_reports;
CREATE POLICY "Users can insert post reports"
  ON public.post_reports FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = reporter_user_id);

DROP POLICY IF EXISTS "Users can view their own post reports" ON public.post_reports;
CREATE POLICY "Users can view their own post reports"
  ON public.post_reports FOR SELECT TO authenticated
  USING (auth.uid() = reporter_user_id);

DROP TRIGGER IF EXISTS post_reports_set_updated_at ON public.post_reports;
CREATE TRIGGER post_reports_set_updated_at
BEFORE UPDATE ON public.post_reports
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at_column();

CREATE OR REPLACE FUNCTION public.validate_post_report_bundle_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.bundle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.post_resource_bundles
    WHERE id = NEW.bundle_id
      AND post_id = NEW.post_id
  ) THEN
    RAISE EXCEPTION 'Reported bundle must belong to reported post'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS post_reports_validate_bundle_match ON public.post_reports;
CREATE TRIGGER post_reports_validate_bundle_match
BEFORE INSERT OR UPDATE OF post_id, bundle_id ON public.post_reports
FOR EACH ROW
EXECUTE FUNCTION public.validate_post_report_bundle_match();

CREATE OR REPLACE FUNCTION public.increment_post_report_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.posts
  SET report_count = report_count + 1,
      review_status = CASE
        WHEN review_status = 'visible' THEN 'flagged'
        ELSE review_status
      END
  WHERE id = NEW.post_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS post_reports_increment_count ON public.post_reports;
CREATE TRIGGER post_reports_increment_count
AFTER INSERT ON public.post_reports
FOR EACH ROW
EXECUTE FUNCTION public.increment_post_report_count();

INSERT INTO storage.buckets (id, name, public)
VALUES ('post_resource_files', 'post_resource_files', false)
ON CONFLICT (id) DO UPDATE
SET public = false;
