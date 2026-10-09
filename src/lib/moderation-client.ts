/**
 * The three safety actions a feed card's menu offers, as the app sends them
 * (`ugc-mobile/components/home-dashboard.tsx`): report the post, report its
 * creator, block its creator. All three need a registered account; the server
 * answers 401 to a guest or a signed-out request.
 */

export class ModerationRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ModerationRequestError';
    this.status = status;
  }
}

async function postModerationRequest(path: string, accessToken: string, body?: unknown): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ModerationRequestError('Check your connection and try again.', 0);
  }
  if (response.ok) return;

  const data = await response.json().catch(() => null) as { error?: unknown } | null;
  throw new ModerationRequestError(
    response.status === 401
      ? 'Your session has ended. Sign in again, then try once more.'
      : (data && typeof data.error === 'string' && data.error) || 'Something went wrong. Try again.',
    response.status,
  );
}

/** The post goes to the moderation team; the same reason and note shape the app sends. */
export function reportPostContent({ postId, accessToken }: { postId: string; accessToken: string }) {
  return postModerationRequest(`/api/posts/${encodeURIComponent(postId)}/report`, accessToken, {
    reason: 'unsafe_content',
    details: 'Reported from the web home feed.',
  });
}

/**
 * The creator goes to the moderation team. `showcase` is the surface the app's
 * Home sends too: the report endpoint accepts only the showcase surfaces.
 */
export function reportCreator({ userId, accessToken }: { userId: string; accessToken: string }) {
  return postModerationRequest('/api/moderation/reports', accessToken, {
    targetType: 'user',
    targetId: userId,
    reason: 'harassment',
    sourceSurface: 'showcase',
  });
}

/** Blocks the creator: their posts leave the viewer's feeds and follows are removed both ways. */
export function blockCreator({ userId, accessToken }: { userId: string; accessToken: string }) {
  return postModerationRequest(`/api/moderation/blocks/${encodeURIComponent(userId)}`, accessToken);
}
