'use client';

import Link from 'next/link';
import { useEffect, useEffectEvent, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
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

import MarketplaceFiltersButton, {
  MARKETPLACE_FILTERS_ID,
  MarketplaceFiltersSummary,
} from '@/app/marketplace/MarketplaceFiltersButton';
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
import {
  buildMarketplacePagesKey,
  marketplacePagesViewer,
  recallMarketplacePages,
  rememberMarketplaceFiltersOpen,
  rememberMarketplacePages,
  withRememberedPages,
  type MarketplacePages,
} from '@/lib/marketplace-pages-memory';

import { MarketplaceListingFailed, MarketplaceListingSkeleton } from './MarketplaceListingStates';
import { countMarketplaceFiltersSet, isPlainLinkClick, marketplaceFiltersKey } from './marketplace-address';
import type { MarketplaceListingStatus } from './useMarketplaceListing';

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

/** The recipes drawn, of which listing, and whether they are the ones kept for it. */
interface DrawnListing extends MarketplaceResourcePage {
  /** `marketplaceFiltersKey` of the listing they are of. */
  key: string;
  /** Drawn behind the first page from what was kept (marketplace-pages-memory). */
  kept: boolean;
  /** Whose kept pages they are (`marketplacePagesViewer` as the listing was opened); null, a visitor's. */
  viewer: string | null;
  /**
   * The first page it was opened from, kept through every Load more. A Load more reads on only from
   * a list opened from the first page the browser is given now: in the render a new one arrives in
   * (the reader's own, their blocks taken out), the start it calls for is not drawn yet, and a page
   * appended to the list still drawn brought the cached page's recipes back (review of #837).
   */
  openedFrom: MarketplaceResourcePage;
}

/** A listing as the browser starts drawing it: its first page, and what was kept of it behind. */
function openListing(
  key: string,
  viewer: string | null,
  firstPage: MarketplaceResourcePage,
  kept: MarketplacePages | null,
): DrawnListing {
  const drawn = withRememberedPages(firstPage, kept);
  return { key, viewer, items: drawn.items, pageInfo: drawn.pageInfo, kept: drawn !== firstPage, openedFrom: firstPage };
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
  /**
   * Where the listing for the address stands (`useMarketplaceListing`): the
   * page is cached for everyone, so a filter or a search is read in the
   * browser, and the list says so while it is.
   */
  listingStatus?: MarketplaceListingStatus;
  /**
   * Whether `initialPage` is the listing's own for its address and viewer (`useMarketplaceListing`'s
   * `settled`): until it is, the read under way will start the list again.
   */
  listingSettled?: boolean;
  /**
   * The listing (`marketplaceFiltersKey`) whose "Load more recipes" was pressed on the first-paint
   * shell, which brought this list in: its next page is asked for as soon as the list can read on,
   * so the one press both opens the list and loads more (live sweep, 2026-11-17).
   */
  loadMoreOnOpen?: string | null;
  /** The filters as the shell left them, open or folded behind Filters, so the hand-over moves nothing. */
  initialFiltersOpen?: boolean;
  /**
   * Moves the page to another listing in place. Without it, a filter or a
   * search navigates with the router.
   */
  onNavigate?: (href: string) => void;
  onRetry?: () => void;
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
  listingStatus = 'ready',
  listingSettled = true,
  loadMoreOnOpen = null,
  initialFiltersOpen = false,
  onNavigate,
  onRetry,
}: MarketplaceBrowserProps) {
  const router = useRouter();
  const { session, user, isLoading: isViewerLoading } = useAuth();
  // The signed-in viewer's own recipes, read apart from the cached catalog.
  const viewer = useViewerRecipeState();
  // What "Load more" brought to this listing, kept for the tab: Back from a recipe draws it again
  // in the first render, and the page's height with it, so the reader lands where they were
  // (marketplace-pages-memory; never anything kept before this document loaded, so a page the
  // server drew hydrates on its first page alone). Read for the viewer the session cookie names
  // while this page's auth provider is still asking, as the shell's hand-over reads it.
  const listingKey = marketplaceFiltersKey(initialFilters);
  const pagesViewer = marketplacePagesViewer({ userId: user?.id ?? null, isLoading: isViewerLoading });
  const pagesKey = buildMarketplacePagesKey(listingKey, pagesViewer);
  const [listing, setListing] = useState(() => openListing(listingKey, pagesViewer, initialPage, recallMarketplacePages(pagesKey)));
  // The reader the session cookie names, while the page is still asking who is signed in: their
  // kept pages are drawn, and Load more waits for their session, as the listing's first page does
  // (`useMarketplaceListing`), so that what it brings is asked for, and kept, as theirs. Asked
  // without it, the page was kept as a visitor's, and the reader's own listing, drawn again once
  // the session came, went back to what it held before the press (review of #835).
  const awaitingViewer = pagesViewer !== null && !session?.access_token;
  const { items, pageInfo } = listing;
  // While the listing's own first page is on its way, what was kept of it stands in for it.
  const drawsKeptListing = listing.kept && listing.key === listingKey;
  const [searchInput, setSearchInput] = useState(initialFilters.q || shortQuery);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(initialFiltersOpen);
  // A Load more pressed and not yet brought: the shell's, handed over with this list, or this list's
  // own pressed while the listing's own first page was still read. Cleared once that page is drawn,
  // or has failed; a list started again meanwhile (its own first page landing, another viewer) asks
  // for it again from where the new start leaves it.
  const [pressedListingKey, setPressedListingKey] = useState(() => (loadMoreOnOpen === listingKey ? listingKey : null));
  const pressPending = pressedListingKey !== null && pressedListingKey === listingKey;
  // The list drawn is opened from the first page the list is given now, and that page is the
  // listing's own for its viewer: a Load more may read on from it.
  const drawnFromFirstPage = listing.openedFrom === initialPage;
  const readyToReadOn = listingSettled && drawnFromFirstPage;
  const loadMoreAbortControllerRef = useRef<AbortController | null>(null);
  // A Load more the last start of the list cut short, for the next start to ask for again.
  const cutShortRef = useRef(false);
  // The listing the filters were last opened or folded for: a filter picked folds them, while the
  // same listing read again (the reader's own first page landing) leaves them as the reader has them.
  const filtersListingKeyRef = useRef(listingKey);

  /** Stops the Load more under way, if there is one; says whether there was. */
  const stopLoadMore = () => {
    const controller = loadMoreAbortControllerRef.current;
    loadMoreAbortControllerRef.current = null;
    controller?.abort();
    return controller !== null;
  };

  // Who is looking is read when the listing starts again, and is no reason to start it: the
  // session arriving after a full load would cut a Load more short and the search being typed.
  const restartListing = useEffectEvent((cutShort: boolean) => {
    setListing(openListing(listingKey, pagesViewer, initialPage, recallMarketplacePages(pagesKey)));
    if (pressedListingKey !== null && pressedListingKey !== listingKey) {
      // A press for the listing left behind brings nothing to the new one.
      setPressedListingKey(null);
    } else if (cutShort && listing.key === listingKey) {
      // The same listing started again (the reader's own first page landing) under a Load more: it is
      // asked for again from the new start, not lost (review of #837).
      setPressedListingKey(listingKey);
    }
    if (filtersListingKeyRef.current !== listingKey) {
      filtersListingKeyRef.current = listingKey;
      setFiltersOpen(false);
    }
  });

  useEffect(() => {
    const cutShort = stopLoadMore() || cutShortRef.current;
    cutShortRef.current = false;
    // Navigation supplies a new result page; discard state from the previous query, keeping the
    // later pages this listing loaded before behind its first page.
    restartListing(cutShort);
    setSearchInput(initialFilters.q || shortQuery);
    setIsLoadingMore(false);
    setLoadError(null);

    return () => {
      cutShortRef.current = stopLoadMore();
    };
  }, [initialPage, initialFilters, shortQuery]);

  // Pages kept for the reader the session cookie named, who turned out not to be signed in (their
  // session ended elsewhere): the listing is drawn again as the one of whoever is looking, so that
  // reader's pages, filtered for their blocks, are not shown on, nor kept as a visitor's by the
  // next Load more (review of #835). The same reader confirmed changes nothing; a Load more under
  // way is asked for again, as the new viewer's.
  const redrawForAnotherViewer = useEffectEvent(() => {
    if (!listing.kept || listing.viewer === pagesViewer) return;
    if (stopLoadMore()) setPressedListingKey(listingKey);
    setIsLoadingMore(false);
    setListing(openListing(listingKey, pagesViewer, initialPage, recallMarketplacePages(pagesKey)));
  });

  useEffect(() => {
    redrawForAnotherViewer();
  }, [pagesViewer]);

  // What Back draws on a phone: the filters as the reader leaves them on this listing, open or folded
  // (review of #837; the shell reads it as it is drawn again).
  useEffect(() => {
    rememberMarketplaceFiltersOpen(listingKey, filtersOpen);
  }, [listingKey, filtersOpen]);

  const activeFilterLabels = useMemo(() => [
    initialFilters.access !== 'all' ? (initialFilters.access === 'free' ? 'Free' : 'Paid') : null,
    initialFilters.resource !== 'all' ? getPostResourceKindLabel(initialFilters.resource) : null,
    initialFilters.tool ? sourceToolOptions.find((option) => option.slug === initialFilters.tool)?.label ?? initialFilters.tool : null,
    initialFilters.q ? `Search: ${initialFilters.q}` : null,
  ].filter((label): label is string => Boolean(label)), [initialFilters, sourceToolOptions]);

  const hasActiveFilters = activeFilterLabels.length > 0 || initialFilters.sort !== 'recent';
  const marketplaceReturnPath = buildMarketplacePath(initialFilters);

  const navigateTo = (href: string) => {
    if (onNavigate) onNavigate(href);
    else router.push(href);
  };
  // A plain click on an address of this page moves the listing in place.
  const navigateOnPlainClick = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onNavigate || !isPlainLinkClick(event)) return;
    event.preventDefault();
    onNavigate(href);
  };

  const onSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigateTo(buildMarketplacePath({
      ...initialFilters,
      q: searchInput,
    }));
  };

  const loadMore = async () => {
    // Only from a list opened from the listing's own first page; a press waits until it is drawn.
    if (!readyToReadOn || awaitingViewer || isLoadingMore) {
      return;
    }
    if (!pageInfo.hasMore || pageInfo.nextOffset === null) {
      // The list as it stands has nothing after it: a press waiting on it has nothing to bring.
      setPressedListingKey(null);
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

      // From the list as drawn: one Load more runs at a time, and nothing else adds to it meanwhile.
      const nextItems = [...items];
      const seenIds = new Set(items.map((item) => item.id));
      for (const item of payload.items ?? []) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          nextItems.push(item);
        }
      }
      const nextListing = { ...listing, items: nextItems, pageInfo: payload.pageInfo ?? pageInfo };
      setListing(nextListing);
      setPressedListingKey(null);
      // Kept under the account the page was asked for: a page asked without a session is a
      // visitor's, never drawn for the account the cookie names.
      rememberMarketplacePages(
        buildMarketplacePagesKey(listingKey, accessToken ? user?.id ?? null : null),
        initialPage.items.length,
        nextListing,
      );
    } catch (error) {
      if (!controller.signal.aborted && loadMoreAbortControllerRef.current === controller) {
        setLoadError(error instanceof Error ? error.message : 'Could not load more recipes.');
        // Said in the error: the button is offered again.
        setPressedListingKey(null);
      }
    } finally {
      if (loadMoreAbortControllerRef.current === controller) {
        loadMoreAbortControllerRef.current = null;
        setIsLoadingMore(false);
      }
    }
  };

  // A press waiting (the shell's, or this list's own made too early): its page is asked for once the
  // list can read on, the listing's own first page landed and drawn and a signed-in reader's session
  // here. A press made before the reader's first page came would otherwise be cut short by that
  // page's arrival, or appended to the cached page it replaces.
  const readsOnForPress = pressPending && readyToReadOn && !awaitingViewer && !isLoadingMore;
  const loadPressedPage = useEffectEvent(() => {
    // Read again as the timer runs, from the latest render: a newer start may have come since.
    if (readsOnForPress) void loadMore();
  });
  // This list's own Load more: asked at once from a list ready to read on; pressed while the
  // listing's own first page is still read (a signed-in reader's took about 1.5 s live), it waits
  // for it as the shell's press does (review of #837: that page's arrival cut it short).
  const pressLoadMore = () => {
    if (readyToReadOn) void loadMore();
    else setPressedListingKey(listingKey);
  };
  useEffect(() => {
    if (!readsOnForPress) return;
    // Asked a task later: React's development double effect cancels the first of its two runs here,
    // where a request it had sent would be cut short and sent again.
    const timer = window.setTimeout(() => loadPressedPage(), 0);
    return () => window.clearTimeout(timer);
  }, [readsOnForPress]);

  return (
    <>
      {/* `relative z-20` is load-bearing: `backdrop-blur-sm` makes this panel a
          stacking context, so the tool dropdown's own z-index is scoped inside
          it and the card grid below would otherwise paint straight over the
          open menu. */}
      {/* Below 1024px it is drawn as the shell draws it (`MarketplaceBootstrap`), Filters beside the
          heading and the filters folded, so the hand-over between the two moves no recipe. */}
      <div className="relative z-20 mt-4 rounded-3xl border border-white/8 bg-zinc-950/70 p-4 backdrop-blur-sm sm:mt-8 sm:p-5">
        <div className="flex flex-col gap-3 sm:gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Buyer filters
              </div>
              <MarketplaceFiltersSummary
                filterLabels={activeFilterLabels}
                sortLabel={SORT_LINKS.find((link) => link.value === initialFilters.sort && link.value !== 'recent')?.label ?? null}
              />
            </div>
            <MarketplaceFiltersButton
              open={filtersOpen}
              onToggle={() => setFiltersOpen((value) => !value)}
              controls={MARKETPLACE_FILTERS_ID}
              setCount={countMarketplaceFiltersSet(initialFilters)}
            />
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <form onSubmit={onSearchSubmit} className="flex min-w-0 rounded-full border border-white/10 bg-black/35 p-1">
              <label className="flex min-w-0 flex-1 items-center gap-2 px-3 text-sm text-zinc-400">
                <Search className="h-4 w-4 shrink-0" />
                <input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Search recipes"
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

            {hasActiveFilters ? (
              <Link
                href="/marketplace"
                prefetch={false}
                onClick={navigateOnPlainClick('/marketplace')}
                className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
              >
                <X className="h-4 w-4" />
                Clear
              </Link>
            ) : null}
          </div>
        </div>

        <div id={MARKETPLACE_FILTERS_ID} className={`${filtersOpen ? 'block' : 'hidden'} mt-5 lg:block`}>
          <div className="grid gap-4 lg:grid-cols-[auto_1fr_15rem]">
            <FilterGroup
              label="Access"
              links={[
                { label: 'All', href: buildMarketplacePath({ ...initialFilters, access: 'all' }), active: initialFilters.access === 'all' },
                { label: 'Free', href: buildMarketplacePath({ ...initialFilters, access: 'free' }), active: initialFilters.access === 'free' },
                { label: 'Paid', href: buildMarketplacePath({ ...initialFilters, access: 'paid' }), active: initialFilters.access === 'paid' },
              ]}
              onNavigate={onNavigate ? navigateOnPlainClick : undefined}
            />
            <FilterGroup
              label="Kind"
              links={RESOURCE_LINKS.map((item) => ({
                label: item.label,
                href: buildMarketplacePath({ ...initialFilters, resource: item.value }),
                active: initialFilters.resource === item.value,
              }))}
              onNavigate={onNavigate ? navigateOnPlainClick : undefined}
            />
            <MarketplaceToolFilter
              onNavigate={onNavigate}
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
                prefetch={onNavigate ? false : undefined}
                onClick={navigateOnPlainClick(buildMarketplacePath({ ...initialFilters, sort: link.value }))}
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
          onActionClick={navigateOnPlainClick(marketplaceReturnPath)}
        />
      ) : listingStatus === 'loading' && !drawsKeptListing ? (
        <MarketplaceListingSkeleton />
      ) : listingStatus === 'failed' && !drawsKeptListing ? (
        <MarketplaceListingFailed onRetry={() => onRetry?.()} />
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
            onActionClick={navigateOnPlainClick('/marketplace')}
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
                // The post at its top, as every other way in opens it: named after its recipe's
                // section (#recipe), a post shorter than that opened at its foot, the picture under
                // the top bar and the title and the way back above the window (owner, 2026-11-16).
                href={buildShowcaseDetailPath(asset.postId, {
                  from: 'unlocks',
                  returnTo: marketplaceReturnPath,
                })}
                linkComponent={RecipeTileLink}
              />
            ))}
          </div>

          {pageInfo.hasMore ? (
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={pressLoadMore}
                disabled={isLoadingMore || awaitingViewer || pressPending}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLoadingMore || pressPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                {isLoadingMore || pressPending ? 'Loading' : 'Load more recipes'}
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
  onActionClick,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  actionLabel: string;
  actionHref: string;
  onActionClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <div className="mt-10 rounded-3xl border border-white/8 bg-zinc-950/70 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.35)] backdrop-blur-sm">
      {icon}
      <h2 className="mt-4 text-2xl font-semibold text-white">{title}</h2>
      <p className="mt-3 mx-auto max-w-xl text-sm leading-7 text-zinc-400">{body}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href={actionHref}
          onClick={onActionClick}
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
  onNavigate,
}: {
  label: string;
  links: Array<{ label: string; href: string; active: boolean }>;
  /** Takes a plain click on a link and moves the listing in place. */
  onNavigate?: (href: string) => (event: MouseEvent<HTMLAnchorElement>) => void;
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
            prefetch={onNavigate ? false : undefined}
            onClick={onNavigate?.(link.href)}
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
