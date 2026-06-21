UPDATE storage.buckets
SET public = true,
    file_size_limit = 5242880
WHERE id = 'profiles';

DROP POLICY IF EXISTS "Public read access for profiles" ON storage.objects;

DROP POLICY IF EXISTS "Authenticated users can read own profile media" ON storage.objects;
CREATE POLICY "Authenticated users can read own profile media"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'profiles'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

DROP POLICY IF EXISTS "Authenticated users can upload own profile media" ON storage.objects;
CREATE POLICY "Authenticated users can upload own profile media"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'profiles'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

DROP POLICY IF EXISTS "Authenticated users can update own profile media" ON storage.objects;
CREATE POLICY "Authenticated users can update own profile media"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'profiles'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'profiles'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

DROP POLICY IF EXISTS "Authenticated users can delete own profile media" ON storage.objects;
CREATE POLICY "Authenticated users can delete own profile media"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'profiles'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
