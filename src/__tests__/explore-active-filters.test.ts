import { describe, expect, it } from 'vitest';

import {
  exploreActiveFilters,
  exploreLaneFiltersFromSearchParams,
} from '@/app/showcase/explore-active-filters';

// Explore's filter bar names a lane's filters past its kind and sort in a row under its controls.
// The full page, the server's shell and the loading outline each draw that row from this, so it
// stands in one place in all three (tests/e2e/explore-filter-row-steady.spec.ts).
describe('an Explore lane\'s active filters', () => {
  it('names the tool, then the recipe filter, then the kind', () => {
    expect(exploreActiveFilters(
      { tool: 'kling', unlock: 'paid', resource: 'workflow' },
      [{ slug: 'veo', label: 'Veo' }, { slug: 'kling', label: 'Kling' }],
    )).toEqual([
      { key: 'tool', label: 'Kling' },
      { key: 'unlock', label: 'Paid' },
      { key: 'resource', label: 'Workflows' },
    ]);
    expect(exploreActiveFilters({ tool: null, unlock: 'with-unlock', resource: 'remix' }, [])).toEqual([
      { key: 'unlock', label: 'Recipes' },
      { key: 'resource', label: 'Remixable' },
    ]);
  });

  it('names a tool the catalog does not list by its slug', () => {
    expect(exploreActiveFilters({ tool: 'e2e-explore-reel', unlock: 'all', resource: 'all' }, []))
      .toEqual([{ key: 'tool', label: 'e2e-explore-reel' }]);
  });

  // An empty `tool=` filters the feed by nothing (showcase-feed.ts), and `all` is the bar's own "All tools".
  it.each([null, '', 'all'])('takes the tool %j for no filter', (tool) => {
    expect(exploreActiveFilters({ tool, unlock: 'all', resource: 'all' }, [{ slug: 'all', label: 'All' }])).toEqual([]);
  });

  it('reads an address as the page does: the first value of each, and an unknown recipe filter or kind as none', () => {
    expect(exploreLaneFiltersFromSearchParams(
      new URLSearchParams('category=image&sort=recent&tool=kling&tool=veo&unlock=free&resource=bogus'),
    )).toEqual({ tool: 'kling', unlock: 'free', resource: 'all' });
    expect(exploreLaneFiltersFromSearchParams(new URLSearchParams('category=video'))).toEqual({
      tool: null,
      unlock: 'all',
      resource: 'all',
    });
    // Outside the app's router (a test render), `useSearchParams` gives null.
    expect(exploreLaneFiltersFromSearchParams(null)).toEqual({ tool: null, unlock: 'all', resource: 'all' });
  });
});
