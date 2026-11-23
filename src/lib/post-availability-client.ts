/**
 * Whether a post a feed is drawing is still public, asked when its media fails
 * to load. An image or video error says nothing of why it failed, and a post
 * that left public view while the feed was open (archived, made private,
 * hidden, deleted) has its media refused from then on
 * (`post-media-read-service.ts`), so the card would keep its blurred
 * placeholder for good.
 *
 * - `gone`: the resolver answered 404, which it does only for a post that is
 *   not live (`/api/showcase/posts/[postId]/resolve`). The feed removes the card.
 * - `live`: the post is still public; the failure was the media's or the
 *   network's, so the card offers a retry.
 * - `unknown`: offline, rate-limited or a server error. Treated as `live`:
 *   a card is never removed on a guess.
 *
 * Without a token the resolver's 200 may come from the CDN, up to about a
 * minute old, so a post archived in that minute reads `live` once and is
 * removed at a later failure. Its 404 is never cached.
 */
export type PostAvailability = 'live' | 'gone' | 'unknown';

type CheckPostAvailabilityOptions = {
  accessToken?: string | null;
  fetchImpl?: typeof fetch;
};

// One question per post at a time: a card can fail twice in a row (a slide and
// its retry), and both callers want the same answer.
const pending = new Map<string, Promise<PostAvailability>>();

async function askResolver(
  postId: string,
  { accessToken, fetchImpl = fetch }: CheckPostAvailabilityOptions,
): Promise<PostAvailability> {
  try {
    const response = await fetchImpl(`/api/showcase/posts/${encodeURIComponent(postId)}/resolve`, {
      cache: 'no-store',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    if (response.status === 404) return 'gone';
    return response.ok ? 'live' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function checkPostAvailability(
  postId: string,
  options: CheckPostAvailabilityOptions = {},
): Promise<PostAvailability> {
  const existing = pending.get(postId);
  if (existing) return existing;
  const answer = askResolver(postId, options).finally(() => {
    pending.delete(postId);
  });
  pending.set(postId, answer);
  return answer;
}
