import type { SupabaseClient } from '@supabase/supabase-js';
import { parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';

export async function hasPendingUploadedMediaMaintenance(client: SupabaseClient): Promise<boolean> {
  const [copies, cleanup] = await Promise.all([
    client.from('uploaded_media_private_copies').select('public_path').is('revoked_at', null).limit(1),
    client.from('post_media_object_cleanup').select('storage_path').limit(1),
  ]);
  if (copies.error || cleanup.error) throw copies.error ?? cleanup.error;
  return Boolean(copies.data?.length || cleanup.data?.length);
}

async function removeVerified(client: SupabaseClient, bucket: string, path: string) {
  const removed = await client.storage.from(bucket).remove([path]);
  if (removed.error) throw removed.error;
  const exists = await client.storage.from(bucket).exists(path);
  if (exists.data !== false) throw exists.error ?? new Error('Media object still exists after removal');
}

/** Small Storage operations only; encoding remains in dedicated media jobs. */
export async function processUploadedMediaMaintenance(client: SupabaseClient) {
  const result = { revokedPublicCopies: 0, removedPrivateObjects: 0, retainedPrivateObjects: 0 };
  const copies = await client.from('uploaded_media_private_copies').select('public_path,private_path')
    .is('revoked_at', null).order('copied_at').limit(20);
  if (copies.error) throw copies.error;
  for (const row of copies.data ?? []) {
    const path = parseCanonicalStorageObjectPath(row.public_path);
    if (path !== row.public_path || row.private_path !== `private-${path}` || !path?.startsWith('posts/')) {
      throw new Error('Invalid private-copy revocation');
    }
    // The atomic commit verified the copy and rewrote live descriptors before
    // this row became visible. Never remove a source ahead of that commit.
    await removeVerified(client, 'showcase_media', path);
    const updated = await client.from('uploaded_media_private_copies').update({ revoked_at: new Date().toISOString() }).eq('public_path', path);
    if (updated.error) throw updated.error;
    result.revokedPublicCopies += 1;
  }
  const cleanup = await client.from('post_media_object_cleanup').select('storage_path').order('created_at').limit(20);
  if (cleanup.error) throw cleanup.error;
  for (const row of cleanup.data ?? []) {
    const path = parseCanonicalStorageObjectPath(row.storage_path);
    if (path !== row.storage_path || !path?.startsWith('private-posts/')) throw new Error('Invalid private cleanup path');
    const reference = await client.rpc('private_post_media_is_referenced', { p_path: path });
    if (reference.error) throw reference.error;
    if (reference.data === false) {
      await removeVerified(client, 'post_media', path);
      result.removedPrivateObjects += 1;
    } else if (reference.data === true) result.retainedPrivateObjects += 1;
    else throw new Error('Unable to verify media references');
    const removed = await client.from('post_media_object_cleanup').delete().eq('storage_path', path);
    if (removed.error) throw removed.error;
  }
  return result;
}
