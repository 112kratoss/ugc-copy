-- ============================================================
-- Phase 1.2: Lock down file uploads
-- ============================================================

-- Drop the unsafe public policies on uploads bucket
DROP POLICY IF EXISTS "Public insert access" ON storage.objects;
DROP POLICY IF EXISTS "Public read access" ON storage.objects;

-- Only authenticated users can upload to their own folder
CREATE POLICY "Authenticated users can upload own files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can only read their own uploads
CREATE POLICY "Users can read own uploads"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );


-- ============================================================
-- Phase 1.3: Make generated media private + signed URLs
-- ============================================================

-- Make buckets private
UPDATE storage.buckets SET public = false WHERE id IN ('generated_videos', 'generated_images');

-- Drop public read policies for generated media
DROP POLICY IF EXISTS "Anyone can view generated videos." ON storage.objects;
DROP POLICY IF EXISTS "Public read access for generated images" ON storage.objects;

-- Users can read their own generated videos (scoped by userId folder prefix)
CREATE POLICY "Users can read own generated videos"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'generated_videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can read their own generated images (scoped by userId folder prefix)
CREATE POLICY "Users can read own generated images"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'generated_images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Update upload policies for generated media to require userId prefix
DROP POLICY IF EXISTS "Users can upload generated videos." ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload generated images" ON storage.objects;

CREATE POLICY "Authenticated users can upload own generated videos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'generated_videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Authenticated users can upload own generated images"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'generated_images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );


-- ============================================================
-- Phase 1.4: Restrict profile reads to own user only
-- ============================================================

DROP POLICY IF EXISTS "Public profiles are viewable by everyone." ON public.profiles;

CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = id);
