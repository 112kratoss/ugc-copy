import { redirect } from 'next/navigation';

import { logBackendError } from '@/lib/backend-logger';
import { isUserRelationshipBlocked } from '@/lib/moderation-service';
import { createServiceClient } from '@/lib/server-helpers';
import { buildShowcaseDetailPath } from '@/lib/share';
import { getServerAuthState } from '@/lib/supabase-server';
import { getViewerUnlockDetail } from '@/lib/viewer-unlock-detail';

import UnlockDetail from './UnlockDetail';

export const dynamic = 'force-dynamic';

interface UnlockDetailPageProps {
  params: Promise<{ postId: string }>;
}

/**
 * /showcase/:id answers not-found across a block in either direction, as the
 * app's post read does. A buyer who blocked the seller, or was blocked by them,
 * still owns what they paid for, so this page keeps the door open itself
 * instead of bouncing them into that not-found. A relationship that could not
 * be checked is treated as a block: the page below is the buyer's own.
 */
async function isBlockedBetween(viewerUserId: string, creatorUserId: string | null): Promise<boolean> {
  if (!creatorUserId || creatorUserId === viewerUserId) {
    return false;
  }

  try {
    return await isUserRelationshipBlocked({
      adminSupabase: createServiceClient(),
      firstUserId: viewerUserId,
      secondUserId: creatorUserId,
    });
  } catch (error) {
    logBackendError('failed_to_verify_block_state_for_unlock_page', { error });
    return true;
  }
}

/**
 * The buyer's door to an unlock they own.
 *
 * /showcase/:id cannot serve this: it reads getPublicPostDetail, which filters
 * to public, unarchived, moderation-clean posts. A tombstoned or delisted post
 * fails all three, so linking a buyer's library there 404'd exactly the
 * purchases this system promises to retain. This route asks the
 * entitlement-aware bundle loader instead, and bounces the viewer back to the
 * public page whenever the post is still publicly readable, so there is one
 * canonical URL for everything that has not been removed.
 */
export default async function UnlockDetailPage({ params }: UnlockDetailPageProps) {
  const { postId: unlockId } = await params;
  const auth = await getServerAuthState();

  if (!auth.session?.user) {
    redirect(`/login?returnUrl=/unlocks/${unlockId}`);
  }

  const viewerUserId = auth.session.user.id;
  const detail = await getViewerUnlockDetail({
    adminSupabase: createServiceClient(),
    unlockId,
    viewerUserId,
  });

  if (!detail) {
    redirect('/creations?view=unlocks');
  }

  const post = detail.post;
  const isPubliclyReadable = Boolean(
    post
    && (post.visibility === 'public' || post.visibility === 'unlisted')
    && !post.archivedAt
    && !post.tombstoned,
  );

  if (isPubliclyReadable && post && !(await isBlockedBetween(viewerUserId, detail.creatorUserId))) {
    redirect(buildShowcaseDetailPath(post.id, {
      from: 'unlocks',
      returnTo: '/creations?view=unlocks',
      section: 'resources',
    }));
  }

  return <UnlockDetail detail={detail} />;
}
