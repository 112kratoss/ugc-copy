import { pushToast, requestConfirmation } from '@/components/feedback-state';
import {
  blockCreator,
  reportCreator,
  reportPostContent,
  type SafetySurface,
} from '@/lib/moderation-client';
import { takeBlockedCreatorOffClientFeeds } from '@/lib/showcase-client-cache';

/**
 * The three safety rows of a post's menu, each asked for, sent and answered one
 * way wherever the menu is drawn: the feed card, Explore's tile, the reel, and
 * a creator's page. Worded as the app's Home words them.
 *
 * `cancelled`: the viewer said no and nothing was sent. `done` and `failed`
 * carry the line to show. The caller owns everything else: who may ask (the
 * server takes these from registered accounts only) and what leaves the screen.
 */
export type FeedSafetyOutcome =
  | { status: 'cancelled' }
  | { status: 'done'; message: string }
  | { status: 'failed'; message: string };

interface FeedSafetyRequest {
  accessToken: string;
  surface: SafetySurface;
  /** Runs once the viewer has confirmed, before anything is sent. */
  onSend?: () => void;
}

/**
 * A feed takes a reported post away. A creator's page and the viewer's saved
 * posts are lists of their own, not a feed: the post stays where it is listed,
 * and the answer says only that it was reported.
 */
const KEEPS_REPORTED_POST: ReadonlySet<SafetySurface> = new Set(['creator-page', 'saved']);

/**
 * Shows a finished action's line as a toast, for a page with no notice bar of
 * its own. A toast is drawn above the reel and outlives a change of page.
 */
export function toastSafetyOutcome(outcome: FeedSafetyOutcome) {
  if (outcome.status === 'cancelled') return;
  pushToast({ tone: outcome.status === 'done' ? 'success' : 'error', message: outcome.message });
}

function failed(prefix: string, error: unknown): FeedSafetyOutcome {
  return {
    status: 'failed',
    message: error instanceof Error && error.message ? `${prefix} ${error.message}` : prefix,
  };
}

export async function reportPostAfterConfirmation({
  postId,
  accessToken,
  surface,
  onSend,
}: FeedSafetyRequest & { postId: string }): Promise<FeedSafetyOutcome> {
  const confirmed = await requestConfirmation({
    title: 'Report content?',
    message: 'Magicbooklet will send this post to the moderation team for a safety review.',
    confirmLabel: 'Report content',
    tone: 'danger',
  });
  if (!confirmed) return { status: 'cancelled' };
  onSend?.();
  try {
    await reportPostContent({ postId, accessToken, surface });
    return {
      status: 'done',
      message: KEEPS_REPORTED_POST.has(surface)
        ? 'Content reported. Our moderation team will take a look.'
        : 'Content reported and removed from your feed.',
    };
  } catch (error) {
    return failed('Could not report this post.', error);
  }
}

export async function reportCreatorAfterConfirmation({
  userId,
  accessToken,
  surface,
  onSend,
}: FeedSafetyRequest & { userId: string }): Promise<FeedSafetyOutcome> {
  const confirmed = await requestConfirmation({
    title: 'Report this creator?',
    message: 'Our moderation team will review their recent activity.',
    confirmLabel: 'Report user',
    tone: 'danger',
  });
  if (!confirmed) return { status: 'cancelled' };
  onSend?.();
  try {
    await reportCreator({ userId, accessToken, surface });
    return { status: 'done', message: 'Creator reported. Our moderation team will take a look.' };
  } catch (error) {
    return failed('Could not report this creator.', error);
  }
}

export async function blockCreatorAfterConfirmation({
  userId,
  creatorName,
  accessToken,
  onSend,
}: Omit<FeedSafetyRequest, 'surface'> & { userId: string; creatorName: string }): Promise<FeedSafetyOutcome> {
  const confirmed = await requestConfirmation({
    title: 'Block this creator?',
    message: 'You will stop seeing their posts and neither of you can follow the other.',
    confirmLabel: 'Block',
    tone: 'danger',
  });
  if (!confirmed) return { status: 'cancelled' };
  onSend?.();
  try {
    await blockCreator({ userId, accessToken });
    // Wherever the block was made, no page this tab goes on to may draw their
    // posts again: not from the copy it kept (Explore, the home feed), and
    // not from Explore's first page, which the server builds for everyone.
    takeBlockedCreatorOffClientFeeds(userId);
    return { status: 'done', message: `${creatorName} is blocked. Their posts are gone from your feed.` };
  } catch (error) {
    return failed('Could not block this creator.', error);
  }
}
