import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EXPLORE_ACTIVE_FILTER_ROW_CLASS } from '@/app/showcase/explore-active-filters';

vi.mock('@/components/search/SearchEntryLink', () => ({
  SearchEntryLink: ({ className }: { className?: string }) => <a href="/search" className={className}>Search</a>,
}));

// The address the outline is drawn for.
const address = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(address.search),
}));

import ShowcaseLoading from '@/app/showcase/(feed)/loading';

function visibleTextOf(html: string) {
  return html
    .replace(/<span class="sr-only">[\s\S]*?<\/span>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('Explore loading state', () => {
  beforeEach(() => {
    address.search = '';
  });

  it('draws the page outline without words: no "Community" eyebrow or "Loading Explore" title (owner, 2026-11-14)', () => {
    const html = renderToString(<ShowcaseLoading />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading Explore"');
    // Read out from a hidden line inside the live region (its label alone is not announced)...
    expect(html).toContain('<span class="sr-only">Loading Explore</span>');
    // ...and on screen only the search entry has words: no "Community" eyebrow, no "Loading Explore" title.
    expect(visibleTextOf(html)).toBe('Search');
    expect(html).toContain('animate-[skeleton-shimmer_1.5s_linear_infinite]');
    // A lane with no filter past its kind and sort has no row of active filters.
    expect(html).not.toContain('data-explore-active-filters');
  });

  // The server's shell and the full page draw the row from the lane's filters; the outline, drawn
  // before the page has read anything, takes them from the address (web sweep, 2026-11-17).
  it("holds the place of the filter bar's row of active filters, a pill's height for each the address names", () => {
    address.search = 'sort=recent&tool=kling&unlock=paid';
    const html = renderToString(<ShowcaseLoading />);

    const row = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-explore-active-filters]');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('class')).toBe(EXPLORE_ACTIVE_FILTER_ROW_CLASS);
    expect(row!.getAttribute('aria-hidden')).toBe('true');
    // Under the bar's controls.
    expect(row!.parentElement?.hasAttribute('data-explore-filter-bar')).toBe(true);
    expect([...row!.children].map((pill) => pill.className.includes('h-[calc(2rem+2px)]'))).toEqual([true, true]);
    expect(visibleTextOf(html)).toBe('Search');
  });

  it.each(['category=video&sort=recent', 'tool=all', 'tool=', 'unlock=bogus&resource=bogus'])(
    'draws no row of active filters for ?%s',
    (search) => {
      address.search = search;
      expect(renderToString(<ShowcaseLoading />)).not.toContain('data-explore-active-filters');
    }
  );
});
