import type { MagicbookletApiClient } from './api-client';
import { buildImmersiveShowcaseItems, type ImmersivePreviewItem } from './immersive-preview-view-model';
import type { ShowcaseFeedItem } from './types';
import { getNativeRemixCreateHref, getRemixSourceContext, type RemixSourceContext } from './viewer-actions';

/** The remix endpoint's answer for a post whose remix sits behind an unlock. */
export const REMIX_UNLOCK_REQUIRED_CODE = 'REMIX_UNLOCK_REQUIRED';

type RemixApi = Pick<MagicbookletApiClient, 'remixShowcasePost' | 'unlockFreeBundle'>;

export type RemixStartResponse = Awaited<ReturnType<RemixApi['remixShowcasePost']>>;

export type RemixStartResult =
  | {
      kind: 'started';
      response: RemixStartResponse;
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

/**
 * The creator a started remix opens: the server's create link as the app's
 * route (or the post's own tool and prompt when the app cannot map it), with
 * the row naming the source. `item` is the post as the reel reads it. Home and
 * the reel both build the link here; Home's own copy once left the row out.
 */
export function showcaseRemixCreateHref(item: ImmersivePreviewItem, response: RemixStartResponse) {
  return getNativeRemixCreateHref({
    redirectTo: response.redirectTo,
    recreateTool: item.recreateTool,
    prompt: response.prefill?.prompt ?? item.recreatePrompt,
    context: getRemixSourceContext(item),
  });
}

/**
 * The row for a post read by id (`api.getShowcasePost`), for a creator whose
 * link named the post alone. Read as the reel reads the post, as Home's links
 * are, so the row says what it would have said opened from either.
 */
export function showcasePostRemixSourceContext(post: ShowcaseFeedItem): RemixSourceContext {
  return getRemixSourceContext(buildImmersiveShowcaseItems('showcase-feed', [post])[0]);
}

function isRemixUnlockRequired(error: unknown) {
  return error instanceof Error
    && (error as Error & { code?: unknown }).code === REMIX_UNLOCK_REQUIRED_CODE;
}
