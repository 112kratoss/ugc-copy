'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Filter,
  Layers3,
  Loader2,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';

import MarketplaceToolFilter from '@/app/marketplace/MarketplaceToolFilter';
import {
  MARKETPLACE_RECIPE_GRID_CLASS,
  MarketplaceRecipeTile,
  type MarketplaceRecipeTileLinkProps,
} from '@/app/marketplace/MarketplaceRecipeTile';
import { useAuth } from '@/components/AuthProvider';
import {
  getPostResourceKindLabel,
  type MarketplaceResourceFilter,
  type MarketplaceResourceKindFilter,
  type MarketplaceResourceSort,
} from '@/lib/post-resource-bundles';
import { useViewerRecipeState } from '@/app/marketplace/useViewerRecipeState';
import { buildShowcaseDetailPath } from '@/lib/share';
import type { SourceToolFilterOption } from '@/lib/source-tools';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';
import { MARKETPLACE_COMPACT_PAGE_SIZE } from '@/lib/marketplace-resource-list-cache-policy';
import { MARKETPLACE_SEARCH_MIN_LENGTH } from '@/lib/marketplace-search-policy';

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
  /**
   * A query under the search minimum: kept in the box and answered with the
   * hint, never applied (`initialFilters.q` stays empty).
   */
  shortQuery?: string;
  sourceToolOptions: SourceToolFilterOption[];
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
  shortQuery = '',
  sourceToolOptions,
}: MarketplaceBrowserProps) {
  const router = useRouter();
  const { session } = useAuth();
  // The signed-in viewer's own recipes, read apart from the cached catalog.
  const viewer = useViewerRecipeState();
  const [items, setItems] = useState(initialPage.items);
  const [pageInfo, setPageInfo] = useState(initialPage.pageInfo);
  const [searchInput, setSearchInput] = useState(initialFilters.q || shortQuery);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const loadMoreAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadMoreAbortControllerRef.current?.abort();
    loadMoreAbortControllerRef.current = null;
    // Navigation supplies a new result page; discard state from the previous query.
    setItems(initialPage.items);
    setPageInfo(initialPage.pageInfo);
    setSearchInput(initialFilters.q || shortQuery);
    setIsLoadingMore(false);
    setLoadError(null);
    setFiltersOpen(false);

    return () => {
      loadMoreAbortControllerRef.current?.abort();
      loadMoreAbortControllerRef.current = null;
    };
  }, [initialPage, initialFilters, shortQuery]);

  const activeFilterLabels = useMemo(() => [
    initialFilters.access !== 'all' ? (initialFilters.access === 'free' ? 'Free' : 'Paid') : null,
    initialFilters.resource !== 'all' ? getPostResourceKindLabel(initialFilters.resource) : null,
    initialFilters.tool ? sourceToolOptions.find((option) => option.slug === initialFilters.tool)?.label ?? initialFilters.tool : null,
    initialFilters.q ? `Search: ${initialFilters.q}` : null,
  ].filter(Boolean), [initialFilters, sourceToolOptions]);

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
    const controller = new AbortController();
    loadMoreAbortControllerRef.current?.abort();
    loadMoreAbortControllerRef.current = controller;

    try {
      const params = buildMarketplaceSearchParams({
        ...initialFilters,
        offset: pageInfo.nextOffset,
        // The server bootstrap is intentionally smaller than later pages.
        // Continue from its exact nextOffset using a compact page size that
        // bounds JSON parsing and DOM work on mobile.
        limit: MARKETPLACE_COMPACT_PAGE_SIZE,
      });
      // A signed-in viewer's pages are filtered for their blocks, which the
      // API can do only with the session; a signed-out request stays bare so
      // the edge can keep serving its shared copy.
      const accessToken = session?.access_token;
      const response = await fetch(`/api/marketplace/resources?${params.toString()}`, {
        headers: accessToken
          ? { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
          : { Accept: 'application/json' },
        signal: controller.signal,
      });
      const payload = await response.json() as {
        items?: MarketplaceResourceListItem[];
        pageInfo?: MarketplacePageInfo;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || 'Could not load more recipes.');
      }

      if (controller.signal.aborted || loadMoreAbortControllerRef.current !== controller) {
        return;
      }

      setItems((current) => {
        const nextItems = [...current];
        const seenIds = new Set(current.map((item) => item.id));
        for (const item of payload.items ?? []) {
          if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            nextItems.push(item);
          }
        }
        return nextItems;
      });
      if (payload.pageInfo) {
        setPageInfo(payload.pageInfo);
      }
    } catch (error) {
      if (!controller.signal.aborted && loadMoreAbortControllerRef.current === controller) {
        setLoadError(error instanceof Error ? error.message : 'Could not load more recipes.');
      }
    } finally {
      if (loadMoreAbortControllerRef.current === controller) {
        loadMoreAbortControllerRef.current = null;
        setIsLoadingMore(false);
      }
    }
  };

  return (
    <>
      {/* `relative z-20` is load-bearing: `backdrop-blur-sm` makes this panel a
          stacking context, so the tool dropdown's own z-index is scoped inside
          it and the card grid below would otherwise paint straight over the
          open menu. */}
      <div className="relative z-20 mt-8 rounded-[28px] border border-white/8 bg-zinc-950/70 p-4 backdrop-blur-sm sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Buyer filters
            </div>
            {activeFilterLabels.length > 0 ? (
              <p className="mt-1 text-sm text-zinc-400">Showing {activeFilterLabels.join(' + ')}</p>
            ) : (
              <p className="mt-1 text-sm text-zinc-400">All quality-checked public recipes from community posts.</p>
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
          <div className="grid gap-4 lg:grid-cols-[auto_1fr_15rem]">
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
            <MarketplaceToolFilter
              options={[
                { label: 'All tools', href: buildMarketplacePath({ ...initialFilters, tool: '' }), active: !initialFilters.tool },
                ...sourceToolOptions.map((sourceTool) => ({
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
                    ? 'border border-[rgba(255,122,89,0.3)] bg-[var(--ui-primary-soft)] font-semibold text-[var(--ui-text-primary)]'
                    : 'border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {shortQuery ? (
        <ResultsMessage
          icon={<Search className="mx-auto h-10 w-10 text-zinc-500" />}
          title={`Type at least ${MARKETPLACE_SEARCH_MIN_LENGTH} characters`}
          body="Keep typing, or clear the search to see every recipe."
          actionLabel="Clear search"
          actionHref={marketplaceReturnPath}
        />
      ) : items.length === 0 && !pageInfo.hasMore ? (
        // A page emptied by the viewer's blocks still has a next page to load,
        // so only a list with nothing left says there is nothing.
        activeFilterLabels.length > 0 ? (
          <ResultsMessage
            icon={<Filter className="mx-auto h-10 w-10 text-zinc-500" />}
            title="No recipes match"
            body="Try another search, or clear the filters to see every recipe."
            actionLabel="Clear filters"
            actionHref="/marketplace"
          />
        ) : (
          <ResultsMessage
            icon={<Layers3 className="mx-auto h-10 w-10 text-zinc-500" />}
            title="No recipes yet"
            body="Recipes need a useful public post, a creator profile, a buyer-facing preview, and reusable resources before they appear here."
            actionLabel="Share a post"
            actionHref="/post/new?from=marketplace&returnTo=%2Fmarketplace"
          />
        )
      ) : (
        <>
          <div className={MARKETPLACE_RECIPE_GRID_CLASS}>
            {items.map((asset) => (
              <MarketplaceRecipeTile
                key={asset.id}
                asset={asset}
                viewer={viewer}
                href={buildShowcaseDetailPath(asset.postId, {
                  from: 'unlocks',
                  returnTo: marketplaceReturnPath,
                  section: 'resources',
                })}
                linkComponent={RecipeTileLink}
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
                {isLoadingMore ? 'Loading' : 'Load more recipes'}
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

function ResultsMessage({
  icon,
  title,
  body,
  actionLabel,
  actionHref,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  actionLabel: string;
  actionHref: string;
}) {
  return (
    <div className="mt-10 rounded-[30px] border border-white/8 bg-zinc-950/70 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.35)] backdrop-blur-sm">
      {icon}
      <h2 className="mt-4 text-2xl font-semibold text-white">{title}</h2>
      <p className="mt-3 mx-auto max-w-xl text-sm leading-7 text-zinc-400">{body}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href={actionHref}
          className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
        >
          {actionLabel}
        </Link>
      </div>
    </div>
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
            // Selected controls speak the shell's language (coral), not a
            // content accent. Emerald here meant "Workflow" to anyone reading
            // the design system, on a chip that has nothing to do with
            // workflows — colour carrying meaning that isn't there.
            className={`shrink-0 rounded-full px-3 py-1.5 text-sm transition ${
              link.active
                ? 'border border-[rgba(255,122,89,0.3)] bg-[var(--ui-primary-soft)] font-semibold text-[var(--ui-text-primary)]'
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

/**
 * A tile's link, unprefetched as Explore's are: nothing is fetched for a recipe
 * the visitor only scrolls past.
 */
function RecipeTileLink(props: MarketplaceRecipeTileLinkProps) {
  return <Link {...props} prefetch={false} />;
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
