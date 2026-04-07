'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Copy, ExternalLink, Layers3, Wallet } from 'lucide-react';

import {
  formatUsdCents,
  getBundleAccessLabel,
  getPostResourceKindLabel,
} from '@/lib/post-resource-bundles';

interface SellerBundle {
  id: string;
  postId: string;
  title: string;
  summary: string;
  previewText: string;
  accessMode: 'free' | 'paid';
  priceUsdCents: number;
  salesCount: number;
  earningsUsdCents: number;
  resourceKinds: Array<'prompt' | 'workflow' | 'files' | 'notes' | 'remix'>;
  createdAt: string;
  post: {
    id: string;
    title: string;
    visibility: string;
  } | null;
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
  sales: SellerSale[];
  totalSalesCount: number;
  totalEarningsUsdCents: number;
}

interface MarketplaceSellClientProps {
  initialDashboard: SellerDashboardPayload;
}

export default function MarketplaceSellClient({
  initialDashboard,
}: MarketplaceSellClientProps) {
  const hasBundles = initialDashboard.bundles.length > 0;
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const copyPostLink = async (postId: string) => {
    try {
      const origin = window.location.origin;
      await navigator.clipboard.writeText(`${origin}/showcase/${postId}#resources`);
      setCopyFeedback('Post link copied.');
      window.setTimeout(() => setCopyFeedback(null), 2200);
    } catch {
      setCopyFeedback('Could not copy the post link.');
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
                Resource dashboard
              </div>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                Manage the resources attached to your posts
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 sm:text-base">
                Creation happens in the post flow. This screen is for checking what is live, copying the public post link, and keeping an eye on what is turning proof into revenue.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/post/new"
                className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
              >
                Open post composer
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/marketplace"
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
              >
                Explore marketplace
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="rounded-[28px] border border-white/8 bg-zinc-950/70 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Bundles</div>
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

        {!hasBundles ? (
          <div className="mt-10 rounded-[30px] border border-white/8 bg-zinc-950/70 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.35)] backdrop-blur-sm">
            <Layers3 className="mx-auto h-10 w-10 text-zinc-500" />
            <h2 className="mt-4 text-2xl font-semibold text-white">No attached resources yet</h2>
            <p className="mt-3 mx-auto max-w-xl text-sm leading-7 text-zinc-400">
              Start in the post flow: publish the proof, attach the prompt or workflow notes, choose free or paid access, and let buyers unlock it directly on the post.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/post/new"
                className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
              >
                Open post composer
              </Link>
            </div>
          </div>
        ) : (
          <div className="mt-10 grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_420px]">
            <section className="rounded-[32px] border border-white/8 bg-zinc-950/70 p-6 shadow-[0_24px_70px_rgba(0,0,0,0.4)] backdrop-blur-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Your bundles</div>
                  <h2 className="mt-3 text-2xl font-semibold text-white">Live and draft resources</h2>
                </div>
                <Link
                  href="/post/new"
                  className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                >
                  New post
                </Link>
              </div>

              {copyFeedback ? (
                <div className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-50">
                  {copyFeedback}
                </div>
              ) : null}

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {initialDashboard.bundles.map((bundle) => (
                  <div
                    key={bundle.id}
                    className="rounded-[24px] border border-white/8 bg-black/35 p-5 transition hover:border-white/14 hover:bg-black/45"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">
                          {getBundleAccessLabel(bundle.accessMode, bundle.priceUsdCents)}
                        </div>
                        <div className="mt-2 text-lg font-semibold text-white">{bundle.title}</div>
                      </div>
                      <div className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1 text-sm font-semibold text-emerald-50">
                        {bundle.accessMode === 'free' ? 'Free' : formatUsdCents(bundle.priceUsdCents)}
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-300">
                      {bundle.summary || bundle.previewText || 'Attached resources for this post.'}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
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
                      <span>{bundle.salesCount} unlock{bundle.salesCount === 1 ? '' : 's'}</span>
                      <span>{bundle.post?.title || 'Post attached'}</span>
                    </div>

                    <div className="mt-5 flex flex-wrap gap-2">
                      <Link
                        href={`/showcase/${bundle.postId}`}
                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                      >
                        <ExternalLink className="h-4 w-4" />
                        View public post
                      </Link>
                      <Link
                        href={`/showcase/${bundle.postId}#resources`}
                        className="inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-50 transition hover:border-emerald-400/35 hover:bg-emerald-500/15"
                      >
                        <ArrowRight className="h-4 w-4" />
                        Open resources
                      </Link>
                      <button
                        type="button"
                        onClick={() => void copyPostLink(bundle.postId)}
                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                      >
                        <Copy className="h-4 w-4" />
                        Copy post link
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[32px] border border-white/8 bg-zinc-950/70 p-6 shadow-[0_24px_70px_rgba(0,0,0,0.4)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Recent sales</div>
              <div className="mt-5 space-y-3">
                {initialDashboard.sales.length === 0 ? (
                  <p className="text-sm leading-7 text-zinc-400">
                    Sales will show up here once buyers unlock the resources attached to your posts.
                  </p>
                ) : (
                  initialDashboard.sales.slice(0, 8).map((sale) => (
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
      </div>
    </div>
  );
}
