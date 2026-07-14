-- Backend-owned generation state must never be writable through the public
-- Data API. User-facing mutations go through authenticated Vercel services and
-- narrowly-scoped service-role RPCs instead.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.generations FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "Users can create own ordinary generations" ON public.generations;
DROP POLICY IF EXISTS "Users can update own ordinary generations" ON public.generations;
DROP POLICY IF EXISTS "Users can create own generations" ON public.generations;
DROP POLICY IF EXISTS "Users can update own generations" ON public.generations;
DROP POLICY IF EXISTS "Users can insert their own generations." ON public.generations;
DROP POLICY IF EXISTS "Users can update their own generations." ON public.generations;

-- Input-media rows contain storage capabilities. Allowing clients to write an
-- arbitrary storage_path lets a service-role reader become a signing deputy.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.generation_input_media FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "Users can insert own generation input media" ON public.generation_input_media;
DROP POLICY IF EXISTS "Users can update own generation input media" ON public.generation_input_media;
DROP POLICY IF EXISTS "Users can delete own generation input media" ON public.generation_input_media;

-- Uploads are issued through short-lived signed upload intents. Remove the
-- parallel direct-Storage write path that bypassed application validation.
DROP POLICY IF EXISTS "Authenticated users can upload own files" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload own generated videos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload own generated images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload own generated audio" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own generated videos" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload own generation inputs" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own generation inputs" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own generation inputs" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload own profile media" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update own profile media" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete own profile media" ON storage.objects;

-- Retain bucket-side enforcement even when a signed upload token is used.
UPDATE storage.buckets
SET file_size_limit = 262144000,
    allowed_mime_types = ARRAY[
      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif',
      'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
      'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/ogg', 'audio/webm'
    ]::text[]
WHERE id IN ('uploads', 'generation_inputs');

UPDATE storage.buckets
SET file_size_limit = 26214400,
    allowed_mime_types = ARRAY[
      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif'
    ]::text[]
WHERE id = 'generated_images';

UPDATE storage.buckets
SET file_size_limit = 262144000,
    allowed_mime_types = ARRAY['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']::text[]
WHERE id = 'generated_videos';

UPDATE storage.buckets
SET file_size_limit = 52428800,
    allowed_mime_types = ARRAY[
      'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/ogg', 'audio/webm'
    ]::text[]
WHERE id = 'generated_audio';

UPDATE storage.buckets
SET file_size_limit = 5242880,
    allowed_mime_types = ARRAY[
      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif'
    ]::text[]
WHERE id = 'profiles';
