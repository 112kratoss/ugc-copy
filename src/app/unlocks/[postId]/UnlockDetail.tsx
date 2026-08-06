import Link from 'next/link';
import { Archive, ArrowLeft } from 'lucide-react';

import {
  buildPostResourceBundleLockedPreview,
  formatUsdCents,
} from '@/lib/post-resource-bundles';
import type { ViewerUnlockDetail as ViewerUnlockDetailModel } from '@/lib/viewer-unlock-detail';

import PostResourceBundlePanel from '../../showcase/[id]/PostResourceBundlePanel';

/**
 * Renders an unlock whose post is no longer publicly readable. The bundle panel
 * is reused verbatim so a retained purchase looks and behaves exactly like a
 * live one; only the surrounding explanation differs.
 */
export default function UnlockDetail({ detail }: { detail: ViewerUnlockDetailModel }) {
  const reason = detail.detached
    ? 'The creator deleted their account. Your purchased version and its files are retained here.'
    : detail.tombstoned
    ? 'The creator removed this post. Your unlock is kept here permanently.'
    : detail.retired
      ? 'This unlock is no longer sold. Yours stays available here.'
      : 'This post is no longer public. Your unlock stays available here.';
  const initialResources = detail.currentResources ?? detail.purchasedRevision.resources;

  return (
    <div className="min-h-screen bg-[#050506] py-6 text-white">
      <div className="mx-auto w-full max-w-3xl px-4">
        <Link
          href="/creations?view=unlocks"
          className="inline-flex items-center gap-2 text-sm text-zinc-400 transition hover:text-zinc-200"
        >
          <ArrowLeft className="h-4 w-4" />
          Your unlocks
        </Link>

        <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-amber-300/20 bg-amber-300/[0.06] px-4 py-3">
          <Archive className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-200" />
          <p className="text-sm leading-6 text-amber-100/90">{reason}</p>
        </div>

        <div className="mt-5">
          <PostResourceBundlePanel
            postId={detail.postId ?? detail.unlockId}
            fileUrlEndpoint={`/api/me/unlocks/${detail.unlockId}/file-url`}
            mediaItems={detail.mediaItems}
            title={detail.title}
            summary={detail.summary}
            previewText={detail.previewText}
            priceLabel={formatUsdCents(detail.priceUsdCents)}
            priceUsdCents={detail.priceUsdCents}
            priceNote={null}
            isFree={detail.accessMode === 'free'}
            isPublic={false}
            viewerCanAccess
            viewerIsOwner={false}
            resourceKinds={detail.resourceKinds}
            lockedPreview={buildPostResourceBundleLockedPreview(initialResources)}
            salesCount={detail.salesCount}
            initialResources={initialResources}
            purchasedRevision={detail.hasNewerRevision && detail.currentResources
              ? {
                  revisionNumber: detail.purchasedRevision.revisionNumber,
                  purchasedAt: detail.purchasedAt,
                  title: detail.purchasedRevision.title,
                  summary: detail.purchasedRevision.summary,
                  previewText: detail.purchasedRevision.previewText,
                  accessMode: detail.purchasedRevision.accessMode,
                  priceUsdCents: detail.purchasedRevision.priceUsdCents,
                  mediaItems: detail.purchasedRevision.mediaItems,
                  resources: detail.purchasedRevision.resources,
                }
              : null}
          />
        </div>
      </div>
    </div>
  );
}
