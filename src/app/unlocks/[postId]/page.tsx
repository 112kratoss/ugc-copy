import { redirect } from 'next/navigation';

import { getPostResourceBundleDetailByPostId } from '@/lib/post-resource-bundles-server';
import { buildShowcaseDetailPath } from '@/lib/share';
import { getServerAuthState } from '@/lib/supabase-server';

import UnlockDetail from './UnlockDetail';

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
 * entitlement-aware bundle loader instead, and bounces the viewer back to the
 * public page whenever the post is still publicly readable, so there is one
 * canonical URL for everything that has not been removed.
 */
export default async function UnlockDetailPage({ params }: UnlockDetailPageProps) {
  const { postId } = await params;
  const auth = await getServerAuthState();

  if (!auth.session?.user) {
    redirect(`/login?returnUrl=/unlocks/${postId}`);
  }

  const detail = await getPostResourceBundleDetailByPostId(postId, {
    viewerUserId: auth.session.user.id,
  });

  if (!detail || !detail.viewerCanAccess) {
    redirect('/creations?view=unlocks');
  }

  const post = detail.post;
  const isPubliclyReadable = Boolean(
    post
    && post.visibility === 'public'
    && !post.archivedAt
    && !post.tombstoned,
  );

  if (isPubliclyReadable && post) {
    redirect(buildShowcaseDetailPath(post.id, {
      from: 'unlocks',
      returnTo: '/creations?view=unlocks',
      section: 'resources',
    }));
  }

  return <UnlockDetail detail={detail} />;
}
