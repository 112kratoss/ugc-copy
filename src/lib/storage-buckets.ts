/**
 * Every Storage bucket the migrations create, held to them by
 * `storage-buckets.test.ts`: a bucket a migration adds fails that test until it
 * is listed here, so the cost report and the orphan listing see it from day one.
 *
 * No `server-only` marker: the ops CLIs load this under tsx.
 */
export const STORAGE_BUCKET_IDS = [
  'generated_images',
  'generated_videos',
  'generated_audio',
  'generation_inputs',
  'uploads',
  'showcase_media',
  'post_media',
  'post_resource_files',
  'profiles',
  'template_inputs',
  'template_assets',
] as const;

export type StorageBucketId = (typeof STORAGE_BUCKET_IDS)[number];
