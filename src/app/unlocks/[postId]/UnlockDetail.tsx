import Link from 'next/link';
import { Archive, ArrowLeft } from 'lucide-react';

import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';

import PostResourceBundlePanel from '../../showcase/[id]/PostResourceBundlePanel';

/**
 * Renders an unlock whose post is no longer publicly readable. The bundle panel
 * is reused verbatim so a retained purchase looks and behaves exactly like a
 * live one; only the surrounding explanation differs.
 */
export default function UnlockDetail({ detail }: { detail: PostResourceBundleDetail }) {
  const reason = detail.tombstoned
    ? 'The creator removed this post. Your unlock is kept here permanently.'
    : detail.retiredAt
      ? 'This unlock is no longer sold. Yours stays available here.'
      : 'This post is no longer public. Your unlock stays available here.';

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
            postId={detail.postId}
            title={detail.title}
            summary={detail.summary}
            previewText={detail.previewText}
            priceLabel={detail.priceQuote.formatted}
            priceUsdCents={detail.priceUsdCents}
            priceNote={detail.priceQuote.note}
            isFree={detail.accessMode === 'free'}
            isPublic={false}
            viewerCanAccess={detail.viewerCanAccess}
            viewerIsOwner={detail.viewerIsOwner}
            resourceKinds={detail.resourceKinds}
            lockedPreview={detail.lockedPreview}
            salesCount={detail.salesCount}
            initialResources={detail.resources
              ? {
                  promptText: detail.resources.promptText,
                  notesMarkdown: detail.resources.notesMarkdown,
                  workflowShareUrl: detail.resources.workflowShareUrl,
                  attachments: detail.resources.attachments,
                  allowRemix: detail.resources.allowRemix,
                  sections: detail.resources.sections,
                  items: detail.resources.items,
                }
              : null}
            purchasedRevision={detail.purchasedRevision
              ? {
                  revisionNumber: detail.purchasedRevision.revisionNumber,
                  purchasedAt: detail.purchasedRevision.purchasedAt,
                  title: detail.purchasedRevision.title,
                  resources: {
                    promptText: detail.purchasedRevision.resources.promptText,
                    notesMarkdown: detail.purchasedRevision.resources.notesMarkdown,
                    workflowShareUrl: detail.purchasedRevision.resources.workflowShareUrl,
                    attachments: detail.purchasedRevision.resources.attachments,
                    allowRemix: detail.purchasedRevision.resources.allowRemix,
                    sections: detail.purchasedRevision.resources.sections,
                    items: detail.purchasedRevision.resources.items,
                  },
                }
              : null}
          />
        </div>
      </div>
    </div>
  );
}
