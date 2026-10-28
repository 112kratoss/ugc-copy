import { headers } from 'next/headers';
import Link from 'next/link';
import { ShoppingBag } from 'lucide-react';
import { Suspense, use } from 'react';

import MarketplaceBootstrap from '@/app/marketplace/MarketplaceBootstrap';
import { MARKETPLACE_RECIPE_GRID_CLASS } from '@/app/marketplace/MarketplaceRecipeTile';
import { filterMarketplaceItemsForViewer } from '@/lib/marketplace-viewer-filter';
import {
  getMarketplaceResourceList,
} from '@/lib/post-resource-bundles-server';
import {
  normalizeMarketplaceResourceFilter,
  normalizeMarketplaceResourceKindFilter,
  normalizeMarketplaceResourceSort,
} from '@/lib/post-resource-bundles';
import { slugifySourceTool, toSourceToolFilterOptions } from '@/lib/source-tools';
import { listSourceToolsCatalog } from '@/lib/source-tools-server';
import { MARKETPLACE_INITIAL_PAGE_SIZE } from '@/lib/marketplace-resource-list-cache-policy';
import {
  isValidMarketplaceSearchQuery,
  normalizeMarketplaceSearchQuery,
} from '@/lib/marketplace-search-policy';
import { getServerAuthState } from '@/lib/supabase-server';

interface MarketplacePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function getParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export const revalidate = 60;

async function loadMarketplacePageData(searchParams: MarketplacePageProps['searchParams']) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const filter = normalizeMarketplaceResourceFilter(
    getParam(resolvedSearchParams.access)
  );
  const resource = normalizeMarketplaceResourceKindFilter(getParam(resolvedSearchParams.resource));
  const sort = normalizeMarketplaceResourceSort(
    getParam(resolvedSearchParams.sort)
  );
  const tool = slugifySourceTool(getParam(resolvedSearchParams.tool)) ?? '';
  const requestedQuery = normalizeMarketplaceSearchQuery(getParam(resolvedSearchParams.q));
  const q = isValidMarketplaceSearchQuery(requestedQuery) ? requestedQuery : '';
  // A query under the minimum is answered with the hint rather than read as no
  // query at all, which listed every recipe and emptied the search box.
  const shortQuery = requestedQuery && !q ? requestedQuery : '';
  const headerStore = await headers();
  const [assetPage, auth, sourceToolOptions] = await Promise.all([
    shortQuery ? null : getMarketplaceResourceList({
      filter,
      resource,
      tool,
      q,
      sort,
      limit: MARKETPLACE_INITIAL_PAGE_SIZE,
      offset: 0,
      // Quoted for the visitor's country like every later page and the post a
      // card opens: a buyer in India read dollars on these cards, rupees after.
      countryCode: headerStore.get('x-vercel-ip-country'),
    }),
    getServerAuthState(),
    listSourceToolsCatalog(),
  ]);
  const initialPage = {
    // The page is read once for everyone, so a signed-in viewer's blocks (either
    // way) are taken out here, as the list API does for every later page.
    items: await filterMarketplaceItemsForViewer(assetPage?.items ?? [], auth.session?.user?.id ?? null),
    pageInfo: assetPage?.pageInfo ?? {
      hasMore: false,
      nextOffset: null,
      offset: 0,
      limit: MARKETPLACE_INITIAL_PAGE_SIZE,
    },
  };

  return {
    initialPage,
    initialFilters: {
      access: filter,
      resource,
      tool,
      sort,
      q,
    },
    shortQuery,
    // Written into the flight data of every first load: only what the filter draws.
    sourceToolOptions: toSourceToolFilterOptions(sourceToolOptions),
  };
}

function MarketplaceResultsFallback() {
  return (
    <div aria-label="Loading marketplace recipes">
      <div className="relative mt-8 min-h-44 overflow-hidden rounded-[28px] border border-white/8 bg-zinc-950/70 p-5">
        <div className="h-3 w-28 rounded-full bg-white/8" />
        <div className="mt-4 h-12 rounded-full bg-white/[0.04]" />
        <div className="mt-4 flex gap-2">
          {[1, 2, 3, 4].map((item) => (
            <div key={item} className="h-9 w-20 rounded-full bg-white/[0.04]" />
          ))}
        </div>
        <div className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
      </div>
      {/* The tiles' own shape (`MarketplaceRecipeTile`), so nothing moves when they arrive. */}
      <div className={MARKETPLACE_RECIPE_GRID_CLASS}>
        {Array.from({ length: MARKETPLACE_INITIAL_PAGE_SIZE }, (_, item) => (
          <div key={item} className="min-w-0">
            <div className="relative aspect-[4/5] overflow-hidden rounded-[1.5rem] border border-white/8 bg-zinc-950/70">
              <div className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
            </div>
            <div className="mt-3 h-3.5 w-2/3 rounded-full bg-white/8" />
            <div className="mt-2.5 h-8 w-1/2 rounded-full bg-white/[0.04]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function MarketplaceResults({
  data,
}: {
  data: ReturnType<typeof loadMarketplacePageData>;
}) {
  const { initialPage, initialFilters, shortQuery, sourceToolOptions } = use(data);

  return (
    <MarketplaceBootstrap
      initialPage={initialPage}
      initialFilters={initialFilters}
      shortQuery={shortQuery}
      sourceToolOptions={sourceToolOptions}
    />
  );
}

export default function MarketplacePage({ searchParams }: MarketplacePageProps) {
  const marketplacePageData = loadMarketplacePageData(searchParams);

  return (
    <div className="min-h-screen bg-black text-white">
      {/* The emerald and sky bokeh blobs that used to sit here are gone:
          docs/design/design-web.md rules out purely atmospheric backgrounds, and they were
          spending two of the system's content-type accents on decoration. */}
      <div className="studio-shell relative z-10 py-8 sm:py-10">
        <div className="rounded-[34px] border border-white/8 bg-[linear-gradient(135deg,rgba(5,8,12,0.98),rgba(16,18,25,0.92))] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.5)] sm:p-8">
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
                Seller Dashboard
              </Link>
            </div>
          </div>
        </div>

        <Suspense fallback={<MarketplaceResultsFallback />}>
          <MarketplaceResults data={marketplacePageData} />
        </Suspense>
      </div>
    </div>
  );
}
