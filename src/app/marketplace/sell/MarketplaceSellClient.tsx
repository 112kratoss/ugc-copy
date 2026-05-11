'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ArrowRight, Copy, ExternalLink, Layers3, Wallet } from 'lucide-react';

import { formatBundleAccessLabel, type MarketplaceQualityAssessment } from '@/lib/marketplace-trust';
import {
  formatUsdCents,
  formatUnlockCountLabel,
  getPostResourceKindLabel,
  type MarketplacePriceQuote,
} from '@/lib/post-resource-bundles';
import { buildShowcaseDetailPath } from '@/lib/share';

interface SellerBundle {
  id: string;
  postId: string;
  title: string;
  summary: string;
  previewText: string;
  accessMode: 'free' | 'paid';
  status: 'draft' | 'published';
  priceUsdCents: number;
  priceQuote?: MarketplacePriceQuote;
  salesCount: number;
  earningsUsdCents: number;
  resourceKinds: Array<'prompt' | 'workflow' | 'files' | 'notes' | 'remix'>;
  createdAt: string;
  updatedAt?: string;
  quality?: MarketplaceQualityAssessment;
  post: {
    id: string;
    title: string;
    visibility: string;
    archivedAt: string | null;
    reviewStatus?: 'visible' | 'flagged' | 'hidden';
    saveCount?: number;
    remixCount?: number;
    shareVisitCount?: number;
  } | null;
}

interface DeletedSnapshot {
  id: string;
  title: string;
  visibility: string;
  bundleAccessMode: 'free' | 'paid' | null;
  bundleStatus: 'draft' | 'published' | null;
  bundlePriceUsdCents: number | null;
  resourceKinds: Array<'prompt' | 'workflow' | 'files' | 'notes' | 'remix'>;
  salesCount: number;
  earningsUsdCents: number;
  hadPaidOrders: boolean;
  deletedAt: string;
}

interface SellerSale {
  id: string;
  bundleId: string;
  bundleTitle: string;
  buyerLabel: string;
  amountSubunits: number;
  currency: 'INR' | 'USD';
  createdAt: string;
}

interface SellerDashboardPayload {
  bundles: SellerBundle[];
  deletedSnapshots: DeletedSnapshot[];
  sales: SellerSale[];
  totalSalesCount: number;
  totalEarningsUsdCents: number;
  generatedAt?: string;
}

interface MarketplaceSellClientProps {
  initialDashboard: SellerDashboardPayload;
}

function getListingHealth(bundle: SellerBundle): { label: 'Ready' | 'Needs work' | 'Draft' } {
  if (bundle.status !== 'published') {
    return { label: 'Draft' };
  }

  if (bundle.quality && !bundle.quality.eligible) {
    return { label: 'Needs work' };
  }

  return { label: 'Ready' };
}

export default function MarketplaceSellClient({
  initialDashboard,
}: MarketplaceSellClientProps) {
  const hasBundles = initialDashboard.bundles.length > 0;
  const deletedSnapshots = initialDashboard.deletedSnapshots ?? [];
  const [datePreset, setDatePreset] = useState<'7d' | '30d' | 'all'>('30d');
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const sellerReturnPath = '/marketplace/sell';
  const dashboardGeneratedAt = initialDashboard.generatedAt
    ? new Date(initialDashboard.generatedAt).getTime()
    : initialDashboard.sales.reduce((latest, sale) => Math.max(latest, new Date(sale.createdAt).getTime()), 0);

  const filteredSales = useMemo(() => {
    if (datePreset === 'all' || dashboardGeneratedAt <= 0) {
      return initialDashboard.sales;
    }

    const days = datePreset === '7d' ? 7 : 30;
    const cutoff = dashboardGeneratedAt - days * 24 * 60 * 60 * 1000;
    return initialDashboard.sales.filter((sale) => new Date(sale.createdAt).getTime() >= cutoff);
  }, [dashboardGeneratedAt, datePreset, initialDashboard.sales]);
  const totalPostVisits = initialDashboard.bundles.reduce(
    (sum, bundle) => sum + (bundle.post?.shareVisitCount ?? 0),
    0
  );
  const totalSaves = initialDashboard.bundles.reduce(
    (sum, bundle) => sum + (bundle.post?.saveCount ?? 0),
    0
  );
  const totalRemixes = initialDashboard.bundles.reduce(
    (sum, bundle) => sum + (bundle.post?.remixCount ?? 0),
    0
  );
  const conversionRate = totalPostVisits > 0
    ? `${Math.round((initialDashboard.totalSalesCount / totalPostVisits) * 1000) / 10}%`
    : '0%';

  const copyPostLink = async (postId: string) => {
    try {
      const origin = window.location.origin;
      await navigator.clipboard.writeText(`${origin}/showcase/${postId}#resources`);
      setCopyFeedback('Unlock link copied.');
      window.setTimeout(() => setCopyFeedback(null), 2200);
    } catch {
      setCopyFeedback('Could not copy the unlock link.');
      window.setTimeout(() => setCopyFeedback(null), 2200);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute left-[-10%] top-[-10%] h-[36%] w-[28%] rounded-full bg-emerald-500/10 blur-[150px]" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[34%] w-[28%] rounded-full bg-sky-500/10 blur-[160px]" />
      </div>

      <div className="studio-shell relative z-10 py-12 sm:py-16">
        <div className="rounded-[34px] border border-white/8 bg-[linear-gradient(135deg,rgba(5,8,12,0.98),rgba(16,18,25,0.92))] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.5)] sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-100">
                <Wallet className="h-3.5 w-3.5" />
                Seller Dashboard
              </div>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                Manage the unlocks attached to your community posts
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 sm:text-base">
                The post is the source of truth. Use this screen to see which prompts, workflows, notes, files, and remix gates are live, then track which public posts are turning into unlocks.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/post/new"
                className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
              >
                Share a post
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/marketplace"
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
              >
                Explore unlocks
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="rounded-[28px] border border-white/8 bg-zinc-950/70 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Unlocks</div>
            <div className="mt-3 text-3xl font-semibold text-white">{initialDashboard.bundles.length}</div>
          </div>
          <div className="rounded-[28px] border border-white/8 bg-zinc-950/70 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Sales</div>
            <div className="mt-3 text-3xl font-semibold text-white">{initialDashboard.totalSalesCount}</div>
          </div>
          <div className="rounded-[28px] border border-white/8 bg-zinc-950/70 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Tracked earnings</div>
            <div className="mt-3 text-3xl font-semibold text-white">{formatUsdCents(initialDashboard.totalEarningsUsdCents)}</div>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-4">
          <div className="rounded-[24px] border border-white/8 bg-zinc-950/60 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Post visits</div>
            <div className="mt-2 text-2xl font-semibold text-white">{totalPostVisits}</div>
          </div>
          <div className="rounded-[24px] border border-white/8 bg-zinc-950/60 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Conversion</div>
            <div className="mt-2 text-2xl font-semibold text-white">{conversionRate}</div>
          </div>
          <div className="rounded-[24px] border border-white/8 bg-zinc-950/60 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Saves</div>
            <div className="mt-2 text-2xl font-semibold text-white">{totalSaves}</div>
          </div>
          <div className="rounded-[24px] border border-white/8 bg-zinc-950/60 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Remixes</div>
            <div className="mt-2 text-2xl font-semibold text-white">{totalRemixes}</div>
          </div>
        </div>

        {!hasBundles ? (
          <div className="mt-10 rounded-[30px] border border-white/8 bg-zinc-950/70 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.35)] backdrop-blur-sm">
            <Layers3 className="mx-auto h-10 w-10 text-zinc-500" />
            <h2 className="mt-4 text-2xl font-semibold text-white">No unlocks yet</h2>
            <p className="mt-3 mx-auto max-w-xl text-sm leading-7 text-zinc-400">
              Start in the post flow: publish the public post, attach the prompt, workflow, notes, files, or remix access, then choose whether the unlock is free or paid.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/post/new"
                className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
              >
                Share a post
              </Link>
            </div>
          </div>
        ) : (
          <div className="mt-10 grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_420px]">
            <section className="rounded-[32px] border border-white/8 bg-zinc-950/70 p-6 shadow-[0_24px_70px_rgba(0,0,0,0.4)] backdrop-blur-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Live unlocks</div>
                  <h2 className="mt-3 text-2xl font-semibold text-white">Live and draft unlocks</h2>
                </div>
                <Link
                  href="/post/new"
                  className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                >
                  Share post
                </Link>
              </div>

              {copyFeedback ? (
                <div className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-50">
                  {copyFeedback}
                </div>
              ) : null}

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {initialDashboard.bundles.map((bundle) => {
                  const accessLabel = formatBundleAccessLabel({
                    accessMode: bundle.accessMode,
                    priceQuote: bundle.priceQuote ?? {
                      currency: 'USD',
                      amountSubunits: bundle.priceUsdCents,
                      formatted: formatUsdCents(bundle.priceUsdCents),
                      note: null,
                    },
                  });
                  const health = getListingHealth(bundle);

                  return (
                  <div
                    key={bundle.id}
                    className="rounded-[24px] border border-white/8 bg-black/35 p-5 transition hover:border-white/14 hover:bg-black/45"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">
                          {accessLabel}
                        </div>
                        <div className="mt-2 text-lg font-semibold text-white">{bundle.title}</div>
                      </div>
                      <div className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1 text-sm font-semibold text-emerald-50">
                        {bundle.accessMode === 'free' ? 'Free' : bundle.priceQuote?.formatted ?? formatUsdCents(bundle.priceUsdCents)}
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-300">
                      {bundle.summary || bundle.previewText || 'Reusable value attached to this post.'}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <div className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${
                        health.label === 'Ready'
                          ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-50'
                          : health.label === 'Needs work'
                            ? 'border-rose-400/20 bg-rose-500/10 text-rose-50'
                          : 'border-amber-400/20 bg-amber-500/10 text-amber-50'
                      }`}>
                        {health.label}
                      </div>
                      {bundle.post?.visibility ? (
                        <div className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-200">
                          {bundle.post.archivedAt ? 'Archived post' : `${bundle.post.visibility} post`}
                        </div>
                      ) : null}
                      {bundle.post?.reviewStatus && bundle.post.reviewStatus !== 'visible' ? (
                        <div className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${
                          bundle.post.reviewStatus === 'hidden'
                            ? 'border-rose-400/20 bg-rose-500/10 text-rose-50'
                            : 'border-amber-400/20 bg-amber-500/10 text-amber-50'
                        }`}>
                          {bundle.post.reviewStatus === 'hidden' ? 'Hidden in review' : 'Flagged for review'}
                        </div>
                      ) : null}
                      {(bundle.resourceKinds ?? []).map((kind) => (
                        <div
                          key={`${bundle.id}-${kind}`}
                          className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-200"
                        >
                          {getPostResourceKindLabel(kind)}
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
                      <span>{formatUnlockCountLabel(bundle.accessMode, bundle.salesCount)}</span>
                      <span>{bundle.post?.title || 'Post attached'}</span>
                    </div>
                    {bundle.quality && !bundle.quality.eligible ? (
                      <div className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-500/10 p-3 text-sm leading-6 text-rose-50">
                        {bundle.quality.issues[0]?.message ?? 'Improve this listing before it appears in the marketplace.'}
                      </div>
                    ) : null}
                    <div className="mt-4 grid grid-cols-3 gap-2 rounded-2xl border border-white/8 bg-white/[0.03] p-3 text-xs text-zinc-400">
                      <span>{bundle.post?.shareVisitCount ?? 0} visits</span>
                      <span className="text-center">{bundle.post?.saveCount ?? 0} saves</span>
                      <span className="text-right">{bundle.post?.remixCount ?? 0} remixes</span>
                    </div>

                    <div className="mt-5 flex flex-wrap gap-2">
                      {bundle.post && !bundle.post.archivedAt && bundle.post.reviewStatus !== 'hidden' && (bundle.post.visibility === 'public' || bundle.post.visibility === 'unlisted') ? (
                        <>
                          <Link
                            href={buildShowcaseDetailPath(bundle.postId, {
                              from: 'seller',
                              returnTo: sellerReturnPath,
                            })}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                          >
                            <ExternalLink className="h-4 w-4" />
                            View public post
                          </Link>
                          <Link
                            href={buildShowcaseDetailPath(bundle.postId, {
                              from: 'seller',
                              returnTo: sellerReturnPath,
                              section: 'resources',
                            })}
                            className="inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-50 transition hover:border-emerald-400/35 hover:bg-emerald-500/15"
                          >
                            <ArrowRight className="h-4 w-4" />
                            Open unlock
                          </Link>
                          <button
                            type="button"
                            onClick={() => void copyPostLink(bundle.postId)}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                          >
                            <Copy className="h-4 w-4" />
                            Copy unlock link
                          </button>
                        </>
                      ) : (
                        <>
                          <Link
                            href={`/post/${bundle.postId}/edit`}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                          >
                            <ExternalLink className="h-4 w-4" />
                            Open editor
                          </Link>
                          <Link
                            href={`/post/${bundle.postId}/edit#resources`}
                            className="inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-50 transition hover:border-emerald-400/35 hover:bg-emerald-500/15"
                          >
                            <ArrowRight className="h-4 w-4" />
                            Edit unlock
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                );
                })}
              </div>
            </section>

            <section className="rounded-[32px] border border-white/8 bg-zinc-950/70 p-6 shadow-[0_24px_70px_rgba(0,0,0,0.4)] backdrop-blur-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Recent sales</div>
                <div className="flex rounded-full border border-white/10 bg-black/25 p-1">
                  {(['7d', '30d', 'all'] as const).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setDatePreset(preset)}
                      className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] transition ${
                        datePreset === preset
                          ? 'bg-white text-black'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-5 space-y-3">
                {filteredSales.length === 0 ? (
                  <p className="text-sm leading-7 text-zinc-400">
                    Sales will show up here once buyers open paid unlocks in this date range.
                  </p>
                ) : (
                  filteredSales.slice(0, 8).map((sale) => (
                    <div key={sale.id} className="rounded-[22px] border border-white/8 bg-black/30 p-4">
                      <div className="text-sm font-medium text-white">{sale.bundleTitle}</div>
                      <div className="mt-1 text-xs text-zinc-500">
                        {sale.buyerLabel} · {new Date(sale.createdAt).toLocaleString()}
                      </div>
                      <div className="mt-2 text-sm text-zinc-300">
                        {sale.currency} {(sale.amountSubunits / 100).toLocaleString()} unlocked
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        )}

        {deletedSnapshots.length > 0 ? (
          <section className="mt-10 rounded-[32px] border border-white/8 bg-zinc-950/70 p-6 shadow-[0_24px_70px_rgba(0,0,0,0.4)] backdrop-blur-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Deleted post history</div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {deletedSnapshots.map((snapshot) => (
                <div key={snapshot.id} className="rounded-[24px] border border-white/8 bg-black/35 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-lg font-semibold text-white">{snapshot.title}</div>
                      <div className="mt-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
                        Deleted {new Date(snapshot.deletedAt).toLocaleString()}
                      </div>
                    </div>
                    <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-200">
                      {snapshot.hadPaidOrders ? 'Had paid unlocks' : 'No paid unlocks'}
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {snapshot.bundleAccessMode ? (
                      <div className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-200">
                        {snapshot.bundleAccessMode === 'free'
                          ? 'Free unlock'
                          : formatUsdCents(snapshot.bundlePriceUsdCents ?? 0)}
                      </div>
                    ) : null}
                    {(snapshot.resourceKinds ?? []).map((kind) => (
                      <div
                        key={`${snapshot.id}-${kind}`}
                        className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-200"
                      >
                        {getPostResourceKindLabel(kind)}
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 text-sm text-zinc-300">
                    {snapshot.bundleAccessMode
                      ? formatUnlockCountLabel(snapshot.bundleAccessMode, snapshot.salesCount)
                      : `${snapshot.salesCount} unlock${snapshot.salesCount === 1 ? '' : 's'}`} · {formatUsdCents(snapshot.earningsUsdCents)} tracked lifetime earnings
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
