import type { SupabaseClient } from '@supabase/supabase-js';
import { parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';
import { postMediaStorageBucket } from '@/lib/post-media-storage';

/**
 * Authorization is never cached: every read asks `resolve_post_media_read` for
 * this viewer, and a refusal is answered at once. What is reused is the Storage
 * capability minted after that answer, and how long it lives depends on who
 * else may read the same media right now.
 *
 * Media the function serves to someone signed out (a public or unlisted post's,
 * visible, not archived, not tombstoned, not marked NSFW, its owner active) is
 * the same object for everyone. Its signature lasts an hour and is handed out
 * again for its first 45 minutes, and the viewer's own browser may keep the
 * redirect until ten minutes before the signature ends, so the views after the
 * first reach neither this function nor the database.
 *
 * Everything else (an owner's private, archived or NSFW post, a buyer's
 * purchase snapshot, a post someone may read only after a reveal) keeps the
 * 120-second signature, reused for 60 s, behind a redirect no cache may keep:
 * a retracted purchase or a post taken down stops being served at the next
 * request.
 */
const RESTRICTED_SIGNATURE_TTL_SECONDS = 120;
const RESTRICTED_SIGNATURE_REUSE_MS = 60_000;
export const PUBLIC_POST_MEDIA_SIGNATURE_TTL_SECONDS = 3600;
/**
 * The least life a public redirect ever hands out: a clip started from a kept
 * redirect still has this long to play and seek, and it absorbs clock skew.
 */
const PUBLIC_SIGNATURE_PLAYBACK_MARGIN_MS = 10 * 60_000;
/** A public signature is handed out again only while a browser could keep it this long. */
const PUBLIC_MIN_BROWSER_CACHE_MS = 5 * 60_000;
const MAX_SIGNATURES = 256;

type PostMediaAccess = 'public' | 'restricted';
type Signature = { url: string; expiresAt: number; reusableUntil: number };

const signatures = new Map<string, Signature>();
const pending = new Map<string, Promise<Signature>>();

export type PostMediaRead = {
  signedUrl: string;
  /** How long the viewer's own browser may keep the redirect; 0: it must not keep it. */
  browserCacheSeconds: number;
};

/** Test seam: signatures are kept per process, so a test must be able to start clean. */
export function resetPostMediaSignaturesForTests(): void {
  signatures.clear();
  pending.clear();
}

export function parsePrivatePostMediaPath(value: string | null): string | null {
  if (!value) return null;
  const path = parseCanonicalStorageObjectPath(value, { minimumSegments: 3 });
  return path === value && (path.startsWith('private-posts/') || path.startsWith('posts/') || path.startsWith('showcase/'))
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path.split('/')[1])
    ? path : null;
}

async function resolvePostMediaRead(admin: SupabaseClient, path: string, viewerUserId: string | null) {
  const { data, error } = await admin.rpc('resolve_post_media_read', {
    p_path: path, p_viewer_id: viewerUserId,
  });
  if (error) throw error;
  return typeof data === 'string' ? data : null;
}

function signatureTimes(access: PostMediaAccess, signedAt: number) {
  if (access === 'restricted') {
    return {
      expiresAt: signedAt + RESTRICTED_SIGNATURE_TTL_SECONDS * 1000,
      reusableUntil: signedAt + RESTRICTED_SIGNATURE_REUSE_MS,
    };
  }
  const expiresAt = signedAt + PUBLIC_POST_MEDIA_SIGNATURE_TTL_SECONDS * 1000;
  return {
    expiresAt,
    reusableUntil: expiresAt - PUBLIC_SIGNATURE_PLAYBACK_MARGIN_MS - PUBLIC_MIN_BROWSER_CACHE_MS,
  };
}

function readCachedSignature(key: string, now: number): Signature | null {
  const cached = signatures.get(key);
  if (!cached) return null;
  signatures.delete(key);
  if (cached.reusableUntil <= now) return null;
  // Re-inserted so the eviction below drops the coldest entry.
  signatures.set(key, cached);
  return cached;
}

function storeSignature(key: string, signature: Signature): void {
  signatures.set(key, signature);
  while (signatures.size > MAX_SIGNATURES) signatures.delete(signatures.keys().next().value!);
}

async function signPostMedia({ admin, access, key, now, resolvedPath }: {
  admin: SupabaseClient;
  access: PostMediaAccess;
  key: string;
  now: () => number;
  resolvedPath: string;
}): Promise<Signature> {
  const cached = readCachedSignature(key, now());
  if (cached) return cached;
  const existing = pending.get(key);
  if (existing) return existing;
  const signing = (async () => {
    // Dated from before the request, so the expiry reckoned here is never
    // later than the one Storage writes into the token.
    const signedAt = now();
    const ttlSeconds = access === 'public' ? PUBLIC_POST_MEDIA_SIGNATURE_TTL_SECONDS : RESTRICTED_SIGNATURE_TTL_SECONDS;
    const result = await admin.storage.from(postMediaStorageBucket(resolvedPath)).createSignedUrl(resolvedPath, ttlSeconds);
    if (result.error || !result.data?.signedUrl) throw result.error ?? new Error('Media signing failed');
    const signature = { url: result.data.signedUrl, ...signatureTimes(access, signedAt) };
    storeSignature(key, signature);
    return signature;
  })();
  if (pending.size < MAX_SIGNATURES) pending.set(key, signing);
  try { return await signing; } finally {
    if (pending.get(key) === signing) pending.delete(key);
  }
}

export async function readPostMedia({ admin, path, viewerUserId, now = Date.now }: {
  admin: SupabaseClient; path: string; viewerUserId: string | null; now?: () => number;
}): Promise<PostMediaRead | null> {
  // The viewer's own answer authorizes the read, and a refusal goes back at once.
  const resolvedPath = await resolvePostMediaRead(admin, path, viewerUserId);
  if (!resolvedPath) return null;
  // The answer for no viewer is asked only of a read already allowed, and only
  // to decide how long its capability may live: a failure there leaves the read
  // restricted, never refused. A signed-out read is its own answer.
  const publicPath = viewerUserId === null
    ? resolvedPath
    : await resolvePostMediaRead(admin, path, null).catch(() => null);

  const access: PostMediaAccess = publicPath === resolvedPath ? 'public' : 'restricted';
  // Kept apart by access: a restricted read never receives an hour-long
  // capability, even for an object that was public a moment ago.
  const signature = await signPostMedia({ admin, access, key: `${access}:${resolvedPath}`, now, resolvedPath });
  return {
    signedUrl: signature.url,
    browserCacheSeconds: access === 'public'
      ? Math.max(0, Math.floor((signature.expiresAt - PUBLIC_SIGNATURE_PLAYBACK_MARGIN_MS - now()) / 1000))
      : 0,
  };
}
