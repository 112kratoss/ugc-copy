import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Stage copies, commit their verified descriptors, then revoke public objects.
 * The durable ledger makes every step retryable without breaking live media. */
export async function secureNsfwPostMedia(client: SupabaseClient, postId: string, ownerId: string) {
  const { data: post, error } = await client.from('posts')
    .select('id, user_id, generation_id, showcase_asset_path').eq('id', postId).eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  if (!post) throw new Error('Post not found.');
  const media = await client.from('post_media').select('storage_path, preview_storage_path, display_storage_path, rendition_storage_path, teaser_storage_path, external_url').eq('post_id', postId);
  if (media.error) throw media.error;
  const columns = ['storage_path', 'preview_storage_path', 'display_storage_path', 'rendition_storage_path', 'teaser_storage_path'] as const;
  const rows = media.data ?? [];
  if (rows.some((row) => row.external_url)) throw new Error('Re-upload externally hosted media before marking this post NSFW.');
  const paths = new Set<string>([post.showcase_asset_path, ...rows.flatMap((row) => columns.map((key) => row[key]))]
    .filter((value): value is string => typeof value === 'string' && !value.startsWith('private-posts/')));
  const replacements = new Map<string, string>();
  for (const path of paths) {
    if (!path.startsWith(`posts/${postId}/`) && !(post.generation_id && path.startsWith(`showcase/${post.generation_id}/`))) throw new Error('Unsupported post media location.');
    const target = path.startsWith('posts/') ? `private-${path}`
      : `private-posts/${postId}/${createHash('sha256').update(path).digest('hex').slice(0, 16)}-${path.split('/').pop()}`;
    const copy = await client.storage.from('showcase_media').copy(path, target, { destinationBucket: 'post_media' });
    if (copy.error && !/already exists|duplicate/i.test(copy.error.message)) throw new Error('Could not secure this post’s media. Please retry.');
    const committed = await client.rpc('commit_nsfw_media_private_copy', {
      p_post_id: postId, p_owner_id: ownerId, p_public_path: path, p_private_path: target,
    });
    if (committed.error) throw committed.error;
    replacements.set(path, target);
  }
  // Includes copies committed by a previous request whose deletion failed.
  const pending = await client.from('uploaded_media_private_copies').select('public_path')
    .like('private_path', `private-posts/${postId}/%`).is('revoked_at', null);
  if (pending.error) throw pending.error;
  for (const { public_path: path } of pending.data ?? []) {
    const removed = await client.storage.from('showcase_media').remove([path]);
    if (removed.error) throw new Error('Could not revoke the public preview. Please retry.');
    const exists = await client.storage.from('showcase_media').exists(path);
    if (exists.error || exists.data !== false) throw new Error('Could not verify removal of the public preview. Please retry.');
    const settled = await client.from('uploaded_media_private_copies').update({ revoked_at: new Date().toISOString() }).eq('public_path', path);
    if (settled.error) throw settled.error;
  }
  return replacements;
}
