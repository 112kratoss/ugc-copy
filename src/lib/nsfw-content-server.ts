import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function loadNsfwPostIds(client: SupabaseClient, postIds: string[]): Promise<Set<string>> {
  if (!postIds.length) return new Set();
  const { data, error } = await client.from('posts').select('id, is_nsfw').in('id', postIds);
  // Schema/configuration failures must not silently remove a content warning.
  if (error) throw error;
  return new Set((data ?? []).filter((row) => row.is_nsfw === true).map((row) => row.id));
}

export async function hasNsfwReveal(client: SupabaseClient, postId: string, viewerId: string | null): Promise<boolean> {
  if (!viewerId) return false;
  const { data, error } = await client.rpc('has_nsfw_reveal', { p_post_id: postId, p_viewer_id: viewerId });
  if (error) throw error;
  return data === true;
}
