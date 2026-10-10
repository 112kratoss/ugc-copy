/**
 * The three safety actions a post's menu and a creator's page offer, as the
 * app sends them (`ugc-mobile/components/home-dashboard.tsx`,
 * `creator-profile-screen.tsx`): report the post, report its creator, block
 * its creator. All three need a registered account; the server answers 401 to
 * a guest or a signed-out request.
 */

export class ModerationRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ModerationRequestError';
    this.status = status;
  }
}

async function moderationRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  accessToken: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
  } catch (error) {
    // A request the page itself gave up on is not a failure to report.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ModerationRequestError('Check your connection and try again.', 0);
  }

  const data = await response.json().catch(() => null) as { error?: unknown } | null;
  if (response.ok) return data;

  throw new ModerationRequestError(
    response.status === 401
      ? 'Your session has ended. Sign in again, then try once more.'
      : (data && typeof data.error === 'string' && data.error) || 'Something went wrong. Try again.',
    response.status,
  );
}

async function postModerationRequest(path: string, accessToken: string, body?: unknown): Promise<void> {
  await moderationRequest('POST', path, accessToken, body);
}

/**
 * Where the action was asked for: the feed card, Explore's tile, Explore's
 * reel, a creator's page (its own menu and the reel opened from it), or the
 * reel opened from the viewer's saved posts. The moderation team reads it in a
 * report's note, as it reads the app's ("Reported from the mobile home feed.").
 */
export type SafetySurface = 'feed' | 'explore' | 'reel' | 'creator-page' | 'saved';

const POST_REPORT_NOTES: Record<SafetySurface, string> = {
  feed: 'Reported from the web home feed.',
  explore: 'Reported from the web Explore grid.',
  reel: 'Reported from the web reel.',
  'creator-page': 'Reported from a creator page on the web.',
  saved: 'Reported from saved posts on the web profile.',
};

/** The post goes to the moderation team; the same reason and note shape the app sends. */
export function reportPostContent({
  postId,
  accessToken,
  surface = 'feed',
}: {
  postId: string;
  accessToken: string;
  surface?: SafetySurface;
}) {
  return postModerationRequest(`/api/posts/${encodeURIComponent(postId)}/report`, accessToken, {
    reason: 'unsafe_content',
    details: POST_REPORT_NOTES[surface],
  });
}

/**
 * How each surface files a creator. The report endpoint accepts a short list
 * of surfaces (`REPORT_SOURCE_SURFACES`): `showcase` is what the app's Home
 * sends too, a reel names itself as the app's reel does, and a creator's page
 * files what the app's creator screen files, reason and note included.
 */
const CREATOR_REPORTS: Record<SafetySurface, {
  reason: 'harassment' | 'unsafe_content';
  sourceSurface: 'showcase' | 'showcase-reel' | 'creator-profile';
  details?: string;
}> = {
  feed: { reason: 'harassment', sourceSurface: 'showcase' },
  explore: { reason: 'harassment', sourceSurface: 'showcase' },
  reel: { reason: 'harassment', sourceSurface: 'showcase-reel' },
  'creator-page': {
    reason: 'unsafe_content',
    sourceSurface: 'creator-profile',
    details: "Reported from the creator's page on the web.",
  },
  saved: { reason: 'harassment', sourceSurface: 'showcase-reel' },
};

/** The creator goes to the moderation team, filed under the surface it was asked on. */
export function reportCreator({
  userId,
  accessToken,
  surface = 'feed',
}: {
  userId: string;
  accessToken: string;
  surface?: SafetySurface;
}) {
  return postModerationRequest('/api/moderation/reports', accessToken, {
    targetType: 'user',
    targetId: userId,
    ...CREATOR_REPORTS[surface],
  });
}

/** Blocks the creator: their posts leave the viewer's feeds and follows are removed both ways. */
export function blockCreator({ userId, accessToken }: { userId: string; accessToken: string }) {
  return postModerationRequest(`/api/moderation/blocks/${encodeURIComponent(userId)}`, accessToken);
}

/** Takes a block back. The follows it removed stay removed. */
export async function unblockCreator({ userId, accessToken }: { userId: string; accessToken: string }): Promise<void> {
  await moderationRequest('DELETE', `/api/moderation/blocks/${encodeURIComponent(userId)}`, accessToken);
}

/** Someone the viewer has blocked, named the way a post's creator is named. */
export type BlockedCreator = {
  id: string;
  username: string | null;
  name: string;
  avatar: string | null;
  blockedAt: string;
};

function isBlockedCreator(value: unknown): value is BlockedCreator {
  const candidate = value as Partial<BlockedCreator> | null;
  return Boolean(
    candidate
    && typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.blockedAt === 'string'
    && (candidate.username === null || typeof candidate.username === 'string')
    && (candidate.avatar === null || typeof candidate.avatar === 'string'),
  );
}

/**
 * Whom the viewer has blocked, newest first. An answer of another shape is an
 * error and never an empty list: an empty list says "you have blocked nobody".
 */
export async function listBlockedCreators({
  accessToken,
  signal,
}: {
  accessToken: string;
  signal?: AbortSignal;
}): Promise<{ blockedUsers: BlockedCreator[]; hasMore: boolean }> {
  const data = await moderationRequest('GET', '/api/moderation/blocks', accessToken, undefined, signal) as {
    blockedUsers?: unknown;
    hasMore?: unknown;
  } | null;
  if (!data || !Array.isArray(data.blockedUsers) || !data.blockedUsers.every(isBlockedCreator)) {
    throw new ModerationRequestError('Something went wrong. Try again.', 200);
  }
  return { blockedUsers: data.blockedUsers, hasMore: data.hasMore === true };
}
