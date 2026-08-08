type MarketplaceResourceListCachePolicyOptions = {
  offset: number;
  limit: number;
  tool?: string | null;
  query?: string | null;
  bypassCache?: boolean;
};

export const MARKETPLACE_INITIAL_PAGE_SIZE = 3;
// Keep web/mobile continuation pages compact while the server bootstrap stays
// smaller still. The broader default remains available to explicit API users.
export const MARKETPLACE_COMPACT_PAGE_SIZE = 12;
export const MARKETPLACE_DEFAULT_PAGE_SIZE = 24;

function isCacheableMarketplacePageLimit(limit: number) {
  return limit === MARKETPLACE_INITIAL_PAGE_SIZE
    || limit === MARKETPLACE_COMPACT_PAGE_SIZE
    || limit === MARKETPLACE_DEFAULT_PAGE_SIZE;
}

/**
 * F5b: a tool-filtered first page is cacheable, a searched one is not.
 *
 * The distinction is key-space, not correctness. Tool slugs come from the
 * source-tool catalog and arrive already normalised through
 * `slugifySourceTool`, so the number of distinct cache keys is bounded by that
 * catalog. A free-text query is unbounded and one visitor could mint an
 * arbitrary number of entries, so search stays uncached deliberately.
 *
 * Continuation pages stay uncached too: their key space grows with catalog
 * depth, and they are a small share of requests next to first-page loads.
 */
export function shouldCacheMarketplaceResourceListBasePage(
  options: MarketplaceResourceListCachePolicyOptions,
) {
  return (
    !options.bypassCache
    && options.offset === 0
    && isCacheableMarketplacePageLimit(options.limit)
    && !options.query
  );
}
