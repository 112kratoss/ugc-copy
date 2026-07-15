type MarketplaceResourceListCachePolicyOptions = {
  offset: number;
  limit: number;
  tool?: string | null;
  query?: string | null;
  bypassCache?: boolean;
};

export const MARKETPLACE_INITIAL_PAGE_SIZE = 12;
export const MARKETPLACE_DEFAULT_PAGE_SIZE = 24;

function isCacheableMarketplacePageLimit(limit: number) {
  return limit === MARKETPLACE_INITIAL_PAGE_SIZE || limit === MARKETPLACE_DEFAULT_PAGE_SIZE;
}

export function shouldCacheMarketplaceResourceListBasePage(
  options: MarketplaceResourceListCachePolicyOptions,
) {
  return (
    !options.bypassCache
    && options.offset === 0
    && isCacheableMarketplacePageLimit(options.limit)
    && !options.tool
    && !options.query
  );
}
