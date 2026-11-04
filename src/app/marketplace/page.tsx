import type { Metadata } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import Link from 'next/link';
import { ShoppingBag } from 'lucide-react';

import MarketplaceBootstrap from '@/app/marketplace/MarketplaceBootstrap';
import { DEFAULT_MARKETPLACE_FILTERS } from '@/app/marketplace/marketplace-address';
import { OptionalAuth } from '@/components/RouteAuthBoundary';
import { logBackendWarning } from '@/lib/backend-logger';
import { MARKETPLACE_RESOURCE_LIST_CACHE_TAG } from '@/lib/marketplace-resource-list-cache';
import { MARKETPLACE_INITIAL_PAGE_SIZE } from '@/lib/marketplace-resource-list-cache-policy';
import { getMarketplaceResourceList } from '@/lib/post-resource-bundles-server';
import { cachePublicPageRead } from '@/lib/public-page-cache';
import { createMetadata } from '@/lib/seo';
import { FALLBACK_SOURCE_TOOLS, toSourceToolFilterOptions } from '@/lib/source-tools';
import { listSourceToolsCatalog } from '@/lib/source-tools-server';

/**
 * Every address of the page is one document, `/marketplace` (the filters and
 * the search are read in the browser), so each names it as its canonical: a
 * crawler that follows `?access=paid&sort=top-sales` is told that is the plain
 * storefront.
 */
export const metadata: Metadata = createMetadata({
  title: 'Recipe Marketplace',
  description:
    'Browse free and paid recipes attached to public posts. Check the post first, then unlock its prompt, workflow, files, notes, or remix access.',
  path: '/marketplace',
  keywords: [
    'AI prompt marketplace',
    'AI workflow recipes',
    'AI video prompts',
    'AI image prompts',
  ],
});

/**
 * One render for everyone, kept until a sale, a free unlock, a recipe or post
 * change or a moderation decision invalidates it (ISR): every recipe, newest
 * first, as a signed-out visitor in no country sees it. The page reads no
 * session, header or query. The address's filters and search, a visitor's
 * currency and a signed-in viewer's blocks are read in the browser
 * (`useMarketplaceListing`, through the list API "Load more" already reads),
 * and what the viewer already has (`useViewerRecipeState`) was already.
 *
 * Kept equal to PUBLIC_PAGE_REVALIDATE_SECONDS (five minutes: that file says
 * why). It was 60 and moot, since reading the query and the headers made
 * every request render the page.
 */
export const revalidate = 300;

/**
 * The plain storefront's first page and the tool filters' options, cached
 * with the page under the marketplace's tag (sales, free unlocks, recipe
 * changes) and the public pages' (`PUBLIC_PAGE_CACHE_TAG`: a publish, an edit,
 * a take-down from the console, which invalidates that one with the feed's;
 * `getCachedMarketplaceResourceListBase` says why the listing needs it). A
 * block or a report leaves it: blocks are read in the browser. The listing's
 * own minute-long cache sits inside this read and is passed over there, so
 * the page keeps its own backstop rather than the minute.
 */
async function readMarketplacePage() {
  const [firstPage, sourceToolOptions] = await Promise.all([
    // No country: a visitor's currency comes with the browser's read of the same page.
    getMarketplaceResourceList({
      filter: DEFAULT_MARKETPLACE_FILTERS.access,
      resource: DEFAULT_MARKETPLACE_FILTERS.resource,
      tool: null,
      q: null,
      sort: DEFAULT_MARKETPLACE_FILTERS.sort,
      limit: MARKETPLACE_INITIAL_PAGE_SIZE,
      offset: 0,
    }),
    listSourceToolsCatalog(),
  ]);

  return {
    initialPage: {
      items: firstPage?.items ?? [],
      pageInfo: firstPage?.pageInfo ?? {
        hasMore: false,
        nextOffset: null,
        offset: 0,
        limit: MARKETPLACE_INITIAL_PAGE_SIZE,
      },
    },
    // Written into the flight data of every first load: only what the filter draws.
    sourceToolOptions: toSourceToolFilterOptions(sourceToolOptions),
  };
}

const readCachedMarketplacePage = cachePublicPageRead(
  readMarketplacePage,
  ['marketplace-page-v1'],
  [MARKETPLACE_RESOURCE_LIST_CACHE_TAG],
);

/**
 * The page is prerendered by `next build`, and CI builds against a placeholder
 * Supabase host, where the read fails and would fail the build. Only there is
 * that tolerated: the page goes out with no first page (`null`), which the
 * browser reads for itself, never a cached "No recipes yet". Production builds
 * reach the database. At request time the failure is rethrown, so ISR keeps
 * serving the last good page (as `listPublicModelsForPrerender` does).
 */
async function loadMarketplacePage() {
  try {
    return await readCachedMarketplacePage();
  } catch (error) {
    if (process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD) {
      throw error;
    }
    logBackendWarning('marketplace_prerendered_without_listing', { error });
    return {
      initialPage: null,
      sourceToolOptions: toSourceToolFilterOptions(FALLBACK_SOURCE_TOOLS),
    };
  }
}

export default async function MarketplacePage() {
  const { initialPage, sourceToolOptions } = await loadMarketplacePage();

  return (
    <OptionalAuth>
      <div className="min-h-screen bg-black text-white">
        {/* The emerald and sky bokeh blobs that used to sit here are gone:
            docs/design/design-web.md rules out purely atmospheric backgrounds, and they were
            spending two of the system's content-type accents on decoration. */}
        <div className="studio-shell relative z-10 py-8 sm:py-10">
          <div className="rounded-3xl border border-white/8 bg-[linear-gradient(135deg,rgba(5,8,12,0.98),rgba(16,18,25,0.92))] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.5)] sm:p-8">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <div className="inline-flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-amber-100">
                  <ShoppingBag className="h-3.5 w-3.5" />
                  Recipes
                </div>
                {/* A step down from 4xl/5xl. This is a storefront: the headline
                    should introduce the page, not compete with the goods for the
                    first screen. */}
                <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Buy the reusable parts behind community posts
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-300 sm:text-base">
                  Browse free and paid recipes attached to public posts. Check the post first, then unlock its prompt, workflow, files, notes, or remix access.
                </p>
              </div>

              {/* A post starts from the top bar's Create menu. */}
              <div className="flex flex-wrap gap-3">
                <Link
                  href="/marketplace/sell"
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
                >
                  Recipe sales
                </Link>
              </div>
            </div>
          </div>

          {/* Awaited, not streamed behind a fallback: the page is cached whole,
              and a fallback would ship beside the grid it stands for. */}
          <MarketplaceBootstrap
            initialPage={initialPage}
            initialFilters={DEFAULT_MARKETPLACE_FILTERS}
            sourceToolOptions={sourceToolOptions}
          />
        </div>
      </div>
    </OptionalAuth>
  );
}
