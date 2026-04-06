'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Download, Loader2, ShoppingBag, Wallet } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import {
  formatUsdCents,
  getMarketplaceAssetTypeLabel,
  type MarketplaceAssetStatus,
} from '@/lib/marketplace';
import type { ShowcaseAssetType } from '@/lib/showcase';

interface DashboardListing {
  id: string;
  type: ShowcaseAssetType;
  title: string;
  description: string;
  preview: string;
  priceUsdCents: number;
  status: MarketplaceAssetStatus;
  salesCount: number;
  earningsUsdCents: number;
  createdAt: string;
  post: {
    id: string;
    title: string;
  } | null;
}

interface DashboardPostOption {
  id: string;
  title: string;
  category: string;
  visibility: string;
  createdAt: string;
  linkedAssetId: string | null;
}

interface DashboardWorkflowCanvasOption {
  id: string;
  title: string;
  updatedAt: string;
  status: 'draft' | 'published';
}

interface DashboardSaleRecord {
  id: string;
  assetId: string;
  assetTitle: string;
  buyerLabel: string;
  priceUsdCents: number;
  amountSubunits: number;
  currency: 'INR' | 'USD';
  createdAt: string;
}

interface SellerDashboardPayload {
  listings: DashboardListing[];
  posts: DashboardPostOption[];
  workflowCanvases: DashboardWorkflowCanvasOption[];
  sales: DashboardSaleRecord[];
  totalSalesCount: number;
  totalEarningsUsdCents: number;
}

interface MarketplaceSellClientProps {
  initialDashboard: SellerDashboardPayload;
  initialSelectedPostId: string | null;
}

const STATUS_OPTIONS: MarketplaceAssetStatus[] = ['draft', 'active', 'unlisted'];
const TYPE_OPTIONS: ShowcaseAssetType[] = ['workflow', 'prompt_pack', 'guide'];

export default function MarketplaceSellClient({
  initialDashboard,
  initialSelectedPostId,
}: MarketplaceSellClientProps) {
  const router = useRouter();
  const { session } = useAuth();
  const [type, setType] = useState<ShowcaseAssetType>('workflow');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [preview, setPreview] = useState('');
  const [priceUsd, setPriceUsd] = useState('19.00');
  const [status, setStatus] = useState<MarketplaceAssetStatus>('draft');
  const [postId, setPostId] = useState(initialSelectedPostId ?? '');
  const [canvasId, setCanvasId] = useState(initialDashboard.workflowCanvases[0]?.id ?? '');
  const [promptPack, setPromptPack] = useState('');
  const [guideMarkdown, setGuideMarkdown] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const availablePostOptions = useMemo(
    () => initialDashboard.posts.filter((post) => !post.linkedAssetId || post.id === postId),
    [initialDashboard.posts, postId]
  );

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (!session?.access_token) {
      router.push('/login?returnUrl=/marketplace/sell');
      return;
    }

    const parsedPrice = Number.parseFloat(priceUsd);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      setError('Enter a valid USD price.');
      return;
    }

    try {
      setIsSaving(true);
      const response = await fetch('/api/marketplace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          postId: postId || null,
          canvasId: type === 'workflow' ? canvasId || null : null,
          type,
          title,
          description,
          preview,
          priceUsdCents: Math.round(parsedPrice * 100),
          status,
          promptPack: type === 'prompt_pack' ? promptPack : null,
          guideMarkdown: type === 'guide' ? guideMarkdown : null,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save listing.');
      }

      setSuccess('Listing saved. Refreshing your dashboard…');
      setTitle('');
      setDescription('');
      setPreview('');
      setPromptPack('');
      setGuideMarkdown('');
      setPostId('');
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save listing.');
    } finally {
      setIsSaving(false);
    }
  };

  const exportSales = async () => {
    if (!session?.access_token) {
      router.push('/login?returnUrl=/marketplace/sell');
      return;
    }

    try {
      setIsExporting(true);
      const response = await fetch('/api/marketplace/sales/export', {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'marketplace-sales.csv';
      anchor.click();
      window.URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Failed to export sales.');
    } finally {
      setIsExporting(false);
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
                Seller dashboard
              </div>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                Turn posts into reusable revenue
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 sm:text-base">
                Attach a workflow, prompt pack, or guide to a proof post. Buyers unlock lifetime access, and you track sales here for manual payouts in v1.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void exportSales()}
                disabled={isExporting}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Export sales CSV
              </button>
              <Link
                href="/marketplace"
                className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
              >
                View marketplace
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="rounded-[28px] border border-white/8 bg-zinc-950/70 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Listings</div>
            <div className="mt-3 text-3xl font-semibold text-white">{initialDashboard.listings.length}</div>
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

        <div className="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1.1fr)_420px]">
          <section className="rounded-[32px] border border-white/8 bg-zinc-950/70 p-6 shadow-[0_24px_70px_rgba(0,0,0,0.4)] backdrop-blur-sm">
            <div className="mb-6">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Create listing</div>
              <h2 className="mt-3 text-3xl font-semibold text-white">Sell the “how” behind the creative</h2>
            </div>

            <form className="space-y-5" onSubmit={handleSave}>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Listing type</div>
                  <select
                    value={type}
                    onChange={(event) => setType(event.target.value as ShowcaseAssetType)}
                    className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                  >
                    {TYPE_OPTIONS.map((option) => (
                      <option key={option} value={option} className="bg-zinc-950 text-white">
                        {getMarketplaceAssetTypeLabel(option)}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Status</div>
                  <select
                    value={status}
                    onChange={(event) => setStatus(event.target.value as MarketplaceAssetStatus)}
                    className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                  >
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option} value={option} className="bg-zinc-950 text-white">
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Title</div>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="3-scene spring launch workflow"
                    className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                  />
                </label>

                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Price in USD</div>
                  <input
                    value={priceUsd}
                    onChange={(event) => setPriceUsd(event.target.value)}
                    placeholder="19.00"
                    className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                  />
                </label>
              </div>

              <label className="block">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Description</div>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={4}
                  placeholder="Explain what the buyer gets and where this system performs best."
                  className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                />
              </label>

              <label className="block">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Public preview</div>
                <textarea
                  value={preview}
                  onChange={(event) => setPreview(event.target.value)}
                  rows={3}
                  placeholder="Show the outline or teaser buyers can read before unlocking."
                  className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Attach to post</div>
                  <select
                    value={postId}
                    onChange={(event) => setPostId(event.target.value)}
                    className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                  >
                    <option value="" className="bg-zinc-950 text-white">Standalone listing</option>
                    {availablePostOptions.map((post) => (
                      <option key={post.id} value={post.id} className="bg-zinc-950 text-white">
                        {post.title} ({post.visibility})
                      </option>
                    ))}
                  </select>
                </label>

                {type === 'workflow' ? (
                  <label className="block">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Workflow canvas</div>
                    <select
                      value={canvasId}
                      onChange={(event) => setCanvasId(event.target.value)}
                      className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                    >
                      <option value="" className="bg-zinc-950 text-white">Choose a canvas</option>
                      {initialDashboard.workflowCanvases.map((canvas) => (
                        <option key={canvas.id} value={canvas.id} className="bg-zinc-950 text-white">
                          {canvas.title} ({canvas.status})
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>

              {type === 'prompt_pack' ? (
                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Prompt pack</div>
                  <textarea
                    value={promptPack}
                    onChange={(event) => setPromptPack(event.target.value)}
                    rows={8}
                    placeholder="Paste the prompt pack exactly as the buyer should receive it."
                    className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                  />
                </label>
              ) : null}

              {type === 'guide' ? (
                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Guide content</div>
                  <textarea
                    value={guideMarkdown}
                    onChange={(event) => setGuideMarkdown(event.target.value)}
                    rows={10}
                    placeholder="Write the tutorial or guide content buyers should unlock."
                    className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                  />
                </label>
              ) : null}

              {error ? (
                <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                  {error}
                </div>
              ) : null}

              {success ? (
                <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-50">
                  {success}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-full bg-emerald-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingBag className="h-4 w-4" />}
                Save listing
              </button>
            </form>
          </section>

          <aside className="space-y-6">
            <div className="rounded-[30px] border border-white/8 bg-zinc-950/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Quick status</div>
              <p className="mt-3 text-sm leading-7 text-zinc-300">
                Workflow listings snapshot the selected canvas at save time. Prompt packs and guides store the exact text you enter here, and buyers unlock lifetime access after purchase.
              </p>
            </div>

            <div className="rounded-[30px] border border-white/8 bg-zinc-950/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Available posts</div>
              <div className="mt-4 space-y-3">
                {initialDashboard.posts.length === 0 ? (
                  <p className="text-sm leading-7 text-zinc-400">
                    Publish a post first so buyers can see proof next to the listing.
                  </p>
                ) : (
                  initialDashboard.posts.slice(0, 5).map((post) => (
                    <div key={post.id} className="rounded-[20px] border border-white/8 bg-black/30 p-4">
                      <div className="text-sm font-medium text-white">{post.title}</div>
                      <div className="mt-1 text-xs text-zinc-500">
                        {post.category} · {post.visibility}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>
        </div>

        <div className="mt-10 grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_420px]">
          <section className="rounded-[32px] border border-white/8 bg-zinc-950/70 p-6 shadow-[0_24px_70px_rgba(0,0,0,0.4)] backdrop-blur-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Your listings</div>
                <h2 className="mt-3 text-2xl font-semibold text-white">Active inventory</h2>
              </div>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {initialDashboard.listings.length === 0 ? (
                <div className="rounded-[24px] border border-dashed border-white/10 bg-black/30 p-5 text-sm leading-7 text-zinc-400">
                  No listings yet. The first post you attach here becomes the proof layer for the marketplace.
                </div>
              ) : (
                initialDashboard.listings.map((listing) => (
                  <Link
                    key={listing.id}
                    href={`/marketplace/${listing.id}`}
                    className="rounded-[24px] border border-white/8 bg-black/35 p-5 transition hover:border-white/14 hover:bg-black/45"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">
                          {getMarketplaceAssetTypeLabel(listing.type)}
                        </div>
                        <div className="mt-2 text-lg font-semibold text-white">{listing.title}</div>
                      </div>
                      <div className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1 text-sm font-semibold text-emerald-50">
                        {formatUsdCents(listing.priceUsdCents)}
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-300">
                      {listing.description || listing.preview || 'Reusable system listing.'}
                    </p>
                    <div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
                      <span>{listing.status}</span>
                      <span>{listing.salesCount} sale{listing.salesCount === 1 ? '' : 's'}</span>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </section>

          <section className="rounded-[32px] border border-white/8 bg-zinc-950/70 p-6 shadow-[0_24px_70px_rgba(0,0,0,0.4)] backdrop-blur-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Recent sales</div>
            <div className="mt-5 space-y-3">
              {initialDashboard.sales.length === 0 ? (
                <p className="text-sm leading-7 text-zinc-400">
                  Sales will show up here once buyers unlock your listings.
                </p>
              ) : (
                initialDashboard.sales.slice(0, 8).map((sale) => (
                  <div key={sale.id} className="rounded-[22px] border border-white/8 bg-black/30 p-4">
                    <div className="text-sm font-medium text-white">{sale.assetTitle}</div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {sale.buyerLabel} · {new Date(sale.createdAt).toLocaleString()}
                    </div>
                    <div className="mt-2 text-sm text-zinc-300">
                      {sale.currency} {(sale.amountSubunits / 100).toLocaleString()} paid · {formatUsdCents(sale.priceUsdCents)} tracked
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
