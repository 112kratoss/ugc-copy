import type { SupabaseClient } from '@supabase/supabase-js';
import { parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';
import { postMediaStorageBucket } from '@/lib/post-media-storage';

// Authorization is never cached. Reuse only the short-lived Storage capability
// after the database has checked the current post / immutable purchase snapshot.
const TTL_SECONDS = 120;
const MAX_SIGNATURES = 256;
const signatures = new Map<string, { url: string; until: number }>();
const pending = new Map<string, Promise<string>>();

export function parsePrivatePostMediaPath(value: string | null): string | null {
  if (!value) return null;
  const path = parseCanonicalStorageObjectPath(value, { minimumSegments: 3 });
  return path === value && (path.startsWith('private-posts/') || path.startsWith('posts/'))
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path.split('/')[1])
    ? path : null;
}

export async function readPostMedia({ admin, path, viewerUserId }: {
  admin: SupabaseClient; path: string; viewerUserId: string | null;
}): Promise<string | null> {
  const { data: resolvedPath, error } = await admin.rpc('resolve_post_media_read', {
    p_path: path, p_viewer_id: viewerUserId,
  });
  if (error) throw error;
  if (typeof resolvedPath !== 'string') return null;

  const key = resolvedPath;
  const cached = signatures.get(key);
  if (cached && cached.until > Date.now()) return cached.url;
  signatures.delete(key);
  const existing = pending.get(key);
  if (existing) return existing;
  const signing = (async () => {
    const result = await admin.storage.from(postMediaStorageBucket(resolvedPath)).createSignedUrl(resolvedPath, TTL_SECONDS);
    if (result.error || !result.data?.signedUrl) throw result.error ?? new Error('Media signing failed');
    signatures.set(key, { url: result.data.signedUrl, until: Date.now() + 60_000 });
    while (signatures.size > MAX_SIGNATURES) signatures.delete(signatures.keys().next().value!);
    return result.data.signedUrl;
  })();
  if (pending.size < MAX_SIGNATURES) pending.set(key, signing);
  try { return await signing; } finally {
    if (pending.get(key) === signing) pending.delete(key);
  }
}
