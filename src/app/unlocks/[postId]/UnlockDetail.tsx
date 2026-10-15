import Link from 'next/link';
import { Archive, ArrowLeft } from 'lucide-react';

import { formatMoney, type SupportedCurrency } from '@/lib/currency';
import {
  buildPostResourceBundleLockedPreview,
  formatPostResourceCreditAmount,
  formatUsdCents,
} from '@/lib/post-resource-bundles';
import type { ViewerUnlockDetail as ViewerUnlockDetailModel } from '@/lib/viewer-unlock-detail';

import PostResourceBundlePanel from '../../showcase/[id]/PostResourceBundlePanel';

/**
 * What the buyer paid, written as the library writes it. The panel below never
 * says: its price line is only drawn while a recipe is locked.
 */
function formatPaidLabel(detail: ViewerUnlockDetailModel): string {
  if (detail.paidWith === 'free') return 'Free';
  const amount = detail.paidAmountSubunits ?? 0;
  if (detail.paidWith === 'credits') return formatPostResourceCreditAmount(amount);
  const currency = (detail.paidCurrency ?? 'USD') as SupportedCurrency;
  return `${formatMoney(amount / 100, currency, currency === 'INR' ? 'en-IN' : 'en-US')} paid`;
}

/**
 * Renders an unlock the post page cannot show this buyer: one whose post is
 * gone or out of their reach, or a mature one. The bundle panel is reused
 * verbatim so a retained purchase looks and behaves exactly like a live one;
 * only the surrounding explanation differs.
 */
export default function UnlockDetail({ detail }: { detail: ViewerUnlockDetailModel }) {
  // One neutral line for a block, a private or archived post and a live read
  // that failed: it is true of each and names none, so a block is not
  // disclosed. A reachable post is on this page only because it is marked
  // mature, which needs no explaining.
  const reason = detail.detached
    ? 'The creator deleted their account. Your purchased version and its files are retained here.'
    : detail.tombstoned
    ? 'The creator removed this post. Your unlock is kept here permanently.'
    : detail.retired
      ? 'This unlock is no longer sold. Yours stays available here.'
      : !detail.postReachable
        ? "This post isn't available to you. Your unlock stays here."
        : null;
  const initialResources = detail.currentResources ?? detail.purchasedRevision.resources;
  const paidToneClass = detail.paidWith === 'free'
    ? 'border-sky-400/20 bg-sky-500/10 text-sky-100'
    : 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100';

  return (
    <div className="min-h-screen bg-[#050506] py-6 text-white">
      <div className="mx-auto w-full max-w-3xl px-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/creations?view=unlocks"
            className="inline-flex items-center gap-2 text-sm text-zinc-400 transition hover:text-zinc-200"
          >
            <ArrowLeft className="h-4 w-4" />
            Your unlocks
          </Link>
          <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${paidToneClass}`}>
            <span className="sr-only">What you paid: </span>
            {formatPaidLabel(detail)}
          </span>
        </div>

        {reason ? (
          <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-amber-300/20 bg-amber-300/[0.06] px-4 py-3">
            <Archive className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-200" />
            <p className="text-sm leading-6 text-amber-100/90">{reason}</p>
          </div>
        ) : null}

        <div className="mt-5">
          <PostResourceBundlePanel
            postId={detail.postId ?? detail.unlockId}
            fileUrlEndpoint={`/api/me/unlocks/${detail.unlockId}/file-url`}
            mediaItems={detail.mediaItems}
            coverMedia={detail.isNsfw}
            title={detail.title}
            summary={detail.summary}
            previewText={detail.previewText}
            priceLabel={formatUsdCents(detail.priceUsdCents)}
            priceUsdCents={detail.priceUsdCents}
            priceNote={null}
            isFree={detail.accessMode === 'free'}
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
