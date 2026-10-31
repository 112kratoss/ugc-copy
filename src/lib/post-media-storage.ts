import type { SupabaseClient } from '@supabase/supabase-js';

/** The namespace is persisted with the path, including deletion manifests. */
export const PRIVATE_POST_MEDIA_BUCKET = 'post_media';
export const PRIVATE_POST_MEDIA_PREFIX = 'private-posts/';

/** Every column of a post_media row that names a stored object. */
export const POST_MEDIA_PATH_COLUMNS = [
  'storage_path',
  'preview_storage_path',
  'display_storage_path',
  'rendition_storage_path',
  'teaser_storage_path',
] as const;

export type PostMediaPathColumn = (typeof POST_MEDIA_PATH_COLUMNS)[number];

export function postMediaStorageBucket(path: string): 'post_media' | 'showcase_media' {
  return path.startsWith(PRIVATE_POST_MEDIA_PREFIX) ? PRIVATE_POST_MEDIA_BUCKET : 'showcase_media';
}

export function postMediaReadUrl(client: SupabaseClient, path: string): string {
  return postMediaStorageBucket(path) === PRIVATE_POST_MEDIA_BUCKET
    ? `/api/media?${new URLSearchParams({ bucket: PRIVATE_POST_MEDIA_BUCKET, path })}`
    : client.storage.from('showcase_media').getPublicUrl(path).data.publicUrl;
}

export function groupPostMediaPaths(paths: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of new Set(paths)) {
    const bucket = postMediaStorageBucket(path);
    const group = groups.get(bucket) ?? [];
    group.push(path);
    groups.set(bucket, group);
  }
  return groups;
}

/** Retain Supabase's result shape for existing cleanup callers. */
export async function removePostMediaObjects(client: SupabaseClient, paths: string[]) {
  for (const [bucket, objects] of groupPostMediaPaths(paths)) {
    const result = await client.storage.from(bucket).remove(objects);
    if (result.error) return result;
  }
  return { data: [], error: null };
}
