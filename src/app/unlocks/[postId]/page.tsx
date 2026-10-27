import { redirect } from 'next/navigation';

import { createServiceClient } from '@/lib/server-helpers';
import { buildShowcaseDetailPath } from '@/lib/share';
import { getServerAuthState } from '@/lib/supabase-server';
import { getViewerUnlockDetail, getViewerUnlockRemoval } from '@/lib/viewer-unlock-detail';

import UnlockDetail from './UnlockDetail';
import UnlockRemoved from './UnlockRemoved';

export const dynamic = 'force-dynamic';

interface UnlockDetailPageProps {
  params: Promise<{ postId: string }>;
}

/**
 * The buyer's door to an unlock they own.
 *
 * /showcase/:id cannot serve this: it reads getPublicPostDetail, which filters
 * to public, unarchived, moderation-clean posts. A tombstoned or delisted post
 * fails all three, so linking a buyer's library there 404'd exactly the
 * purchases this system promises to retain. This route asks the
 * entitlement-aware bundle loader instead, and sends the buyer on to the post
 * page only when that page would open for them (`postReachable`: public or
 * unlisted, live, no block either way), so there is one canonical URL for
 * everything that has not been removed. A mature post stays here: the post
 * page's gate asks for the mature-content preference, which a buyer need not
 * have, and the purchase is their entitlement.
 */
export default async function UnlockDetailPage({ params }: UnlockDetailPageProps) {
  const { postId: unlockId } = await params;
  const auth = await getServerAuthState();

  if (!auth.session?.user) {
    redirect(`/login?returnUrl=/unlocks/${unlockId}`);
  }

  const viewerUserId = auth.session.user.id;
  const adminSupabase = createServiceClient();
  // A malformed id names no unlock, so it comes back null like another
  // buyer's purchase and lands in the library rather than on an error page.
  const detail = await getViewerUnlockDetail({
    adminSupabase,
    unlockId,
    viewerUserId,
  });

  if (!detail) {
    // The buyer's own purchase, taken back by moderation, is said to be so
    // rather than dropped on the library without a word (D2, 2026-10-27).
    if (await getViewerUnlockRemoval({ adminSupabase, unlockId, viewerUserId }) === 'moderation') {
      return <UnlockRemoved />;
    }
    redirect('/creations?view=unlocks');
  }

  if (detail.postReachable && !detail.isNsfw && detail.post) {
    redirect(buildShowcaseDetailPath(detail.post.id, {
      from: 'library',
      returnTo: '/creations?view=unlocks',
      section: 'resources',
    }));
  }

  return <UnlockDetail detail={detail} />;
}
