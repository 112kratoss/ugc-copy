import type { MagicbookletApiClient } from './api-client';

/** The remix endpoint's answer for a post whose remix sits behind an unlock. */
export const REMIX_UNLOCK_REQUIRED_CODE = 'REMIX_UNLOCK_REQUIRED';

type RemixApi = Pick<MagicbookletApiClient, 'remixShowcasePost' | 'unlockFreeBundle'>;

export type RemixStartResult =
  | {
      kind: 'started';
      response: Awaited<ReturnType<RemixApi['remixShowcasePost']>>;
      /** True when this tap also took the post's free unlock, so its caches are stale. */
      claimedFreeUnlock: boolean;
    }
  /**
   * The server wants an unlock the loaded post did not mention. The caller
   * shows the unlock sheet; nothing has been claimed or spent.
   */
  | { kind: 'unlock-required' };

/**
 * The requests behind one tap on Remix, shared by Home and the reel.
 *
 * A free unlock is claimed here, in the same tap, because it costs the viewer
 * nothing. A paid one never is: the caller sends those to the unlock sheet
 * before calling this, and this function has no way to spend credits.
 */
export async function startShowcaseRemix({
  api,
  postId,
  claimFreeUnlock,
}: {
  api: RemixApi;
  postId: string;
  /** The loaded post says remix sits behind a free unlock this viewer has not taken. */
  claimFreeUnlock: boolean;
}): Promise<RemixStartResult> {
  // Claiming twice is harmless: the server answers a repeat as already owned.
  if (claimFreeUnlock) await api.unlockFreeBundle(postId);

  try {
    const response = await api.remixShowcasePost(postId);
    return { kind: 'started', response, claimedFreeUnlock: claimFreeUnlock };
  } catch (error) {
    // Still locked straight after a claim means something else is wrong, and
    // sending the viewer back to unlock again would only loop.
    if (claimFreeUnlock || !isRemixUnlockRequired(error)) throw error;
    return { kind: 'unlock-required' };
  }
}

function isRemixUnlockRequired(error: unknown) {
  return error instanceof Error
    && (error as Error & { code?: unknown }).code === REMIX_UNLOCK_REQUIRED_CODE;
}
