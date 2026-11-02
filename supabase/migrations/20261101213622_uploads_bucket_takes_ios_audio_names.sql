-- An iPhone's .m4a and .wav tracks reach the uploads bucket under the names its
-- picker gives them.
--
-- The app's document picker reports UTType(filenameExtension:).preferredMIMEType,
-- which is audio/x-m4a for an .m4a (Voice Memos, most phone recordings) and
-- audio/vnd.wave for a .wav. The sign step now reads each as its listed type
-- (audio/mp4, audio/wav) and answers with that name, but an app installed before
-- that answer existed sends the file under its picker's name, and Storage judges
-- the upload's own content-type header against this list. Without these two
-- names such an upload is refused ("mime type audio/x-m4a is not supported")
-- even though the sign step took it.
--
-- Only uploads changes: it is where installed apps send a track under their
-- picker's name. Into the other buckets the server writes listed names, and
-- clients either send the type their signer answers with (the web workflow
-- uploader) or upload types no alias covers (profile pictures). The list is
-- STORAGE_BUCKET_ALLOWED_MIME_TYPES.uploads in src/lib/storage-upload-mime-policy.ts,
-- and uploads-bucket-ios-audio-names-migration.test.ts holds the two equal.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
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
  'audio/webm',
  'audio/x-m4a',
  'audio/vnd.wave'
]::text[]
WHERE id = 'uploads';
