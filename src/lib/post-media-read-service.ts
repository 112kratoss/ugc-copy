import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';
import { parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';
import { PRIVATE_POST_MEDIA_PREFIX, postMediaStorageBucket } from '@/lib/post-media-storage';

/**
 * Authorization is never cached: every read asks `resolve_post_media_read` for
 * this viewer, and a refusal is answered at once. What is reused is the Storage
 * capability minted after that answer, and how long it lives depends on who
 * else may read the same media right now.
 *
 * A post's own media (`private-posts/`) that the function also serves to
 * someone signed out (a public or unlisted post's, visible, not archived, not
 * tombstoned, not marked NSFW, its owner active) is the same object for
 * everyone. Its signature lasts 15 minutes and is handed out again only while
 * at least 5 of them are left, and the viewer's own browser may keep the
 * redirect until 2 minutes before the signature ends. So once such a post
 * leaves public view (hidden, archived, made private, marked NSFW, its owner
 * deleting), a link already handed out keeps working for at most 15 minutes,
 * and a kept redirect for at most about 13; a new read is refused at once. A
 * take-down deletes the objects, which ends every link.
 *
 * Everything else (an owner's private, archived or NSFW post, a reveal-only
 * read, and every alias under `posts/` or `showcase/`, which only purchase
 * snapshots carry) keeps the 120-second signature, reused for 60 s, behind a
 * redirect no cache may keep: a retracted purchase or a post taken down stops
 * being served at the next request.
 */
const RESTRICTED_SIGNATURE_TTL_SECONDS = 120;
const RESTRICTED_SIGNATURE_REUSE_MS = 60_000;
export const PUBLIC_POST_MEDIA_SIGNATURE_TTL_SECONDS = 15 * 60;
/** A public signature is handed out again only while at least this much of it is left. */
const PUBLIC_SIGNATURE_MIN_REMAINING_MS = 5 * 60_000;
/** A kept redirect ends this long before its signature, so a clip started from it can still play. */
const PUBLIC_BROWSER_CACHE_MARGIN_MS = 2 * 60_000;
/** A redirect that could be kept for less than this is not kept at all. */
const MIN_BROWSER_CACHE_SECONDS = 60;
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

/**
 * The answer for someone signed out, asked only to decide how long a
 * capability may live. A failure leaves the read restricted, never refused,
 * and is logged so a classification that keeps failing is seen.
 */
async function resolveSignedOutRead(admin: SupabaseClient, path: string): Promise<string | null> {
  try {
    return await resolvePostMediaRead(admin, path, null);
  } catch (error) {
    logBackendError('post_media_public_classification_failed', { error });
    return null;
  }
}

function signatureTimes(access: PostMediaAccess, signedAt: number) {
  if (access === 'restricted') {
    return {
      expiresAt: signedAt + RESTRICTED_SIGNATURE_TTL_SECONDS * 1000,
      reusableUntil: signedAt + RESTRICTED_SIGNATURE_REUSE_MS,
    };
  }
  const expiresAt = signedAt + PUBLIC_POST_MEDIA_SIGNATURE_TTL_SECONDS * 1000;
  return { expiresAt, reusableUntil: expiresAt - PUBLIC_SIGNATURE_MIN_REMAINING_MS };
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

function browserCacheSeconds(signature: Signature, now: number): number {
  const seconds = Math.floor((signature.expiresAt - PUBLIC_BROWSER_CACHE_MARGIN_MS - now) / 1000);
  return seconds >= MIN_BROWSER_CACHE_SECONDS ? seconds : 0;
}

export async function readPostMedia({ admin, path, viewerUserId, now = Date.now }: {
  admin: SupabaseClient; path: string; viewerUserId: string | null; now?: () => number;
}): Promise<PostMediaRead | null> {
  // Only a post's own media path can be public: an alias is a purchase
  // snapshot's, and the database answers one by a looser rule than the
  // private path it names.
  const canBePublic = path.startsWith(PRIVATE_POST_MEDIA_PREFIX);
  // Access is the viewer's own answer alone. The signed-out answer runs beside
  // it only to classify the read; signed out, the one answer is both.
  const [resolvedPath, signedOutPath] = await Promise.all([
    resolvePostMediaRead(admin, path, viewerUserId),
    viewerUserId !== null && canBePublic ? resolveSignedOutRead(admin, path) : null,
  ]);
  if (!resolvedPath) return null;

  const access: PostMediaAccess = canBePublic && resolvedPath === path
    && (viewerUserId === null || signedOutPath === path)
    ? 'public'
    : 'restricted';
  // Kept apart by access: a restricted read never receives a public signature,
  // even for an object that was public a moment ago.
  const signature = await signPostMedia({ admin, access, key: `${access}:${resolvedPath}`, now, resolvedPath });
  return {
    signedUrl: signature.url,
    browserCacheSeconds: access === 'public' ? browserCacheSeconds(signature, now()) : 0,
  };
}
