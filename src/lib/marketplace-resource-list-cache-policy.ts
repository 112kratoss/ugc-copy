type MarketplaceResourceListCachePolicyOptions = {
  offset: number;
  limit: number;
  tool?: string | null;
  query?: string | null;
  bypassCache?: boolean;
};

const CACHEABLE_MARKETPLACE_PAGE_LIMIT = 24;

export function shouldCacheMarketplaceResourceListBasePage(
  options: MarketplaceResourceListCachePolicyOptions,
) {
  return (
    !options.bypassCache
    && options.offset === 0
    && options.limit === CACHEABLE_MARKETPLACE_PAGE_LIMIT
    && !options.tool
    && !options.query
  );
}
