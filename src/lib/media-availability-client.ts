/**
 * Whether media a feed failed to load is gone for this viewer, asked of the
 * failed address itself: an image or video error says nothing of why it
 * failed, and the post may have left public reading while the feed was open.
 * The address's own server applies whatever rules end that reading, so this
 * asks no rule of its own:
 *
 * - `/api/media` answers 404 to a read the post no longer allows: archived,
 *   made private, hidden, marked NSFW, its owner no longer active
 *   (`post-media-read-service.ts`), never cached.
 * - Storage answers 400 (NoSuchKey) for a public copy removed when its post's
 *   public reading ended (`public-posts/`, #908), or any object deleted.
 *
 * - `gone`: 400, 404 or 410. The feed removes the card.
 * - `readable`: the file answers, or the media route would redirect to it, so
 *   the failure was the network's or the browser's; the card offers a retry.
 * - `unknown`: any other status (a refused session, a busy server), offline,
 *   or no answer within `MEDIA_AVAILABILITY_TIMEOUT_MS`. Treated as
 *   `readable`: a card is never removed on a guess, and a feed is never
 *   emptied because a session was refused.
 */
export type MediaAvailability = 'gone' | 'readable' | 'unknown';

export const MEDIA_AVAILABILITY_TIMEOUT_MS = 8_000;

const GONE_STATUSES = new Set([400, 404, 410]);

type CheckMediaAvailabilityOptions = {
  fetchImpl?: typeof fetch;
};

// One question per address at a time: a slide and its retry can fail in a row.
const pending = new Map<string, Promise<MediaAvailability>>();

async function askAddress(url: string, fetchImpl: typeof fetch): Promise<MediaAvailability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_AVAILABILITY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { cache: 'no-store', redirect: 'manual', signal: controller.signal });
    // Only the status is wanted: a file that answers is not read.
    void response.body?.cancel().catch(() => undefined);
    if (response.type === 'opaqueredirect' || response.ok) return 'readable';
    return GONE_STATUSES.has(response.status) ? 'gone' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

export function checkMediaAvailability(
  url: string,
  { fetchImpl = fetch }: CheckMediaAvailabilityOptions = {},
): Promise<MediaAvailability> {
  const existing = pending.get(url);
  if (existing) return existing;
  const answer = askAddress(url, fetchImpl).finally(() => {
    pending.delete(url);
  });
  pending.set(url, answer);
  return answer;
}
