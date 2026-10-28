import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MarketplaceBootstrap from '@/app/marketplace/MarketplaceBootstrap';
import { SHOWCASE_FEED_GRID_CLASS } from '@/app/showcase/showcase-layout';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

const browserModuleLoaded = vi.hoisted(() => vi.fn());

vi.mock('@/app/marketplace/MarketplaceBrowser', () => {
  browserModuleLoaded();

  return {
    default: () => <div data-testid="interactive-marketplace-browser">Interactive marketplace browser</div>,
  };
});

const INITIAL_FILTERS = {
  access: 'all' as const,
  resource: 'all' as const,
  tool: '',
  sort: 'recent' as const,
  q: '',
};

describe('MarketplaceBootstrap', () => {
  it('constrains mobile filter rows so long tool lists cannot widen the page', () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(3, true)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[
          {
            label: 'A deliberately long source tool name',
            slug: 'long-source-tool',
          },
        ]}
      />
    );

    for (const label of ['Access', 'Kind', 'Tool']) {
      expect(screen.getByText(label).parentElement).toHaveClass('min-w-0');
    }
  });

  beforeEach(() => {
    browserModuleLoaded.mockClear();
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Four: one full row of the grid at its widest.
  it('server-renders only the compact filter surface and first four cards', () => {
    const markup = renderToStaticMarkup(
      <MarketplaceBootstrap
        initialPage={createPage(5, true)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    expect(markup).toContain('data-marketplace-bootstrap-shell');
    expect(markup).toContain('Unlock 1');
    expect(markup).toContain('Unlock 4');
    expect(markup).not.toContain('Unlock 5');
    expect(markup).toContain('Load more recipes');
    expect(markup).not.toContain('Interactive marketplace browser');
    expect(browserModuleLoaded).not.toHaveBeenCalled();
  });

  // The cards printed the bare quote: "$0.50 recipe" and "Unlock for $0.50" for
  // a recipe only credits buy, "$0.00" on a free one. The tile's chip prices it
  // in credits; its unlock action names every way to pay, as the post's panel does.
  it('prices each card the way its post does, a credits-only one in credits alone', () => {
    const page = createPage(3, false);
    page.items[0] = {
      ...page.items[0],
      accessMode: 'paid',
      priceUsdCents: 900,
      priceQuote: { currency: 'INR', amountSubunits: 75000, formatted: '₹750', note: null },
    };
    page.items[1] = {
      ...page.items[1],
      accessMode: 'paid',
      priceUsdCents: 50,
      priceQuote: { currency: 'USD', amountSubunits: 50, formatted: '$0.50', note: null },
    };

    render(
      <MarketplaceBootstrap
        initialPage={page}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    const cashCard = screen.getByRole('link', { name: 'Unlock for ₹750 · 900 credits: Unlock 1' });
    // The chip prices it in credits, as every other chip does (audit B-F13);
    // the cash figure is the unlock action's, which names every way to pay.
    expect(within(cashCard).getByText('900 credits')).toBeInTheDocument();
    expect(within(cashCard).queryByText('₹750')).not.toBeInTheDocument();
    expect(within(cashCard).getByText('Unlock for ₹750 · 900 credits')).toBeInTheDocument();

    const creditsCard = screen.getByRole('link', { name: 'Unlock for 50 credits: Unlock 2' });
    expect(within(creditsCard).getByText('50 credits')).toBeInTheDocument();
    expect(within(creditsCard).getByText('Unlock for 50 credits')).toBeInTheDocument();
    expect(creditsCard).not.toHaveTextContent('$0.50');

    const freeCard = screen.getByRole('link', { name: 'View free recipe: Unlock 3' });
    expect(within(freeCard).getByText('Free recipe')).toBeInTheDocument();
    expect(within(freeCard).getByText('View free recipe')).toBeInTheDocument();
    expect(freeCard).not.toHaveTextContent('$0.00');
  });

  // The owner preferred Explore's tiles to the old storefront cards
  // (2026-10-27): the cover in a 4:5 frame, then the title and date, the
  // creator, and the recipe's price and kinds, in Explore's own grid.
  it('draws each recipe as Explore draws a post', () => {
    const page = createPage(1, false);
    page.items[0] = { ...page.items[0], freeUnlockCount: 5 };

    render(
      <MarketplaceBootstrap
        initialPage={page}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    const tile = screen.getByRole('link', { name: 'View free recipe: Unlock 1' });
    expect(tile.parentElement).toHaveClass(...SHOWCASE_FEED_GRID_CLASS.split(' '));
    expect(tile.firstElementChild).toHaveClass('aspect-[4/5]');
    expect(within(tile).getByRole('heading', { name: 'Unlock 1' })).toBeInTheDocument();
    expect(within(tile).getByText('Apr 25')).toHaveAttribute('datetime', '2026-04-25T10:00:00.000Z');
    expect(within(tile).getByText('Creator 1')).toBeInTheDocument();
    expect(within(tile).getByText('@creator-1')).toBeInTheDocument();
    expect(within(tile).getByText('5 opened')).toBeInTheDocument();
    expect(within(tile).getByText('Prompt')).toBeInTheDocument();
  });

  // A search or filter that matched nothing said "No recipes yet" and offered
  // Share a post, as if the storefront were empty.
  it('says no recipes match, and offers to clear the filters, when a search finds nothing', () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(0, false)}
        initialFilters={{ ...INITIAL_FILTERS, access: 'paid', q: 'product demo' }}
        sourceToolOptions={[]}
      />
    );

    expect(screen.getByRole('heading', { name: 'No recipes match' })).toBeInTheDocument();
    const clearLinks = screen.getAllByRole('link', { name: 'Clear filters' });
    expect(clearLinks.length).toBeGreaterThan(0);
    for (const link of clearLinks) {
      expect(link).toHaveAttribute('href', '/marketplace');
    }
    expect(screen.queryByRole('heading', { name: 'No recipes yet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Share a post' })).not.toBeInTheDocument();
  });

  it('still says no recipes yet when only the order was changed', () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(0, false)}
        initialFilters={{ ...INITIAL_FILTERS, sort: 'top-sales' }}
        sourceToolOptions={[]}
      />
    );

    expect(screen.getByRole('heading', { name: 'No recipes yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Share a post' })).toHaveAttribute(
      'href',
      '/post/new?from=marketplace&returnTo=%2Fmarketplace'
    );
  });

  it('answers a query under three characters with the hint and keeps it in the box', () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(0, false)}
        initialFilters={{ ...INITIAL_FILTERS, resource: 'prompt' }}
        shortQuery="ai"
        sourceToolOptions={[]}
      />
    );

    expect(screen.getByRole('heading', { name: 'Type at least 3 characters' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /search marketplace recipes/i })).toHaveValue('ai');
    expect(screen.getByRole('link', { name: 'Clear search' })).toHaveAttribute(
      'href',
      '/marketplace?resource=prompt&sort=recent'
    );
    expect(screen.queryByRole('heading', { name: 'No recipes match' })).not.toBeInTheDocument();
  });

  // The page leaves out the recipes of creators a signed-in viewer blocks;
  // a first page left empty by that still has more to load.
  it('offers the next page, not an empty state, when every first-page card was taken out', () => {
    render(
      <MarketplaceBootstrap
        initialPage={{ items: [], pageInfo: { hasMore: true, nextOffset: 3, offset: 0, limit: 3 } }}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    expect(screen.queryByRole('heading', { name: 'No recipes yet' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load more recipes/i })).toBeInTheDocument();
  });

  it('resizes an original image when no generated preview is available', () => {
    const page = createPage(1, false);
    page.items[0].post = {
      id: 'post-1',
      generationId: null,
      title: 'Large source image',
      category: 'image',
      body: '',
      postFormat: 'media',
      visibility: 'public',
      archivedAt: null,
      tombstoned: false,
      reviewStatus: 'visible',
      sourceKind: 'magicbooklet',
      sourceTool: null,
      sourceToolSlug: null,
      mediaUrl: '/large-source.png',
      mediaPreviewUrl: null,
      mediaRenditionUrl: null,
      mediaKind: 'image',
      saveCount: 0,
      remixCount: 0,
      shareVisitCount: 0,
    };

    render(
      <MarketplaceBootstrap
        initialPage={page}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    const image = screen.getByRole('img', { name: 'Large source image' });
    const renderedUrl = new URL(image.getAttribute('src') ?? '', 'http://localhost');
    expect(renderedUrl.pathname).toBe('/_next/image');
    expect(renderedUrl.searchParams.get('url')).toBe('/large-source.png');
  });

  it('keeps search, filters, and card destinations accessible without activating JavaScript', async () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(3, true)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[
          { slug: 'runway', label: 'Runway' },
        ]}
      />
    );

    expect(screen.getByRole('searchbox', { name: /search marketplace recipes/i }))
      .toHaveAttribute('name', 'q');
    expect(screen.getByRole('searchbox', { name: /search marketplace recipes/i }))
      .toHaveClass('min-w-0');
    expect(screen.getByRole('link', { name: 'Recent' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Paid' })).toHaveAttribute(
      'href',
      '/marketplace?access=paid&sort=recent'
    );
    expect(screen.getByRole('link', { name: 'Runway' })).toHaveAttribute(
      'href',
      '/marketplace?tool=runway&sort=recent'
    );
    expect(screen.getByRole('link', { name: 'View free recipe: Unlock 1' })).toHaveAttribute(
      'href',
      '/showcase/post-1?from=unlocks&returnTo=%2Fmarketplace%3Fsort%3Drecent#recipe'
    );

    await act(async () => Promise.resolve());
    expect(browserModuleLoaded).not.toHaveBeenCalled();
    expect(screen.queryByTestId('interactive-marketplace-browser')).not.toBeInTheDocument();
  });

  it('preserves active filters in the native search form', () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(3, false)}
        initialFilters={{
          access: 'free',
          resource: 'prompt',
          tool: 'runway',
          sort: 'top-sales',
          q: 'product demo',
        }}
        sourceToolOptions={[
          { slug: 'runway', label: 'Runway' },
        ]}
      />
    );

    const form = screen.getByRole('search');
    expect(form).toBeInstanceOf(HTMLFormElement);
    const formData = new FormData(form as HTMLFormElement);

    expect(form).toHaveAttribute('action', '/marketplace');
    expect(form).toHaveAttribute('method', 'get');
    expect(formData.get('access')).toBe('free');
    expect(formData.get('resource')).toBe('prompt');
    expect(formData.get('tool')).toBe('runway');
    expect(formData.get('sort')).toBe('top-sales');
    expect(formData.get('q')).toBe('product demo');
  });

  it('warms on focus but hands off to the full browser only for load-more demand', async () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(3, true)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    fireEvent.focus(screen.getByRole('searchbox', { name: /search marketplace recipes/i }));

    await waitFor(() => {
      expect(browserModuleLoaded).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('Unlock 1')).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-marketplace-browser')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more recipes/i }));

    expect(await screen.findByTestId('interactive-marketplace-browser')).toBeInTheDocument();
    expect(screen.queryByText('Unlock 1')).not.toBeInTheDocument();
  });

  it('activates near the continuation sentinel only after scroll intent', async () => {
    let intersectionCallback: IntersectionObserverCallback | null = null;

    class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '160px 0px';
      readonly thresholds = [0];

      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }

      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    }

    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    render(
      <MarketplaceBootstrap
        initialPage={createPage(3, true)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    expect(intersectionCallback).toBeNull();
    expect(screen.queryByTestId('interactive-marketplace-browser')).not.toBeInTheDocument();

    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 200,
    });
    fireEvent.scroll(window);

    await waitFor(() => {
      expect(intersectionCallback).not.toBeNull();
    });
    act(() => {
      const callback = intersectionCallback as IntersectionObserverCallback;
      callback([
        { isIntersecting: true } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    expect(await screen.findByTestId('interactive-marketplace-browser')).toBeInTheDocument();
  });
});

function createPage(count: number, hasMore: boolean) {
  return {
    items: Array.from({ length: count }, (_, index) => createMarketplaceItem(index + 1)),
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? count : null,
      offset: 0,
      limit: 4,
    },
  };
}

function createMarketplaceItem(index: number): MarketplaceResourceListItem {
  const date = '2026-04-25T10:00:00.000Z';

  return {
    id: `bundle-${index}`,
    postId: `post-${index}`,
    legacyAssetId: null,
    title: `Unlock ${index}`,
    summary: 'A reusable creator prompt.',
    previewText: 'Prompt included.',
    accessMode: 'free',
    priceUsdCents: 0,
    salesCount: 0,
    freeUnlockCount: 0,
    earningsUsdCents: 0,
    allowRemix: false,
    resourceKinds: ['prompt'],
    lockedPreview: {
      resourceKinds: ['prompt'],
      attachmentPreviews: [],
      itemCounts: { prompt: 1 },
      itemPreviews: [],
      hasPrompt: true,
      hasNotes: false,
      hasWorkflow: false,
      hasRemix: false,
      updatedAt: date,
    },
    createdAt: date,
    updatedAt: date,
    seller: {
      id: `creator-${index}`,
      username: `creator-${index}`,
      name: `Creator ${index}`,
      avatar: null,
    },
    post: null,
    priceQuote: {
      currency: 'USD',
      amountSubunits: 0,
      formatted: '$0.00',
      note: null,
    },
    remixCapability: 'none',
    remixTarget: null,
  };
}
