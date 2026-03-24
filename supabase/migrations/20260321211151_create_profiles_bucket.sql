-- Create public 'profiles' bucket for avatars and cover banners
insert into storage.buckets (id, name, public)
values ('profiles', 'profiles', true)
on conflict (id) do update set public = true;

-- Public read access
DROP POLICY IF EXISTS "Public read access for profiles" ON storage.objects;
CREATE POLICY "Public read access for profiles"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'profiles');

-- Authenticated users can upload to their own folder within profiles bucket
DROP POLICY IF EXISTS "Authenticated users can upload own profile media" ON storage.objects;
CREATE POLICY "Authenticated users can upload own profile media"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'profiles'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Authenticated users can update own profile media
DROP POLICY IF EXISTS "Authenticated users can update own profile media" ON storage.objects;
CREATE POLICY "Authenticated users can update own profile media"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'profiles'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'profiles'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Authenticated users can delete own profile media
DROP POLICY IF EXISTS "Authenticated users can delete own profile media" ON storage.objects;
CREATE POLICY "Authenticated users can delete own profile media"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'profiles'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
