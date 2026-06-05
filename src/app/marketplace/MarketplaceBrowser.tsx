'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Filter,
  Layers3,
  Loader2,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  X,
} from 'lucide-react';

import TextPostPreviewCard from '@/app/components/TextPostPreviewCard';
import {
  describePostResourceKinds,
  formatUnlockCountLabel,
  getPostResourceKindLabel,
  type MarketplaceResourceFilter,
  type MarketplaceResourceKindFilter,
  type MarketplaceResourceSort,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import { buildShowcaseDetailPath } from '@/lib/share';
import { CURATED_SOURCE_TOOLS, getSourceToolLabel } from '@/lib/source-tools';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';
import { HoverVideo } from '@/app/components/HoverVideo';

interface MarketplacePageInfo {
  hasMore: boolean;
  nextOffset: number | null;
  offset: number;
  limit: number;
}

interface MarketplaceResourcePage {
  items: MarketplaceResourceListItem[];
  pageInfo: MarketplacePageInfo;
}

interface MarketplaceBrowserProps {
  initialPage: MarketplaceResourcePage;
  initialFilters: {
    access: MarketplaceResourceFilter;
    resource: MarketplaceResourceKindFilter;
    tool: string;
    sort: MarketplaceResourceSort;
    q: string;
  };
}

const SORT_LINKS: Array<{ label: string; value: MarketplaceResourceSort }> = [
  { label: 'Recent', value: 'recent' },
  { label: 'Top sales', value: 'top-sales' },
  { label: 'Price low', value: 'price-low' },
  { label: 'Price high', value: 'price-high' },
];

const RESOURCE_LINKS: Array<{ label: string; value: MarketplaceResourceKindFilter }> = [
  { label: 'All kinds', value: 'all' },
  { label: 'Prompt', value: 'prompt' },
  { label: 'Workflow', value: 'workflow' },
  { label: 'Files', value: 'files' },
  { label: 'Notes', value: 'notes' },
  { label: 'Remix', value: 'remix' },
];

export default function MarketplaceBrowser({
  initialPage,
  initialFilters,
}: MarketplaceBrowserProps) {
  const router = useRouter();
  const [items, setItems] = useState(initialPage.items);
  const [pageInfo, setPageInfo] = useState(initialPage.pageInfo);
  const [searchInput, setSearchInput] = useState(initialFilters.q);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    setItems(initialPage.items);
    setPageInfo(initialPage.pageInfo);
    setSearchInput(initialFilters.q);
    setLoadError(null);
    setFiltersOpen(false);
  }, [initialPage, initialFilters]);

  const activeFilterLabels = useMemo(() => [
    initialFilters.access !== 'all' ? (initialFilters.access === 'free' ? 'Free' : 'Paid') : null,
    initialFilters.resource !== 'all' ? getPostResourceKindLabel(initialFilters.resource) : null,
    initialFilters.tool ? getSourceToolLabel(initialFilters.tool) : null,
    initialFilters.q ? `Search: ${initialFilters.q}` : null,
  ].filter(Boolean), [initialFilters]);

  const hasActiveFilters = activeFilterLabels.length > 0 || initialFilters.sort !== 'recent';
  const marketplaceReturnPath = buildMarketplacePath(initialFilters);

  const onSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    router.push(buildMarketplacePath({
      ...initialFilters,
      q: searchInput,
    }));
  };

  const loadMore = async () => {
    if (isLoadingMore || !pageInfo.hasMore || pageInfo.nextOffset === null) {
      return;
    }

    setIsLoadingMore(true);
    setLoadError(null);

    try {
      const params = buildMarketplaceSearchParams({
        ...initialFilters,
        offset: pageInfo.nextOffset,
        limit: pageInfo.limit,
      });
      const response = await fetch(`/api/marketplace/resources?${params.toString()}`, {
        headers: {
          Accept: 'application/json',
        },
      });
      const payload = await response.json() as {
        items?: MarketplaceResourceListItem[];
        pageInfo?: MarketplacePageInfo;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || 'Could not load more unlocks.');
      }

      setItems((current) => [...current, ...(payload.items ?? [])]);
      if (payload.pageInfo) {
        setPageInfo(payload.pageInfo);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load more unlocks.');
    } finally {
      setIsLoadingMore(false);
    }
  };

  return (
    <>
      <div className="mt-8 rounded-[28px] border border-white/8 bg-zinc-950/70 p-4 backdrop-blur-sm sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Buyer filters
            </div>
            {activeFilterLabels.length > 0 ? (
              <p className="mt-1 text-sm text-zinc-400">Showing {activeFilterLabels.join(' + ')}</p>
            ) : (
              <p className="mt-1 text-sm text-zinc-400">All quality-checked public unlocks from community posts.</p>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <form onSubmit={onSearchSubmit} className="flex min-w-0 rounded-full border border-white/10 bg-black/35 p-1">
              <label className="flex min-w-0 flex-1 items-center gap-2 px-3 text-sm text-zinc-400">
                <Search className="h-4 w-4 shrink-0" />
                <input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Search prompts, tools, creators"
                  className="w-full min-w-[190px] bg-transparent py-2 text-sm text-white outline-none placeholder:text-zinc-600"
                />
              </label>
              <button
                type="submit"
                className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-zinc-200"
              >
                Search
              </button>
            </form>

            <button
              type="button"
              onClick={() => setFiltersOpen((value) => !value)}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08] lg:hidden"
            >
              <Filter className="h-4 w-4" />
              Filters
            </button>

            {hasActiveFilters ? (
              <Link
                href="/marketplace"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
              >
                <X className="h-4 w-4" />
                Clear
              </Link>
            ) : null}
          </div>
        </div>

        <div className={`${filtersOpen ? 'block' : 'hidden'} mt-5 lg:block`}>
          <div className="grid gap-4 lg:grid-cols-[0.75fr_1fr_1fr]">
            <FilterGroup
              label="Access"
              links={[
                { label: 'All', href: buildMarketplacePath({ ...initialFilters, access: 'all' }), active: initialFilters.access === 'all' },
                { label: 'Free', href: buildMarketplacePath({ ...initialFilters, access: 'free' }), active: initialFilters.access === 'free' },
                { label: 'Paid', href: buildMarketplacePath({ ...initialFilters, access: 'paid' }), active: initialFilters.access === 'paid' },
              ]}
            />
            <FilterGroup
              label="Kind"
              links={RESOURCE_LINKS.map((item) => ({
                label: item.label,
                href: buildMarketplacePath({ ...initialFilters, resource: item.value }),
                active: initialFilters.resource === item.value,
              }))}
            />
            <FilterGroup
              label="Tool"
              links={[
                { label: 'All tools', href: buildMarketplacePath({ ...initialFilters, tool: '' }), active: !initialFilters.tool },
                ...CURATED_SOURCE_TOOLS.map((sourceTool) => ({
                  label: sourceTool.label,
                  href: buildMarketplacePath({ ...initialFilters, tool: sourceTool.slug }),
                  active: initialFilters.tool === sourceTool.slug,
                })),
              ]}
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {SORT_LINKS.map((link) => (
              <Link
                key={link.value}
                href={buildMarketplacePath({ ...initialFilters, sort: link.value })}
                className={`rounded-full px-4 py-2 text-sm transition ${
                  initialFilters.sort === link.value
                    ? 'border border-sky-300/30 bg-sky-400/15 text-sky-50'
                    : 'border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="mt-10 rounded-[30px] border border-white/8 bg-zinc-950/70 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.35)] backdrop-blur-sm">
          <Layers3 className="mx-auto h-10 w-10 text-zinc-500" />
          <h2 className="mt-4 text-2xl font-semibold text-white">No unlocks yet</h2>
          <p className="mt-3 mx-auto max-w-xl text-sm leading-7 text-zinc-400">
            Unlocks need a useful public post, a creator profile, buyer-facing preview, and reusable resources before they appear here.
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
        <>
          <div className="mt-10 columns-1 gap-6 space-y-6 md:columns-2 xl:columns-3">
            {items.map((asset) => (
              <MarketplaceCard
                key={asset.id}
                asset={asset}
                marketplaceReturnPath={marketplaceReturnPath}
              />
            ))}
          </div>

          {pageInfo.hasMore ? (
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={isLoadingMore}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLoadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                {isLoadingMore ? 'Loading' : 'Load more unlocks'}
              </button>
            </div>
          ) : null}

          {loadError ? (
            <div className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-center text-sm text-rose-50">
              {loadError}
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

function FilterGroup({
  label,
  links,
}: {
  label: string;
  links: Array<{ label: string; href: string; active: boolean }>;
}) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {links.map((link) => (
          <Link
            key={link.label}
            href={link.href}
            className={`shrink-0 rounded-full px-3 py-1.5 text-sm transition ${
              link.active
                ? 'border border-emerald-300/30 bg-emerald-400/15 text-emerald-50'
                : 'border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
            }`}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

function MarketplaceCard({
  asset,
  marketplaceReturnPath,
}: {
  asset: MarketplaceResourceListItem;
  marketplaceReturnPath: string;
}) {
  const accessLabel = formatBundleAccessLabel({
    accessMode: asset.accessMode,
    priceQuote: asset.priceQuote,
  });
  const unlockCtaLabel = asset.accessMode === 'free'
    ? 'Open free unlock'
    : `Unlock for ${asset.priceQuote.formatted}`;
  const updatedLabel = formatMarketplaceDate(asset.updatedAt);
  const detailHref = buildShowcaseDetailPath(asset.postId, {
    from: 'unlocks',
    returnTo: marketplaceReturnPath,
    section: 'resources',
  });

  return (
    <Link
      href={detailHref}
      aria-label={`${unlockCtaLabel}: ${asset.title}`}
      className="group mb-6 block break-inside-avoid overflow-hidden rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(18,18,22,0.98),rgba(10,10,14,0.98))] shadow-[0_24px_70px_rgba(0,0,0,0.35)] transition hover:border-white/14 hover:shadow-[0_28px_90px_rgba(0,0,0,0.45)]"
    >
      <div className="relative overflow-hidden border-b border-white/8 bg-black/60">
        {asset.post?.mediaUrl ? (
          asset.post.mediaKind === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={asset.post.mediaUrl}
              alt={asset.post.title}
              loading="lazy"
              decoding="async"
              className="h-64 w-full object-cover transition duration-500 group-hover:scale-[1.02]"
            />
          ) : (
            <HoverVideo
              src={asset.post.mediaUrl}
              className="h-64 w-full object-cover transition duration-500 group-hover:scale-[1.02]"
            />
          )
        ) : asset.post?.postFormat === 'text' ? (
          <TextPostPreviewCard
            title={asset.post.title}
            summary={asset.post.body || asset.summary || asset.previewText || describePostResourceKinds(asset.resourceKinds)}
            sourceLabel={asset.post.sourceTool || asset.post.sourceKind}
            dateLabel={updatedLabel}
            unlockLabel={accessLabel}
            resourceKinds={asset.resourceKinds}
            className="rounded-none border-0 shadow-none"
          />
        ) : (
          <div className="flex h-64 items-center justify-center bg-[radial-gradient(circle_at_top,rgba(52,211,153,0.25),transparent_45%),linear-gradient(180deg,rgba(24,24,30,1),rgba(10,10,12,1))] text-zinc-500">
            <ShoppingBag className="h-9 w-9" />
          </div>
        )}

        {asset.post?.postFormat !== 'text' ? (
          <div className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-full border border-black/20 bg-black/55 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white backdrop-blur-sm">
            {accessLabel}
          </div>
        ) : null}

        {asset.post?.postFormat !== 'text' && asset.post?.sourceTool ? (
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
          <div className="shrink-0 rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1.5 text-sm font-semibold text-emerald-50">
            {asset.priceQuote.formatted}
          </div>
        </div>

        <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-300">
          {asset.summary || asset.previewText || describePostResourceKinds(asset.resourceKinds)}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {(asset.resourceKinds ?? []).map((kind: PostResourceKind) => (
            <div
              key={`${asset.id}-${kind}`}
              className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-200"
            >
              {getPostResourceKindLabel(kind)}
            </div>
          ))}
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2 text-xs text-zinc-500">
          <span>{formatUnlockCountLabel(asset.accessMode, asset.salesCount)}</span>
          <span className="text-center">Updated {updatedLabel}</span>
          <span className="text-right font-semibold text-zinc-200">{unlockCtaLabel}</span>
        </div>
      </div>
    </Link>
  );
}

function formatMarketplaceDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

function buildMarketplacePath(filters: MarketplaceBrowserProps['initialFilters']): string {
  const params = buildMarketplaceSearchParams(filters);
  return params.size > 0 ? `/marketplace?${params.toString()}` : '/marketplace';
}

function buildMarketplaceSearchParams(filters: MarketplaceBrowserProps['initialFilters'] & {
  offset?: number;
  limit?: number;
}) {
  const params = new URLSearchParams();

  if (filters.access !== 'all') {
    params.set('access', filters.access);
  }
  if (filters.resource !== 'all') {
    params.set('resource', filters.resource);
  }
  if (filters.tool) {
    params.set('tool', filters.tool);
  }
  if (filters.q.trim()) {
    params.set('q', filters.q.trim());
  }
  if (filters.sort !== 'recent') {
    params.set('sort', filters.sort);
  } else if (filters.offset === undefined) {
    params.set('sort', 'recent');
  }
  if (filters.offset !== undefined) {
    params.set('offset', String(filters.offset));
  }
  if (filters.limit !== undefined) {
    params.set('limit', String(filters.limit));
  }

  return params;
}
