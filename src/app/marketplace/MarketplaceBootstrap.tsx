'use client';

/* eslint-disable @next/next/no-html-link-for-pages -- Native links keep this demand shell independent of Next's interactive router chunk. */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from 'react';

import type MarketplaceBrowser from '@/app/marketplace/MarketplaceBrowser';
import {
  MARKETPLACE_RECIPE_GRID_CLASS,
  MarketplaceRecipeTile,
} from '@/app/marketplace/MarketplaceRecipeTile';
import MarketplaceToolFilter from '@/app/marketplace/MarketplaceToolFilter';
import { MARKETPLACE_INITIAL_PAGE_SIZE } from '@/lib/marketplace-resource-list-cache-policy';
import { MARKETPLACE_SEARCH_MIN_LENGTH } from '@/lib/marketplace-search-policy';
import { useViewerRecipeState } from '@/app/marketplace/useViewerRecipeState';

export type MarketplaceBootstrapProps = ComponentProps<typeof MarketplaceBrowser>;

type MarketplaceBrowserComponent = typeof MarketplaceBrowser;
type MarketplaceFilters = MarketplaceBootstrapProps['initialFilters'];

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

function loadMarketplaceBrowser() {
  marketplaceBrowserPromise ??= import('@/app/marketplace/MarketplaceBrowser')
    .then((module) => module.default)
    .catch((error) => {
      marketplaceBrowserPromise = null;
      throw error;
    });

  return marketplaceBrowserPromise;
}

export default function MarketplaceBootstrap(props: MarketplaceBootstrapProps) {
  const { initialPage, initialFilters, shortQuery = '', sourceToolOptions } = props;
  const [InteractiveBrowser, setInteractiveBrowser] = useState<MarketplaceBrowserComponent | null>(null);
  // The signed-in viewer's own recipes, read apart from the cached catalog.
  const viewer = useViewerRecipeState();
  const [isActivating, setIsActivating] = useState(false);
  const [activationError, setActivationError] = useState(false);
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
    setIsActivating(true);
    setActivationError(false);

    void loadMarketplaceBrowser()
      .then((Browser) => {
        setInteractiveBrowser(() => Browser);
      })
      .catch(() => {
        activationPendingRef.current = false;
        setIsActivating(false);
        setActivationError(true);
      });
  }, []);

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

  if (InteractiveBrowser) {
    return <InteractiveBrowser {...props} />;
  }

  const marketplaceReturnPath = buildMarketplacePath(initialFilters);
  const activeFilterLabels = getActiveFilterLabels(initialFilters, sourceToolOptions);
  const hasActiveFilters = activeFilterLabels.length > 0 || initialFilters.sort !== 'recent';
  const bootstrapItems = initialPage.items.slice(0, MARKETPLACE_INITIAL_PAGE_SIZE);

  return (
    <div data-marketplace-bootstrap-shell>
      <section
        aria-labelledby="marketplace-filter-heading"
        // `relative z-20`: backdrop-blur makes this a stacking context, so the
        // tool dropdown would paint under the card grid without it.
        className="relative z-20 mt-8 rounded-[28px] border border-white/8 bg-zinc-950/70 p-4 backdrop-blur-sm sm:p-5"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2
              id="marketplace-filter-heading"
              className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500"
            >
              Buyer filters
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              {activeFilterLabels.length > 0
                ? `Showing ${activeFilterLabels.join(' + ')}`
                : 'All quality-checked public recipes from community posts.'}
            </p>
          </div>

          <form
            action="/marketplace"
            method="get"
            role="search"
            className="flex min-w-0 rounded-full border border-white/10 bg-black/35 p-1"
            onSubmit={warmInteractiveBrowser}
          >
            <PreservedFilterInputs filters={initialFilters} />
            <label className="min-w-0 flex-1 px-3">
              <span className="sr-only">Search marketplace recipes</span>
              <input
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
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[auto_1fr_15rem]">
          <BootstrapFilterGroup
            label="Access"
            links={ACCESS_FILTERS.map((item) => ({
              label: item.label,
              href: buildMarketplacePath({ ...initialFilters, access: item.value }),
              active: initialFilters.access === item.value,
            }))}
            onIntent={warmInteractiveBrowser}
          />
          <BootstrapFilterGroup
            label="Kind"
            links={RESOURCE_FILTERS.map((item) => ({
              label: item.label,
              href: buildMarketplacePath({ ...initialFilters, resource: item.value }),
              active: initialFilters.resource === item.value,
            }))}
            onIntent={warmInteractiveBrowser}
          />
          {/* Shares the hydrated browser's control so the strip does not swap
              shape under the viewer when the real browser takes over. */}
          <MarketplaceToolFilter
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
              activeClassName="border-[rgba(255,122,89,0.3)] bg-[var(--ui-primary-soft)] font-semibold text-[var(--ui-text-primary)]"
            />
          ))}
          {hasActiveFilters ? (
            <a
              href="/marketplace"
              onFocus={warmInteractiveBrowser}
              onPointerDown={warmInteractiveBrowser}
              className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
            >
              Clear filters
            </a>
          ) : null}
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
        />
      ) : bootstrapItems.length === 0 && !initialPage.pageInfo.hasMore ? (
        // "No recipes yet" with a Share a post button answered a search or a
        // filter that matched nothing, as if the storefront were empty.
        activeFilterLabels.length > 0 ? (
          <BootstrapResultsMessage
            title="No recipes match"
            body="Try another search, or clear the filters to see every recipe."
            actionLabel="Clear filters"
            actionHref="/marketplace"
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
              <button
                type="button"
                onClick={activateInteractiveBrowser}
                disabled={isActivating}
                className="rounded-full border border-white/10 bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-wait disabled:opacity-60"
              >
                {isActivating ? 'Opening buyer tools…' : 'Load more recipes'}
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
}: {
  title: string;
  body: string;
  actionLabel: string;
  actionHref: string;
}) {
  return (
    <div className="mt-10 rounded-[30px] border border-white/8 bg-zinc-950/70 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.35)]">
      <h2 className="text-2xl font-semibold text-white">{title}</h2>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-zinc-400">{body}</p>
      <a
        href={actionHref}
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
}: {
  label: string;
  links: Array<{ label: string; href: string; active: boolean }>;
  onIntent: () => void;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {links.map((link) => (
          <BootstrapFilterLink key={link.label} {...link} onIntent={onIntent} />
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
  // Must stay in step with MarketplaceBrowser's active pill, or hydration
  // swaps one selected style for another in front of the viewer.
  activeClassName = 'border-[rgba(255,122,89,0.3)] bg-[var(--ui-primary-soft)] font-semibold text-[var(--ui-text-primary)]',
}: {
  label: string;
  href: string;
  active: boolean;
  onIntent: () => void;
  activeClassName?: string;
}) {
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      onFocus={onIntent}
      onPointerDown={onIntent}
      className={`shrink-0 rounded-full border px-3 py-1.5 text-sm transition ${
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

function buildMarketplaceDetailPath(postId: string, marketplaceReturnPath: string) {
  const params = new URLSearchParams({
    from: 'unlocks',
    returnTo: marketplaceReturnPath,
  });

  return `/showcase/${encodeURIComponent(postId)}?${params.toString()}#recipe`;
}
