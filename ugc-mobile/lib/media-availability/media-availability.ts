/**
 * Whether media a feed failed to load is gone for this viewer, asked of the
 * failed address itself, by the web's Home feed and the app's. An image error
 * says nothing of why it failed, and the post may have left public reading
 * while the feed was open (or, in the app, since the launch whose first page
 * was kept on the device). The address's own server applies whatever rules
 * end that reading, so this asks no rule of its own:
 *
 * - `/api/media` answers 404 to a read the post no longer allows: archived,
 *   made private, hidden, marked NSFW, its owner no longer active
 *   (`src/lib/post-media-read-service.ts`), never cached.
 * - Storage answers every error but a 500 as HTTP 400, the real status in
 *   its JSON body: a public copy removed when its post's public reading ended
 *   (`public-posts/`, #908), or any object deleted, is `"statusCode":"404"`
 *   (NoSuchKey), and a busy database is `"544"` (DatabaseTimeout).
 *
 * - `gone`: 404 or 410, or a 400 whose body says 404. The feed removes the card.
 * - `readable`: the file answers, or the media route would redirect to it, so
 *   the failure was the network's or the device's; the card offers a retry.
 * - `unknown`: anything else (a refused session, a busy server, a 400 that
 *   does not say 404), offline, or no answer within
 *   `MEDIA_AVAILABILITY_TIMEOUT_MS`. Treated as `readable`: a card is never
 *   removed on a guess, and a feed is never emptied by a refused session or
 *   a Storage incident.
 *
 * Only one byte is asked for (`Range`), so a readable original, up to tens of
 * megabytes, is not downloaded to learn that it is there. The app passes the
 * headers its image request carried (the session, for `/api/media`), so the
 * answer is the one the image got. React Native's fetch follows a redirect
 * whatever `redirect` says and adds a `_` parameter for `no-store`; the media
 * route reads only its own parameters, and a followed redirect answers 206.
 *
 * Shared with the web by relative import: no React Native, Expo or Node imports.
 */
export type MediaAvailability = 'gone' | 'readable' | 'unknown';

export const MEDIA_AVAILABILITY_TIMEOUT_MS = 8_000;

const GONE_STATUSES = new Set([404, 410]);

/** Storage's 400: gone only when its body names a 404 (NoSuchKey, NoSuchBucket). */
async function storageSaysNotFound(response: Response): Promise<boolean> {
  try {
    const body = await response.json() as { statusCode?: unknown };
    return String(body?.statusCode) === '404';
  } catch {
    return false;
  }
}

export type CheckMediaAvailabilityOptions = {
  fetchImpl?: typeof fetch;
  /** Sent with the request, as the failed load sent them (the app's session for `/api/media`). */
  headers?: Record<string, string>;
};

// One question per address and headers at a time: a slide and its retry can
// fail in a row. Asked with other headers (another session), it is another
// question, since the answer depends on who asks.
const pending = new Map<string, Promise<MediaAvailability>>();

function questionKey(url: string, headers: Record<string, string> | undefined) {
  if (!headers) return url;
  const sorted = Object.keys(headers).sort().map((name) => [name.toLowerCase(), headers[name]]);
  return `${url}\n${JSON.stringify(sorted)}`;
}

async function askAddress(
  url: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string> | undefined,
): Promise<MediaAvailability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_AVAILABILITY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      redirect: 'manual',
      headers: { ...headers, Range: 'bytes=0-0' },
      signal: controller.signal,
    });
    if (response.status === 400) return await storageSaysNotFound(response) ? 'gone' : 'unknown';
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
  { fetchImpl = fetch, headers }: CheckMediaAvailabilityOptions = {},
): Promise<MediaAvailability> {
  const key = questionKey(url, headers);
  const existing = pending.get(key);
  if (existing) return existing;
  const answer = askAddress(url, fetchImpl, headers).finally(() => {
    pending.delete(key);
  });
  pending.set(key, answer);
  return answer;
}
