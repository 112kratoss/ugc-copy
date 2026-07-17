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
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

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

const RESOURCE_KIND_LABELS: Record<string, string> = {
  prompt: 'Prompt',
  workflow: 'Workflow',
  files: 'Files',
  notes: 'Notes',
  remix: 'Remix',
};

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
  const { initialPage, initialFilters, sourceToolOptions } = props;
  const [InteractiveBrowser, setInteractiveBrowser] = useState<MarketplaceBrowserComponent | null>(null);
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
  const bootstrapItems = initialPage.items.slice(0, 3);

  return (
    <div data-marketplace-bootstrap-shell>
      <section
        aria-labelledby="marketplace-filter-heading"
        className="mt-8 rounded-[28px] border border-white/8 bg-zinc-950/70 p-4 backdrop-blur-sm sm:p-5"
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
                defaultValue={initialFilters.q}
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

        <div className="mt-5 grid gap-4 lg:grid-cols-[0.75fr_1fr_1fr]">
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
          <BootstrapFilterGroup
            label="Tool"
            links={[
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
            onIntent={warmInteractiveBrowser}
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
              activeClassName="border-sky-300/30 bg-sky-400/15 text-sky-50"
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

      {bootstrapItems.length === 0 ? (
        <div className="mt-10 rounded-[30px] border border-white/8 bg-zinc-950/70 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.35)]">
          <h2 className="text-2xl font-semibold text-white">No recipes yet</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-zinc-400">
            Recipes need a useful public post, creator profile, buyer preview, and reusable resources before they appear here.
          </p>
          <a
            href="/post/new"
            className="mt-6 inline-flex rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
          >
            Share a post
          </a>
        </div>
      ) : (
        <>
          <div className="mt-10 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {bootstrapItems.map((asset) => (
              <BootstrapMarketplaceCard
                key={asset.id}
                asset={asset}
                marketplaceReturnPath={marketplaceReturnPath}
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
  activeClassName = 'border-emerald-300/30 bg-emerald-400/15 text-emerald-50',
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

function BootstrapMarketplaceCard({
  asset,
  marketplaceReturnPath,
}: {
  asset: MarketplaceResourceListItem;
  marketplaceReturnPath: string;
}) {
  const accessLabel = asset.accessMode === 'free' ? 'Free recipe' : `${asset.priceQuote.formatted} recipe`;
  const unlockLabel = asset.accessMode === 'free'
    ? 'Unlock free recipe'
    : `Unlock for ${asset.priceQuote.formatted}`;
  const previewText = asset.summary || asset.previewText || (
    asset.post?.postFormat === 'text'
      ? 'Reusable resources from this note are included.'
      : asset.post?.body || 'Reusable creator resources included.'
  );
  const detailHref = buildMarketplaceDetailPath(asset.postId, marketplaceReturnPath);

  return (
    <a
      href={detailHref}
      aria-label={`${unlockLabel}: ${asset.title}`}
      className="group overflow-hidden rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(18,18,22,0.98),rgba(10,10,14,0.98))] shadow-[0_24px_70px_rgba(0,0,0,0.35)] transition hover:border-white/14"
    >
      <BootstrapMediaPreview asset={asset} accessLabel={accessLabel} previewText={previewText} />

      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
              {asset.seller.username ? `@${asset.seller.username}` : asset.seller.name}
            </div>
            <h2 className="mt-2 text-xl font-semibold text-white">{asset.title}</h2>
          </div>
          <span className="shrink-0 rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1.5 text-sm font-semibold text-emerald-50">
            {asset.priceQuote.formatted}
          </span>
        </div>

        <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-300">{previewText}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          {asset.resourceKinds.map((kind) => (
            <span
              key={`${asset.id}-${kind}`}
              className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-200"
            >
              {RESOURCE_KIND_LABELS[kind] ?? kind}
            </span>
          ))}
        </div>

        <div className="mt-5 text-right text-xs font-semibold text-zinc-200">{unlockLabel}</div>
      </div>
    </a>
  );
}

function BootstrapMediaPreview({
  asset,
  accessLabel,
  previewText,
}: {
  asset: MarketplaceResourceListItem;
  accessLabel: string;
  previewText: string;
}) {
  const post = asset.post;

  if (post?.postFormat === 'text') {
    return (
      <div className="min-h-56 border-b border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_46%),rgba(9,9,12,0.98)] p-5">
        <div className="flex items-center justify-between gap-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400">
          <span>Tip / note</span>
          <span>{accessLabel}</span>
        </div>
        <div className="mt-8 text-lg font-semibold text-white">{post.title}</div>
        <p className="mt-3 line-clamp-4 text-sm leading-6 text-zinc-300">{post.body || previewText}</p>
      </div>
    );
  }

  if (post?.mediaUrl && post.mediaKind === 'image') {
    return (
      <div className="relative h-56 overflow-hidden border-b border-white/8 bg-black/60">
        {/* Native lazy media keeps the bootstrap independent of the full preview components. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={post.mediaPreviewUrl ?? post.mediaUrl}
          alt={post.title}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.02]"
        />
        <PreviewAccessBadge label={accessLabel} />
      </div>
    );
  }

  if (post?.mediaUrl && post.mediaKind === 'video') {
    return (
      <div className="relative h-56 overflow-hidden border-b border-white/8 bg-black/60">
        <video
          aria-label={post.title}
          poster={post.mediaPreviewUrl ?? undefined}
          preload="none"
          muted
          playsInline
          className="h-full w-full object-cover"
        />
        <PreviewAccessBadge label={accessLabel} />
      </div>
    );
  }

  return (
    <div className="relative flex h-44 items-center justify-center border-b border-white/8 bg-[radial-gradient(circle_at_top,rgba(52,211,153,0.2),transparent_48%),rgba(10,10,14,1)] text-sm font-medium text-zinc-400">
      Reusable creator recipe
      <PreviewAccessBadge label={accessLabel} />
    </div>
  );
}

function PreviewAccessBadge({ label }: { label: string }) {
  return (
    <span className="absolute left-4 top-4 rounded-full border border-black/20 bg-black/60 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white">
      {label}
    </span>
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
