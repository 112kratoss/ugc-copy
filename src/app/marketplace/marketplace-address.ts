import {
  normalizeMarketplaceResourceFilter,
  normalizeMarketplaceResourceKindFilter,
  normalizeMarketplaceResourceSort,
  type MarketplaceResourceFilter,
  type MarketplaceResourceKindFilter,
  type MarketplaceResourceSort,
} from '@/lib/post-resource-bundles';
import {
  isValidMarketplaceSearchQuery,
  normalizeMarketplaceSearchQuery,
} from '@/lib/marketplace-search-policy';
import { slugifySourceTool } from '@/lib/source-tools';

/** What a marketplace address asks for: `/marketplace?access=…&resource=…&tool=…&sort=…&q=…`. */
export interface MarketplaceFilters {
  access: MarketplaceResourceFilter;
  resource: MarketplaceResourceKindFilter;
  tool: string;
  sort: MarketplaceResourceSort;
  q: string;
}

/** `/marketplace` as it is cached for everyone: every recipe, newest first. */
export const DEFAULT_MARKETPLACE_FILTERS: MarketplaceFilters = {
  access: 'all',
  resource: 'all',
  tool: '',
  sort: 'recent',
  q: '',
};

/**
 * The filters an address names, read the way the server read them while the
 * page was drawn per request. A query under the search minimum is not applied:
 * it comes back as `shortQuery`, kept in the box and answered with the hint,
 * rather than read as no query at all, which listed every recipe and emptied
 * the search box.
 */
export function readMarketplaceAddress(search: string): { filters: MarketplaceFilters; shortQuery: string } {
  const params = new URLSearchParams(search);
  const requestedQuery = normalizeMarketplaceSearchQuery(params.get('q'));
  const q = isValidMarketplaceSearchQuery(requestedQuery) ? requestedQuery : '';
  return {
    filters: {
      access: normalizeMarketplaceResourceFilter(params.get('access')),
      resource: normalizeMarketplaceResourceKindFilter(params.get('resource')),
      tool: slugifySourceTool(params.get('tool') ?? undefined) ?? '',
      sort: normalizeMarketplaceResourceSort(params.get('sort')),
      q,
    },
    shortQuery: requestedQuery && !q ? requestedQuery : '',
  };
}

/** One string per distinct listing, so a read can be matched to the address it was made for. */
export function marketplaceFiltersKey(filters: MarketplaceFilters): string {
  return [filters.access, filters.resource, filters.tool, filters.sort, filters.q].join('\u0000');
}

/** The list API's query for a listing (`GET /api/marketplace/resources`). */
export function buildMarketplaceListQuery(
  filters: MarketplaceFilters,
  page: { offset: number; limit: number },
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.access !== 'all') params.set('access', filters.access);
  if (filters.resource !== 'all') params.set('resource', filters.resource);
  if (filters.tool) params.set('tool', filters.tool);
  if (filters.q.trim()) params.set('q', filters.q.trim());
  params.set('sort', filters.sort);
  params.set('offset', String(page.offset));
  params.set('limit', String(page.limit));
  return params;
}

/**
 * A click the page may take over: the primary button with no modifier, on a
 * link nothing else has handled. Any other click (a new tab, a download)
 * follows the link's own address.
 */
export function isPlainLinkClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey
    && !event.defaultPrevented;
}
