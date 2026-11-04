import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MARKETPLACE_FILTERS,
  buildMarketplaceListQuery,
  isPlainLinkClick,
  marketplaceFiltersKey,
  readMarketplaceAddress,
} from '@/app/marketplace/marketplace-address';

// The cached storefront reads its address in the browser, as the server read
// it while the page was drawn per request.
describe('readMarketplaceAddress', () => {
  it('reads the plain address as the storefront the page caches', () => {
    expect(readMarketplaceAddress('')).toEqual({ filters: DEFAULT_MARKETPLACE_FILTERS, shortQuery: '' });
  });

  it('reads each filter, and drops a value it does not know', () => {
    expect(readMarketplaceAddress('?access=paid&resource=workflow&tool=Runway%20ML&sort=top-sales&q=%20neon%20ads%20').filters).toEqual({
      access: 'paid',
      resource: 'workflow',
      tool: 'runway-ml',
      sort: 'top-sales',
      q: 'neon ads',
    });
    expect(readMarketplaceAddress('?access=everything&resource=movies&sort=oldest').filters).toEqual(DEFAULT_MARKETPLACE_FILTERS);
  });

  it('keeps a query under three characters apart, unapplied, for the hint', () => {
    expect(readMarketplaceAddress('?q=ai&access=free')).toEqual({
      filters: { ...DEFAULT_MARKETPLACE_FILTERS, access: 'free' },
      shortQuery: 'ai',
    });
  });

  it('names each listing once, whatever order its address was written in', () => {
    expect(marketplaceFiltersKey(readMarketplaceAddress('?sort=price-low&access=paid').filters))
      .toBe(marketplaceFiltersKey(readMarketplaceAddress('?access=paid&sort=price-low').filters));
    expect(marketplaceFiltersKey(readMarketplaceAddress('?access=paid').filters))
      .not.toBe(marketplaceFiltersKey(DEFAULT_MARKETPLACE_FILTERS));
  });
});

describe('buildMarketplaceListQuery', () => {
  it('asks the list API in the order "Load more" asks it, so the edge keeps one copy', () => {
    expect(buildMarketplaceListQuery(DEFAULT_MARKETPLACE_FILTERS, { offset: 0, limit: 4 }).toString())
      .toBe('sort=recent&offset=0&limit=4');
    expect(buildMarketplaceListQuery(
      { access: 'free', resource: 'prompt', tool: 'runway', sort: 'top-sales', q: 'neon' },
      { offset: 0, limit: 4 },
    ).toString()).toBe('access=free&resource=prompt&tool=runway&q=neon&sort=top-sales&offset=0&limit=4');
  });
});

describe('isPlainLinkClick', () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };

  it('takes only an unmodified primary click nothing else has handled', () => {
    expect(isPlainLinkClick(click)).toBe(true);
    expect(isPlainLinkClick({ ...click, button: 1 })).toBe(false);
    expect(isPlainLinkClick({ ...click, metaKey: true })).toBe(false);
    expect(isPlainLinkClick({ ...click, ctrlKey: true })).toBe(false);
    expect(isPlainLinkClick({ ...click, shiftKey: true })).toBe(false);
    expect(isPlainLinkClick({ ...click, altKey: true })).toBe(false);
    expect(isPlainLinkClick({ ...click, defaultPrevented: true })).toBe(false);
  });
});
