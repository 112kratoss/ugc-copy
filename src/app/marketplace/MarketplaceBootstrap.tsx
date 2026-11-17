'use client';

/* eslint-disable @next/next/no-html-link-for-pages -- Native links keep this demand shell independent of Next's interactive router chunk. */

import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react';
import { ArrowRight, Loader2, X } from 'lucide-react';

import type MarketplaceBrowser from '@/app/marketplace/MarketplaceBrowser';
import MarketplaceFiltersButton, {
  MARKETPLACE_FILTERS_ID,
  MarketplaceFiltersSummary,
} from '@/app/marketplace/MarketplaceFiltersButton';
import {
  MARKETPLACE_RECIPE_GRID_CLASS,
  MarketplaceRecipeTile,
} from '@/app/marketplace/MarketplaceRecipeTile';
import MarketplaceToolFilter from '@/app/marketplace/MarketplaceToolFilter';
import { useAuth } from '@/components/AuthProvider';
import {
  buildMarketplacePagesKey,
  marketplacePagesViewer,
  recallMarketplaceFiltersOpen,
  recallMarketplacePages,
  rememberMarketplaceFiltersOpen,
} from '@/lib/marketplace-pages-memory';
import { MARKETPLACE_INITIAL_PAGE_SIZE } from '@/lib/marketplace-resource-list-cache-policy';
import { MARKETPLACE_SEARCH_MIN_LENGTH } from '@/lib/marketplace-search-policy';
import type { SourceToolFilterOption } from '@/lib/source-tools';
import { useViewerRecipeState } from '@/app/marketplace/useViewerRecipeState';

import {
  countMarketplaceFiltersSet,
  isPlainLinkClick,
  marketplaceFiltersKey,
  type MarketplaceFilters,
} from './marketplace-address';
import { MarketplaceListingFailed, MarketplaceListingSkeleton } from './MarketplaceListingStates';
import {
  MarketplaceSearchParamsReporter,
  useMarketplaceListing,
  type MarketplaceListingPage,
} from './useMarketplaceListing';

export interface MarketplaceBootstrapProps {
  /**
   * The first page the server drew for `initialFilters`: the plain address, for
   * the cached page. `null` when the server could not read it (a build with no
   * database), and the browser reads it.
   */
  initialPage: MarketplaceListingPage | null;
  /** The address the server drew; the address bar's is read once the page is live. */
  initialFilters?: MarketplaceFilters;
  shortQuery?: string;
  sourceToolOptions: SourceToolFilterOption[];
}

type MarketplaceBrowserComponent = typeof MarketplaceBrowser;

const EMPTY_PAGE: MarketplaceListingPage = {
  items: [],
  pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: MARKETPLACE_INITIAL_PAGE_SIZE },
};

const ACCESS_FILTERS = [
  { label: 'All', value: 'all' },
  { label: 'Free', value: 'free' },
  { label: 'Paid', value: 'paid' },
] as const;

const RESOURCE_FILTERS = [
  { label: 'All kinds', value: 'all' },
  { label: 'Prompt', value: 'prompt' },
  { label: 'Workflow', value: 'workflow' },
  { label: 'Files', value: 'files' },
  { label: 'Notes', value: 'notes' },
  { label: 'Remix', value: 'remix' },
] as const;

const SORT_FILTERS = [
  { label: 'Recent', value: 'recent' },
  { label: 'Top sales', value: 'top-sales' },
  { label: 'Price low', value: 'price-low' },
  { label: 'Price high', value: 'price-high' },
] as const;

let marketplaceBrowserPromise: Promise<MarketplaceBrowserComponent> | null = null;
// The interactive browser once its module has come in this document. Only it loads more than a
// listing's first page, so a listing kept with later pages (marketplace-pages-memory) was kept by
// it, in this document, and it is here to draw them again from the first render.
let loadedMarketplaceBrowser: MarketplaceBrowserComponent | null = null;

function loadMarketplaceBrowser() {
  marketplaceBrowserPromise ??= import('@/app/marketplace/MarketplaceBrowser')
    .then((module) => {
      loadedMarketplaceBrowser = module.default;
      return module.default;
    })
    .catch((error) => {
      marketplaceBrowserPromise = null;
      throw error;
    });

  return marketplaceBrowserPromise;
}

export default function MarketplaceBootstrap(props: MarketplaceBootstrapProps) {
  const { sourceToolOptions } = props;
  // The listing the address names: the server's page for the plain address
  // until the browser has read it, then the list API's for whatever the
  // address and the viewer are (`useMarketplaceListing`).
  const listing = useMarketplaceListing({
    serverPage: props.initialPage,
    serverFilters: props.initialFilters,
    serverShortQuery: props.shortQuery,
  });
  const { filters: initialFilters, shortQuery, navigate } = listing;
  const initialPage = listing.page ?? EMPTY_PAGE;
  const [InteractiveBrowser, setInteractiveBrowser] = useState<MarketplaceBrowserComponent | null>(null);
  const { user, isLoading: isViewerLoading } = useAuth();
  // Back from a recipe to a listing whose Load more had brought more recipes: the interactive
  // browser draws them in the first frame, so the page is as long as when the reader left it and
  // the browser puts them back where they were (owner's report, 2026-11-15). This shell would
  // draw the first page alone. Decided once the address bar's listing is known, before the paint,
  // for the viewer the session cookie names while this page's auth provider asks who it is: a
  // signed-in reader read as nobody came back to the first page alone (owner's recording, 2026-11-16).
  if (
    InteractiveBrowser === null
    && loadedMarketplaceBrowser !== null
    && listing.addressKnown
    && recallMarketplacePages(buildMarketplacePagesKey(
      marketplaceFiltersKey(initialFilters),
      marketplacePagesViewer({ userId: user?.id ?? null, isLoading: isViewerLoading }),
    )) !== null
  ) {
    setInteractiveBrowser(() => loadedMarketplaceBrowser);
  }
  // The signed-in viewer's own recipes, read apart from the cached catalog.
  const viewer = useViewerRecipeState();
  const [activationError, setActivationError] = useState(false);
  // The listing whose "Load more recipes" was pressed here: the interactive list it brings in asks
  // for the next page itself, so one press opens the list and loads more (live sweep, 2026-11-17:
  // the press only opened the list, which drew the same four recipes, and a second press was needed).
  const [loadMorePressedFor, setLoadMorePressedFor] = useState<string | null>(null);
  // Phones and tablets keep the filters behind Filters; the interactive list takes them over as left.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Back to a listing whose filters the reader left open draws them open again, so the page above
  // the grid is as tall as when they left it and the browser puts them back on their recipe (review
  // of #837: folded, it landed them a panel's height off). Decided once the address bar's listing is
  // known, before the paint, as the hand-over above is; a listing moved to in place starts folded,
  // as the interactive list folds them for a filter picked.
  const filtersListingKey = marketplaceFiltersKey(initialFilters);
  const [filtersOpenReadFor, setFiltersOpenReadFor] = useState<string | null>(null);
  if (listing.addressKnown && filtersOpenReadFor !== filtersListingKey) {
    setFiltersOpenReadFor(filtersListingKey);
    setFiltersOpen(recallMarketplaceFiltersOpen(filtersListingKey));
  }
  useEffect(() => {
    // Kept only once read for this listing: the first render's would write over what Back reads.
    if (filtersOpenReadFor === filtersListingKey) rememberMarketplaceFiltersOpen(filtersListingKey, filtersOpen);
  }, [filtersOpen, filtersOpenReadFor, filtersListingKey]);
  const activationPendingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const warmInteractiveBrowser = useCallback(() => {
    // Search and filter links already work without JavaScript. Intent on those
    // controls only warms the interactive browser so navigation stays stable.
    void loadMarketplaceBrowser().catch(() => undefined);
  }, []);

  const activateInteractiveBrowser = useCallback(() => {
    if (activationPendingRef.current) {
      return;
    }

    activationPendingRef.current = true;
    setActivationError(false);

    void loadMarketplaceBrowser()
      .then((Browser) => {
        setInteractiveBrowser(() => Browser);
      })
      .catch(() => {
        activationPendingRef.current = false;
        setActivationError(true);
        // Said below the button, which is offered again.
        setLoadMorePressedFor(null);
      });
  }, []);

  // Also while the list is already on its way after a scroll towards the end: the press is kept for it.
  const pressLoadMore = () => {
    setLoadMorePressedFor(filtersListingKey);
    activateInteractiveBrowser();
  };
  const loadMorePressed = loadMorePressedFor !== null && loadMorePressedFor === filtersListingKey;

  useEffect(() => {
    if (
      !initialPage.pageInfo.hasMore
      || !sentinelRef.current
      || typeof window === 'undefined'
      || typeof IntersectionObserver === 'undefined'
    ) {
      return;
    }

    const sentinel = sentinelRef.current;
    let observer: IntersectionObserver | null = null;

    const observeAfterScrollIntent = () => {
      if (window.scrollY <= 0 || observer) {
        return;
      }

      window.removeEventListener('scroll', observeAfterScrollIntent);
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect();
          activateInteractiveBrowser();
        }
      }, {
        rootMargin: '160px 0px',
      });
      observer.observe(sentinel);
    };

    window.addEventListener('scroll', observeAfterScrollIntent, { passive: true });
    observeAfterScrollIntent();

    return () => {
      window.removeEventListener('scroll', observeAfterScrollIntent);
      observer?.disconnect();
    };
  }, [activateInteractiveBrowser, initialPage.pageInfo.hasMore]);

  // The address, read once the page is live; mounted whichever browser draws the list.
  const addressReporter = (
    <Suspense fallback={null}>
      <MarketplaceSearchParamsReporter onSearch={listing.reportSearch} />
    </Suspense>
  );

  if (InteractiveBrowser) {
    return (
      <>
        {addressReporter}
        <InteractiveBrowser
          initialPage={initialPage}
          initialFilters={initialFilters}
          shortQuery={shortQuery}
          sourceToolOptions={sourceToolOptions}
          listingStatus={listing.status}
          listingSettled={listing.settled}
          loadMoreOnOpen={loadMorePressedFor}
          initialFiltersOpen={filtersOpen}
          onNavigate={navigate}
          onRetry={listing.retry}
        />
      </>
    );
  }

  const marketplaceReturnPath = buildMarketplacePath(initialFilters);
  const activeFilterLabels = getActiveFilterLabels(initialFilters, sourceToolOptions);
  const hasActiveFilters = activeFilterLabels.length > 0 || initialFilters.sort !== 'recent';
  const bootstrapItems = initialPage.items.slice(0, MARKETPLACE_INITIAL_PAGE_SIZE);
  // A plain click on a filter or the search moves the listing in place; the
  // links and the form keep working as before without script.
  const navigateOnPlainClick = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLinkClick(event)) return;
    event.preventDefault();
    navigate(href);
  };
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    warmInteractiveBrowser();
    const query = new FormData(event.currentTarget).get('q');
    event.preventDefault();
    navigate(buildMarketplacePath({ ...initialFilters, q: typeof query === 'string' ? query : '' }));
  };

  return (
    <div data-marketplace-bootstrap-shell>
      {addressReporter}
      <section
        aria-labelledby="marketplace-filter-heading"
        // `relative z-20`: backdrop-blur makes this a stacking context, so the
        // tool dropdown would paint under the card grid without it.
        // Below 1024px the filters wait behind Filters, and below 640px the panel is compact, so a
        // phone's first screen reaches the first recipe (live sweep, 2026-11-17); drawn as
        // MarketplaceBrowser draws it there, so the hand-over moves no recipe.
        className="relative z-20 mt-4 rounded-3xl border border-white/8 bg-zinc-950/70 p-4 backdrop-blur-sm sm:mt-8 sm:p-5"
      >
        <div className="flex flex-col gap-3 sm:gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2
                id="marketplace-filter-heading"
                className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500"
              >
                Buyer filters
              </h2>
              <MarketplaceFiltersSummary
                filterLabels={activeFilterLabels}
                sortLabel={SORT_FILTERS.find((item) => item.value === initialFilters.sort && item.value !== 'recent')?.label ?? null}
              />
            </div>
            <MarketplaceFiltersButton
              open={filtersOpen}
              onToggle={() => setFiltersOpen((value) => !value)}
              controls={MARKETPLACE_FILTERS_ID}
              setCount={countMarketplaceFiltersSet(initialFilters)}
            />
          </div>

          {/* From 1024px the form stands beside the heading alone, as it always has. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center lg:contents">
            <form
              action="/marketplace"
              method="get"
              role="search"
              className="flex min-w-0 rounded-full border border-white/10 bg-black/35 p-1"
              onSubmit={submitSearch}
            >
              <PreservedFilterInputs filters={initialFilters} />
              <label className="min-w-0 flex-1 px-3">
                <span className="sr-only">Search marketplace recipes</span>
                <input
                  // A new address's query, once it is read, stands in the box.
                  key={initialFilters.q || shortQuery}
                  type="search"
                  name="q"
                  defaultValue={initialFilters.q || shortQuery}
                  onFocus={warmInteractiveBrowser}
                  onInput={warmInteractiveBrowser}
                  placeholder="Search prompts, tools, creators"
                  className="w-full min-w-0 bg-transparent py-2 text-sm text-white outline-none placeholder:text-zinc-600"
                />
              </label>
              <button
                type="submit"
                onPointerDown={warmInteractiveBrowser}
                className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-zinc-200"
              >
                Search
              </button>
            </form>
            {/* Out of the folded filters, as MarketplaceBrowser's Clear stands; from 1024px the
                filters' own "Clear filters" is in view. */}
            {hasActiveFilters ? (
              <a
                href="/marketplace"
                onClick={navigateOnPlainClick('/marketplace')}
                onFocus={warmInteractiveBrowser}
                onPointerDown={warmInteractiveBrowser}
                className="inline-flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08] lg:hidden"
              >
                <X className="h-4 w-4" />
                Clear
              </a>
            ) : null}
          </div>
        </div>

        <div id={MARKETPLACE_FILTERS_ID} className={`${filtersOpen ? 'block' : 'hidden'} lg:block`}>
          <div className="mt-5 grid gap-4 lg:grid-cols-[auto_1fr_15rem]">
            <BootstrapFilterGroup
              label="Access"
              links={ACCESS_FILTERS.map((item) => ({
                label: item.label,
                href: buildMarketplacePath({ ...initialFilters, access: item.value }),
                active: initialFilters.access === item.value,
              }))}
              onIntent={warmInteractiveBrowser}
              onNavigate={navigateOnPlainClick}
            />
            <BootstrapFilterGroup
              label="Kind"
              links={RESOURCE_FILTERS.map((item) => ({
                label: item.label,
                href: buildMarketplacePath({ ...initialFilters, resource: item.value }),
                active: initialFilters.resource === item.value,
              }))}
              onIntent={warmInteractiveBrowser}
              onNavigate={navigateOnPlainClick}
            />
            {/* Shares the hydrated browser's control so the strip does not swap
                shape under the viewer when the real browser takes over. */}
            <MarketplaceToolFilter
              onNavigate={navigate}
              options={[
                {
                  label: 'All tools',
                  href: buildMarketplacePath({ ...initialFilters, tool: '' }),
                  active: !initialFilters.tool,
                },
                ...sourceToolOptions.map((tool) => ({
                  label: tool.label,
                  href: buildMarketplacePath({ ...initialFilters, tool: tool.slug }),
                  active: initialFilters.tool === tool.slug,
                })),
              ]}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2" aria-label="Sort recipes">
            {SORT_FILTERS.map((item) => (
              <BootstrapFilterLink
                key={item.value}
                label={item.label}
                href={buildMarketplacePath({ ...initialFilters, sort: item.value })}
                active={initialFilters.sort === item.value}
                onIntent={warmInteractiveBrowser}
                onNavigate={navigateOnPlainClick}
                // MarketplaceBrowser's order chips' size below 1024px, where they open from Filters,
                // so an open panel keeps its height when that list takes over; above, as it was.
                sizeClassName="px-4 py-2 lg:px-3 lg:py-1.5"
                activeClassName="border-[rgba(255,122,89,0.3)] bg-[var(--ui-primary-soft)] font-semibold text-[var(--ui-text-primary)]"
              />
            ))}
            {hasActiveFilters ? (
              <a
                href="/marketplace"
                onClick={navigateOnPlainClick('/marketplace')}
                onFocus={warmInteractiveBrowser}
                onPointerDown={warmInteractiveBrowser}
                className="hidden rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-300 transition hover:bg-white/[0.06] hover:text-white lg:block"
              >
                Clear filters
              </a>
            ) : null}
          </div>
        </div>
      </section>

      {/* Each state is worded as MarketplaceBrowser words it, so nothing changes
          under the viewer when it takes over. */}
      {shortQuery ? (
        <BootstrapResultsMessage
          title={`Type at least ${MARKETPLACE_SEARCH_MIN_LENGTH} characters`}
          body="Keep typing, or clear the search to see every recipe."
          actionLabel="Clear search"
          actionHref={marketplaceReturnPath}
          onNavigate={navigateOnPlainClick}
        />
      ) : listing.status === 'loading' ? (
        <MarketplaceListingSkeleton />
      ) : listing.status === 'failed' ? (
        <MarketplaceListingFailed onRetry={listing.retry} />
      ) : bootstrapItems.length === 0 && !initialPage.pageInfo.hasMore ? (
        // "No recipes yet" with a Share a post button answered a search or a
        // filter that matched nothing, as if the storefront were empty.
        activeFilterLabels.length > 0 ? (
          <BootstrapResultsMessage
            title="No recipes match"
            body="Try another search, or clear the filters to see every recipe."
            actionLabel="Clear filters"
            actionHref="/marketplace"
            onNavigate={navigateOnPlainClick}
          />
        ) : (
          <BootstrapResultsMessage
            title="No recipes yet"
            body="Recipes need a useful public post, a creator profile, a buyer-facing preview, and reusable resources before they appear here."
            actionLabel="Share a post"
            actionHref="/post/new?from=marketplace&returnTo=%2Fmarketplace"
          />
        )
      ) : (
        <>
          <div className={MARKETPLACE_RECIPE_GRID_CLASS}>
            {bootstrapItems.map((asset) => (
              <MarketplaceRecipeTile
                key={asset.id}
                asset={asset}
                viewer={viewer}
                href={buildMarketplaceDetailPath(asset.postId, marketplaceReturnPath)}
              />
            ))}
          </div>

          {initialPage.pageInfo.hasMore ? (
            <div
              ref={sentinelRef}
              data-marketplace-bootstrap-sentinel
              className="mt-8 flex flex-col items-center gap-3"
            >
              {/* The press opens the interactive list and asks it for the next page, so it reads as
                  that list's own button does, from the press until the recipes come. */}
              <button
                type="button"
                onClick={pressLoadMore}
                disabled={loadMorePressed}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loadMorePressed ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                {loadMorePressed ? 'Loading' : 'Load more recipes'}
              </button>
              {activationError ? (
                <p role="status" className="text-sm text-rose-200">
                  Buyer tools could not open. Try again.
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function BootstrapResultsMessage({
  title,
  body,
  actionLabel,
  actionHref,
  onNavigate,
}: {
  title: string;
  body: string;
  actionLabel: string;
  actionHref: string;
  /** For an address on this page: moves the listing in place. */
  onNavigate?: (href: string) => (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <div className="mt-10 rounded-3xl border border-white/8 bg-zinc-950/70 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.35)]">
      <h2 className="text-2xl font-semibold text-white">{title}</h2>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-zinc-400">{body}</p>
      <a
        href={actionHref}
        onClick={onNavigate?.(actionHref)}
        className="mt-6 inline-flex rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
      >
        {actionLabel}
      </a>
    </div>
  );
}

function PreservedFilterInputs({ filters }: { filters: MarketplaceFilters }) {
  return (
    <>
      {filters.access !== 'all' ? <input type="hidden" name="access" value={filters.access} /> : null}
      {filters.resource !== 'all' ? <input type="hidden" name="resource" value={filters.resource} /> : null}
      {filters.tool ? <input type="hidden" name="tool" value={filters.tool} /> : null}
      {filters.sort !== 'recent' ? <input type="hidden" name="sort" value={filters.sort} /> : null}
    </>
  );
}

function BootstrapFilterGroup({
  label,
  links,
  onIntent,
  onNavigate,
}: {
  label: string;
  links: Array<{ label: string; href: string; active: boolean }>;
  onIntent: () => void;
  onNavigate?: (href: string) => (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {links.map((link) => (
          <BootstrapFilterLink key={link.label} {...link} onIntent={onIntent} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}

function BootstrapFilterLink({
  label,
  href,
  active,
  onIntent,
  onNavigate,
  // Must stay in step with MarketplaceBrowser's active pill, or hydration
  // swaps one selected style for another in front of the viewer.
  activeClassName = 'border-[rgba(255,122,89,0.3)] bg-[var(--ui-primary-soft)] font-semibold text-[var(--ui-text-primary)]',
  sizeClassName = 'px-3 py-1.5',
}: {
  label: string;
  href: string;
  active: boolean;
  onIntent: () => void;
  onNavigate?: (href: string) => (event: MouseEvent<HTMLAnchorElement>) => void;
  activeClassName?: string;
  sizeClassName?: string;
}) {
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate?.(href)}
      onFocus={onIntent}
      onPointerDown={onIntent}
      className={`shrink-0 rounded-full border ${sizeClassName} text-sm transition ${
        active
          ? activeClassName
          : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
      }`}
    >
      {label}
    </a>
  );
}

function getActiveFilterLabels(
  filters: MarketplaceFilters,
  sourceToolOptions: MarketplaceBootstrapProps['sourceToolOptions'],
) {
  const labels: string[] = [];

  if (filters.access !== 'all') {
    labels.push(filters.access === 'free' ? 'Free' : 'Paid');
  }
  if (filters.resource !== 'all') {
    labels.push(RESOURCE_FILTERS.find((item) => item.value === filters.resource)?.label ?? filters.resource);
  }
  if (filters.tool) {
    labels.push(sourceToolOptions.find((tool) => tool.slug === filters.tool)?.label ?? filters.tool);
  }
  if (filters.q) {
    labels.push(`Search: ${filters.q}`);
  }

  return labels;
}

function buildMarketplacePath(filters: MarketplaceFilters): string {
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
  params.set('sort', filters.sort);

  return `/marketplace?${params.toString()}`;
}

/** The post at its top, as the interactive list's tiles open it (no `#recipe`: owner, 2026-11-16). */
function buildMarketplaceDetailPath(postId: string, marketplaceReturnPath: string) {
  const params = new URLSearchParams({
    from: 'unlocks',
    returnTo: marketplaceReturnPath,
  });

  return `/showcase/${encodeURIComponent(postId)}?${params.toString()}`;
}
