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

/** Rows read a page; a run reads page after page until the outbox is empty or its time is spent. */
export const UPLOADED_MEDIA_MAINTENANCE_PAGE_SIZE = 20;
/**
 * Each page is a few Storage calls a row. The job shares its function (300 s)
 * with the showcase revocations it runs first, so this stays well inside what
 * they leave; a page started is always finished.
 */
export const UPLOADED_MEDIA_MAINTENANCE_TIME_BUDGET_MS = 60_000;

/** Small Storage operations only; encoding remains in dedicated media jobs. */
export async function processUploadedMediaMaintenance(
  client: SupabaseClient,
  {
    timeBudgetMs = UPLOADED_MEDIA_MAINTENANCE_TIME_BUDGET_MS,
    clock = Date.now,
  }: { timeBudgetMs?: number; clock?: () => number } = {},
) {
  const result = { revokedPublicCopies: 0, removedPrivateObjects: 0, retainedPrivateObjects: 0 };
  const startedAt = clock();
  const timeLeft = () => clock() - startedAt < timeBudgetMs;
  // Every processed row leaves the page it came from (revoked, or its ticket
  // deleted) and any failure throws, so each page reads rows not read before.
  for (let page = 0; page === 0 || timeLeft(); page += 1) {
    const processed = await revokePublicCopies(client, result);
    if (processed < UPLOADED_MEDIA_MAINTENANCE_PAGE_SIZE) break;
  }
  for (let page = 0; page === 0 || timeLeft(); page += 1) {
    const processed = await removePrivateObjects(client, result);
    if (processed < UPLOADED_MEDIA_MAINTENANCE_PAGE_SIZE) break;
  }
  return result;
}

type UploadedMediaMaintenanceResult = {
  revokedPublicCopies: number;
  removedPrivateObjects: number;
  retainedPrivateObjects: number;
};

async function revokePublicCopies(client: SupabaseClient, result: UploadedMediaMaintenanceResult): Promise<number> {
  const copies = await client.from('uploaded_media_private_copies').select('public_path,private_path')
    .is('revoked_at', null).order('copied_at').limit(UPLOADED_MEDIA_MAINTENANCE_PAGE_SIZE);
  if (copies.error) throw copies.error;
  for (const row of copies.data ?? []) {
    const path = parseCanonicalStorageObjectPath(row.public_path);
    if (path !== row.public_path || parseCanonicalStorageObjectPath(row.private_path) !== row.private_path || !row.private_path.startsWith('private-posts/') || !(path?.startsWith('posts/') || path?.startsWith('showcase/'))) {
      throw new Error('Invalid private-copy revocation');
    }
    // The atomic commit verified the copy and rewrote live descriptors before
    // this row became visible. Never remove a source ahead of that commit.
    await removeVerified(client, 'showcase_media', path);
    const updated = await client.from('uploaded_media_private_copies').update({ revoked_at: new Date().toISOString() }).eq('public_path', path);
    if (updated.error) throw updated.error;
    result.revokedPublicCopies += 1;
  }
  return (copies.data ?? []).length;
}

async function removePrivateObjects(client: SupabaseClient, result: UploadedMediaMaintenanceResult): Promise<number> {
  const cleanup = await client.from('post_media_object_cleanup').select('storage_path').order('created_at')
    .limit(UPLOADED_MEDIA_MAINTENANCE_PAGE_SIZE);
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
  return (cleanup.data ?? []).length;
}
