import Link from 'next/link';
import { headers } from 'next/headers';
import { ArrowRight, Layers3, ShoppingBag } from 'lucide-react';

import {
  getMarketplaceAssetList,
} from '@/lib/marketplace-server';
import {
  getMarketplaceAssetTypeLabel,
  normalizeMarketplaceAssetType,
  normalizeMarketplaceSort,
} from '@/lib/marketplace';

interface MarketplacePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function MarketplacePage({ searchParams }: MarketplacePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const type = normalizeMarketplaceAssetType(
    Array.isArray(resolvedSearchParams.type)
      ? resolvedSearchParams.type[0]
      : resolvedSearchParams.type
  );
  const sort = normalizeMarketplaceSort(
    Array.isArray(resolvedSearchParams.sort)
      ? resolvedSearchParams.sort[0]
      : resolvedSearchParams.sort
  );
  const headerStore = await headers();
  const countryCode = headerStore.get('x-vercel-ip-country');
  const assetPage = await getMarketplaceAssetList({
    type,
    sort,
    limit: 24,
    offset: 0,
    countryCode,
  });

  const filterLinks = [
    { label: 'All', href: `/marketplace?sort=${sort}`, active: type === 'all' },
    { label: 'Workflows', href: `/marketplace?type=workflow&sort=${sort}`, active: type === 'workflow' },
    { label: 'Prompt packs', href: `/marketplace?type=prompt_pack&sort=${sort}`, active: type === 'prompt_pack' },
    { label: 'Guides', href: `/marketplace?type=guide&sort=${sort}`, active: type === 'guide' },
  ];

  const sortLinks = [
    { label: 'Recent', href: `/marketplace${type === 'all' ? '' : `?type=${type}&`}sort=recent`, active: sort === 'recent' },
    { label: 'Top sales', href: `/marketplace${type === 'all' ? '?' : `?type=${type}&`}sort=top-sales`, active: sort === 'top-sales' },
  ];

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute left-[-8%] top-[-12%] h-[36%] w-[28%] rounded-full bg-emerald-500/10 blur-[140px]" />
        <div className="absolute bottom-[-14%] right-[-8%] h-[34%] w-[26%] rounded-full bg-sky-500/10 blur-[160px]" />
      </div>

      <div className="studio-shell relative z-10 py-12 sm:py-16">
        <div className="rounded-[34px] border border-white/8 bg-[linear-gradient(135deg,rgba(5,8,12,0.98),rgba(16,18,25,0.92))] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.5)] sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-100">
                <ShoppingBag className="h-3.5 w-3.5" />
                Creator marketplace
              </div>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                Buy the systems behind winning AI creative
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 sm:text-base">
                Workflows, prompt packs, and guides can now live next to the post that proved them. This turns the feed into a reusable knowledge network instead of a gallery of isolated outputs.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/marketplace/sell"
                className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
              >
                Sell your playbook
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/post/new"
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
              >
                Publish a post
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-5 rounded-[28px] border border-white/8 bg-zinc-950/70 p-5 backdrop-blur-sm">
          <div className="flex flex-wrap gap-2">
            {filterLinks.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                  link.active
                    ? 'border border-emerald-300/30 bg-emerald-400/15 text-emerald-50'
                    : 'border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {sortLinks.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className={`rounded-full px-4 py-2 text-sm transition ${
                  link.active
                    ? 'border border-sky-300/30 bg-sky-400/15 text-sky-50'
                    : 'border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>

        {assetPage.items.length === 0 ? (
          <div className="mt-10 rounded-[30px] border border-white/8 bg-zinc-950/70 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.35)] backdrop-blur-sm">
            <Layers3 className="mx-auto h-10 w-10 text-zinc-500" />
            <h2 className="mt-4 text-2xl font-semibold text-white">No listings yet</h2>
            <p className="mt-3 mx-auto max-w-xl text-sm leading-7 text-zinc-400">
              The marketplace is ready for workflows, prompt packs, and guides. Publish a post, attach the system behind it, and start the first layer of creator-to-creator commerce.
            </p>
            <Link
              href="/marketplace/sell"
              className="mt-6 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
            >
              Create a listing
            </Link>
          </div>
        ) : (
          <div className="mt-10 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {assetPage.items.map((asset) => (
              <Link
                key={asset.id}
                href={`/marketplace/${asset.id}`}
                className="group overflow-hidden rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(18,18,22,0.98),rgba(10,10,14,0.98))] shadow-[0_24px_70px_rgba(0,0,0,0.35)] transition hover:border-white/14 hover:shadow-[0_28px_90px_rgba(0,0,0,0.45)]"
              >
                <div className="relative overflow-hidden border-b border-white/8 bg-black/60">
                  {asset.post?.mediaUrl ? (
                    asset.post.mediaKind === 'image' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={asset.post.mediaUrl}
                        alt={asset.post.title}
                        className="h-64 w-full object-cover transition duration-500 group-hover:scale-[1.02]"
                      />
                    ) : (
                      <video
                        src={asset.post.mediaUrl}
                        muted
                        playsInline
                        loop
                        autoPlay
                        className="h-64 w-full object-cover transition duration-500 group-hover:scale-[1.02]"
                      />
                    )
                  ) : asset.post?.postFormat === 'text' ? (
                    <div className="flex h-64 items-start bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.16),transparent_38%),linear-gradient(180deg,rgba(18,18,24,1),rgba(8,8,12,1))] p-5">
                      <div className="w-full rounded-[1.4rem] border border-white/8 bg-zinc-950/80 p-5">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Attached note</div>
                        <p className="mt-4 line-clamp-7 whitespace-pre-wrap text-sm leading-7 text-zinc-100">
                          {asset.post.body || 'Text-only attached post'}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-64 items-center justify-center bg-[radial-gradient(circle_at_top,rgba(52,211,153,0.25),transparent_45%),linear-gradient(180deg,rgba(24,24,30,1),rgba(10,10,12,1))] text-zinc-500">
                      <ShoppingBag className="h-9 w-9" />
                    </div>
                  )}

                  <div className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-full border border-black/20 bg-black/55 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white backdrop-blur-sm">
                    {getMarketplaceAssetTypeLabel(asset.type)}
                  </div>

                  {asset.post?.sourceTool ? (
                    <div className="absolute right-4 top-4 rounded-full border border-black/20 bg-black/55 px-3 py-1 text-[11px] font-medium text-zinc-100 backdrop-blur-sm">
                      Made with {asset.post.sourceTool}
                    </div>
                  ) : null}
                </div>

                <div className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
                        {asset.seller.username ? `@${asset.seller.username}` : asset.seller.name}
                      </div>
                      <h2 className="mt-2 text-xl font-semibold text-white">{asset.title}</h2>
                    </div>
                    <div className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1.5 text-sm font-semibold text-emerald-50">
                      {asset.priceQuote.formatted}
                    </div>
                  </div>

                  <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-300">
                    {asset.description || asset.preview || 'Reusable creative system ready to unlock.'}
                  </p>

                  <div className="mt-5 flex items-center justify-between text-xs text-zinc-500">
                    <span>{asset.salesCount} sale{asset.salesCount === 1 ? '' : 's'}</span>
                    <span>{asset.post ? asset.post.title : 'Standalone listing'}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
