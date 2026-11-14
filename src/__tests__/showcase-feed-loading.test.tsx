import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/search/SearchEntryLink', () => ({
  SearchEntryLink: ({ className }: { className?: string }) => <a href="/search" className={className}>Search</a>,
}));

import ShowcaseLoading from '@/app/showcase/(feed)/loading';

describe('Explore loading state', () => {
  it('draws the page outline without words: no "Community" eyebrow or "Loading Explore" title (owner, 2026-11-14)', () => {
    const html = renderToString(<ShowcaseLoading />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading Explore"');
    // Only the search entry carries visible text: no "Community" eyebrow, no "Loading Explore" title.
    const visibleText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(visibleText).toBe('Search');
    expect(html).toContain('animate-[skeleton-shimmer_1.5s_linear_infinite]');
  });
});
