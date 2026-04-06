import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ArrowLeft, BookOpenText, Layers3, ShoppingBag, Wand2 } from 'lucide-react';

import { getServerAuthState } from '@/lib/supabase-server';
import { getMarketplaceAssetTypeLabel } from '@/lib/marketplace';
import { getMarketplaceAssetDetail } from '@/lib/marketplace-server';

import MarketplaceAssetActions from './MarketplaceAssetActions';

interface MarketplaceAssetPageProps {
  params: Promise<{ assetId: string }>;
}

export default async function MarketplaceAssetPage({ params }: MarketplaceAssetPageProps) {
  const { assetId } = await params;
  const auth = await getServerAuthState();
  const headerStore = await headers();
  const asset = await getMarketplaceAssetDetail(assetId, {
    viewerUserId: auth.session?.user?.id ?? null,
    countryCode: headerStore.get('x-vercel-ip-country'),
  });

  if (!asset) {
    notFound();
  }

  const workflowNodeCount = asset.content?.workflowGraph?.nodes.length ?? 0;
  const workflowEdgeCount = asset.content?.workflowGraph?.edges.length ?? 0;

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute left-[-10%] top-[-10%] h-[38%] w-[28%] rounded-full bg-emerald-500/10 blur-[150px]" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[34%] w-[26%] rounded-full bg-sky-500/10 blur-[150px]" />
      </div>

      <div className="studio-shell relative z-10 py-12 sm:py-16">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <Link
            href="/marketplace"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to marketplace
          </Link>

          {asset.post ? (
            <Link
              href={`/showcase/${asset.post.id}`}
              className="inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-400/10 px-4 py-2 text-sm font-medium text-emerald-50 transition hover:border-emerald-200/30 hover:bg-emerald-400/15"
            >
              View attached post
            </Link>
          ) : null}
        </div>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1.1fr)_420px]">
          <section className="space-y-6">
            <div className="overflow-hidden rounded-[32px] border border-white/8 bg-zinc-950/70 shadow-[0_28px_80px_rgba(0,0,0,0.45)] backdrop-blur-sm">
              <div className="relative border-b border-white/8 bg-black/60">
                {asset.post?.mediaUrl ? (
                  asset.post.mediaKind === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={asset.post.mediaUrl}
                      alt={asset.post.title}
                      className="max-h-[70vh] w-full object-cover"
                    />
                  ) : (
                    <video
                      src={asset.post.mediaUrl}
                      controls
                      autoPlay
                      loop
                      playsInline
                      className="max-h-[70vh] w-full object-cover"
                    />
                  )
                ) : asset.post?.postFormat === 'text' ? (
                  <div className="flex min-h-[340px] items-start bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.16),transparent_38%),linear-gradient(180deg,rgba(12,12,16,1),rgba(8,8,10,1))] p-6">
                    <article className="w-full rounded-[28px] border border-white/8 bg-zinc-950/85 p-6">
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Attached note</div>
                      <div className="mt-5 whitespace-pre-wrap text-base leading-8 text-zinc-100">
                        {asset.post.body || 'Text-only attached post'}
                      </div>
                    </article>
                  </div>
                ) : (
                  <div className="flex min-h-[340px] items-center justify-center bg-[radial-gradient(circle_at_top,rgba(52,211,153,0.18),transparent_40%),linear-gradient(180deg,rgba(12,12,16,1),rgba(8,8,10,1))] text-zinc-500">
                    <ShoppingBag className="h-10 w-10" />
                  </div>
                )}

                <div className="absolute left-5 top-5 rounded-full border border-black/20 bg-black/60 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white backdrop-blur-sm">
                  {getMarketplaceAssetTypeLabel(asset.type)}
                </div>
              </div>

              <div className="p-6 sm:p-8">
                <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
                  {asset.seller.username ? `@${asset.seller.username}` : asset.seller.name}
                </div>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  {asset.title}
                </h1>
                <p className="mt-4 text-sm leading-7 text-zinc-300 sm:text-base">
                  {asset.description || 'Reusable creative system from the community marketplace.'}
                </p>

                <div className="mt-6 grid gap-4 md:grid-cols-3">
                  <div className="rounded-[22px] border border-white/8 bg-black/40 p-4">
                    <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Sales</div>
                    <div className="mt-2 text-2xl font-semibold text-white">{asset.salesCount}</div>
                  </div>
                  <div className="rounded-[22px] border border-white/8 bg-black/40 p-4">
                    <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Listing type</div>
                    <div className="mt-2 text-lg font-semibold text-white">{getMarketplaceAssetTypeLabel(asset.type)}</div>
                  </div>
                  <div className="rounded-[22px] border border-white/8 bg-black/40 p-4">
                    <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Attached post</div>
                    <div className="mt-2 text-sm font-medium text-white">{asset.post?.title || 'Standalone listing'}</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Public preview</div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-300">
                {asset.preview || 'The seller did not add a preview snippet for this listing yet.'}
              </p>
            </div>

            {asset.viewerCanAccess ? (
              <>
                {asset.type === 'workflow' ? (
                  <div className="rounded-[30px] border border-emerald-500/15 bg-emerald-500/5 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-100/80">
                      <Wand2 className="h-4 w-4" />
                      Full workflow
                    </div>
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      <div className="rounded-[22px] border border-white/8 bg-black/30 p-4">
                        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Nodes</div>
                        <div className="mt-2 text-2xl font-semibold text-white">{workflowNodeCount}</div>
                      </div>
                      <div className="rounded-[22px] border border-white/8 bg-black/30 p-4">
                        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Connections</div>
                        <div className="mt-2 text-2xl font-semibold text-white">{workflowEdgeCount}</div>
                      </div>
                    </div>
                    <p className="mt-4 text-sm leading-7 text-zinc-300">
                      Importing creates a fresh copy in your workflow canvas so you can inspect and adapt the graph without touching the seller&apos;s original.
                    </p>
                  </div>
                ) : null}

                {asset.content?.promptPack ? (
                  <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
                      <Layers3 className="h-4 w-4" />
                      Prompt pack
                    </div>
                    <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-[22px] border border-white/8 bg-black/35 p-4 text-sm leading-7 text-zinc-100">
                      {asset.content.promptPack}
                    </pre>
                  </div>
                ) : null}

                {asset.content?.guideMarkdown ? (
                  <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
                      <BookOpenText className="h-4 w-4" />
                      Full guide
                    </div>
                    <article className="mt-4 whitespace-pre-wrap rounded-[22px] border border-white/8 bg-black/35 p-4 text-sm leading-7 text-zinc-100">
                      {asset.content.guideMarkdown}
                    </article>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
                <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Locked content</div>
                <p className="mt-3 text-sm leading-7 text-zinc-300">
                  Unlock the listing to access the full workflow, prompt pack, or guide. The public preview above stays visible so buyers can evaluate the value before purchasing.
                </p>
              </div>
            )}
          </section>

          <aside className="space-y-6">
            <MarketplaceAssetActions
              assetId={asset.id}
              type={asset.type}
              title={asset.title}
              priceLabel={asset.priceQuote.formatted}
              priceNote={asset.priceQuote.note}
              isFree={asset.priceUsdCents === 0}
              viewerCanAccess={asset.viewerCanAccess}
              viewerIsSeller={asset.viewerIsSeller}
              promptPack={asset.content?.promptPack ?? null}
              guideMarkdown={asset.content?.guideMarkdown ?? null}
              canImportWorkflow={asset.viewerCanAccess && asset.type === 'workflow' && Boolean(asset.content?.workflowGraph)}
            />

            {asset.post ? (
              <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
                <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Attached proof post</div>
                <h2 className="mt-3 text-lg font-semibold text-white">{asset.post.title}</h2>
                <p className="mt-2 text-sm leading-7 text-zinc-300">
                  This listing is attached to a {asset.post.category === 'ugc-ad' ? 'UGC ad' : asset.post.category} post in the community feed, so buyers can see the output it produced.
                </p>
                <Link
                  href={`/showcase/${asset.post.id}`}
                  className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                >
                  Open proof post
                </Link>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
