import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MarketplaceBootstrap from '@/app/marketplace/MarketplaceBootstrap';
import { marketplaceFiltersKey } from '@/app/marketplace/marketplace-address';
import { SHOWCASE_FEED_GRID_CLASS } from '@/app/showcase/showcase-layout';
import {
  buildMarketplacePagesKey,
  rememberMarketplaceFiltersOpen,
  rememberMarketplacePages,
} from '@/lib/marketplace-pages-memory';

import { createMarketplacePage } from './fixtures/marketplace-listing';

const browserModuleLoaded = vi.hoisted(() => vi.fn());

// The address bar's query once the page is live; null, as outside Next's router, unless a case
// sets it.
const addressBar = vi.hoisted(() => ({ search: null as string | null }));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => (addressBar.search === null ? null : new URLSearchParams(addressBar.search)),
}));

// Who the page's auth provider says is looking: the provider's own answer (nobody, outside one)
// unless a case sets it.
const viewerState = vi.hoisted(() => ({
  value: null as null | { session: null; user: { id: string } | null; isLoading: boolean },
}));

vi.mock('@/components/AuthProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/AuthProvider')>();
  return {
    ...actual,
    useAuth: () => (viewerState.value ? { ...actual.useAuth(), ...viewerState.value } : actual.useAuth()),
  };
});

// What the shell handed the interactive list when it last drew it.
const browserProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));

vi.mock('@/app/marketplace/MarketplaceBrowser', () => {
  browserModuleLoaded();

  return {
    default: (props: Record<string, unknown>) => {
      browserProps.last = props;
      return <div data-testid="interactive-marketplace-browser">Interactive marketplace browser</div>;
    },
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
    browserProps.last = null;
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
    // Edited since: Recent sorts by when a recipe went up, so that is its date.
    page.items[0] = { ...page.items[0], freeUnlockCount: 5, updatedAt: '2026-10-27T10:00:00.000Z' };

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
    expect(tile).not.toHaveTextContent('Oct 27');
    expect(within(tile).getByText('Creator 1')).toBeInTheDocument();
    expect(within(tile).getByText('@creator-1')).toBeInTheDocument();
    // The tile is the one link: the creator row inside it has none of its own.
    expect(within(tile).queryByRole('link')).not.toBeInTheDocument();
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
      // At the post's top: no `#recipe` (owner, 2026-11-16).
      '/showcase/post-1?from=unlocks&returnTo=%2Fmarketplace%3Fsort%3Drecent'
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

  // Live sweep, 2026-11-17: the first press only brought the interactive list in, which drew the
  // same four recipes, and the reader had to press again. The press goes with the list it brings,
  // which asks for the next page itself (marketplace-browser-progressive-render's cases).
  it('hands the list a press of Load more, which reads as loading until the list comes', async () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(4, true)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /load more recipes/i }));
    expect(screen.getByRole('button', { name: 'Loading' })).toBeDisabled();

    expect(await screen.findByTestId('interactive-marketplace-browser')).toBeInTheDocument();
    expect(browserProps.last).toMatchObject({
      loadMoreOnOpen: marketplaceFiltersKey(INITIAL_FILTERS),
      // A press asks for one page: the list waits for the reader to scroll before the next.
      scrolledOnOpen: false,
      // Outside Next's router no read of the address's own first page is coming.
      listingSettled: true,
      initialFiltersOpen: false,
    });
  });

  // Below 1024px the filters wait behind Filters (live sweep, 2026-11-17: on a phone they and the
  // hero filled the first screen); the list that takes over keeps them as the reader left them.
  it('keeps the filters behind Filters, and hands them over open or folded as the reader left them', async () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(4, true)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    const filters = screen.getByRole('button', { name: 'Filters' });
    const panel = document.getElementById(filters.getAttribute('aria-controls') ?? '');
    expect(filters).toHaveAttribute('aria-expanded', 'false');
    expect(filters).toHaveClass('lg:hidden');
    expect(panel).toHaveClass('hidden', 'lg:block');
    expect(within(panel!).getByRole('link', { name: 'Paid' })).toBeInTheDocument();
    expect(within(panel!).getByRole('link', { name: 'Top sales' })).toBeInTheDocument();
    // The search is never folded away.
    expect(panel).not.toContainElement(screen.getByRole('searchbox', { name: /search marketplace recipes/i }));

    fireEvent.click(filters);
    expect(filters).toHaveAttribute('aria-expanded', 'true');
    expect(panel).toHaveClass('block');
    expect(panel).not.toHaveClass('hidden');

    fireEvent.click(screen.getByRole('button', { name: /load more recipes/i }));
    expect(await screen.findByTestId('interactive-marketplace-browser')).toBeInTheDocument();
    expect(browserProps.last).toMatchObject({ initialFiltersOpen: true });
  });

  // Review of #837: `?sort=price-low` on a phone said nothing of the order, folded behind Filters.
  it('names an order other than Recent while the filters are folded, and counts what is set on Filters', () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(4, true)}
        initialFilters={{ ...INITIAL_FILTERS, access: 'free', sort: 'price-low' }}
        sourceToolOptions={[]}
      />
    );

    expect(screen.getByText(/^Showing Free/)).toHaveTextContent('Showing Free · Sorted by Price low');
    expect(screen.getByText(/Sorted by Price low/, { selector: 'span' })).toHaveClass('lg:hidden');
    expect(screen.getByRole('button', { name: 'Filters, 2 set' })).toHaveAttribute('aria-expanded', 'false');
  });

  // Owner's report, 2026-11-20: every page needed a press of "Load more recipes", and a scroll to the
  // first page's end only brought the interactive list in, which drew the same four recipes. The
  // scroll now asks for the next page as a press does, from Home's distance, and only once the reader
  // has scrolled with a gesture of theirs: a first screen whose recipes end above the fold, and a
  // shell drawn at a place the window was left or put back at (review of #888), ask for nothing.
  it('brings the list in and asks it for the next page once the reader scrolls towards the end', async () => {
    let intersectionCallback: IntersectionObserverCallback | null = null;
    const margins: Array<string | undefined> = [];

    class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '600px 0px';
      readonly thresholds = [0];

      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        intersectionCallback = callback;
        margins.push(options?.rootMargin);
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

    // The window moving is no scroll of the reader's: Back's restored place, a navigation left scrolled.
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 200,
    });
    fireEvent.scroll(window);
    await act(async () => Promise.resolve());
    expect(intersectionCallback).toBeNull();

    // A turn of the wheel is.
    fireEvent.wheel(window, { deltaY: 200 });
    await waitFor(() => {
      expect(intersectionCallback).not.toBeNull();
    });
    expect(margins).toEqual(['600px 0px']);
    act(() => {
      const callback = intersectionCallback as IntersectionObserverCallback;
      callback([
        { isIntersecting: true } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });
    // Asked for from here on, as a press is: the button says so until the list comes.
    expect(screen.getByRole('button', { name: 'Loading' })).toBeDisabled();

    expect(await screen.findByTestId('interactive-marketplace-browser')).toBeInTheDocument();
    expect(browserProps.last).toMatchObject({
      loadMoreOnOpen: marketplaceFiltersKey(INITIAL_FILTERS),
      // The reader is scrolling: the list goes on asking as its end comes near.
      scrolledOnOpen: true,
    });
  });

  // A browser may still deliver a notice it queued before the shell let its observer go: one for a
  // first page the shell no longer draws asks for nothing.
  it('acts on no notice queued for a first page it no longer draws', async () => {
    let intersectionCallback: IntersectionObserverCallback | null = null;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }

      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    });
    const view = render(
      <MarketplaceBootstrap initialPage={createPage(4, true)} initialFilters={INITIAL_FILTERS} sourceToolOptions={[]} />
    );
    fireEvent.wheel(window, { deltaY: 200 });
    await waitFor(() => {
      expect(intersectionCallback).not.toBeNull();
    });

    // The first page is drawn again with nothing after it before the notice comes.
    view.rerender(
      <MarketplaceBootstrap initialPage={createPage(4, false)} initialFilters={INITIAL_FILTERS} sourceToolOptions={[]} />
    );
    act(() => {
      const callback = intersectionCallback as IntersectionObserverCallback;
      callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    await act(async () => Promise.resolve());

    expect(screen.queryByTestId('interactive-marketplace-browser')).not.toBeInTheDocument();
    expect(screen.getByText('Unlock 4')).toBeInTheDocument();
  });

  // A listing picked in place on a scrolled shell is a first screen of its own: its end is watched
  // once the reader scrolls it.
  it('waits for a listing picked in place to be scrolled itself', async () => {
    let observersMade = 0;
    vi.stubGlobal('IntersectionObserver', class {
      constructor() {
        observersMade += 1;
      }

      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    });
    const view = render(
      <MarketplaceBootstrap initialPage={createPage(4, true)} initialFilters={INITIAL_FILTERS} sourceToolOptions={[]} />
    );
    fireEvent.wheel(window, { deltaY: 200 });
    await waitFor(() => {
      expect(observersMade).toBe(1);
    });

    view.rerender(
      <MarketplaceBootstrap initialPage={createPage(4, true)} initialFilters={{ ...INITIAL_FILTERS, access: 'paid' }} sourceToolOptions={[]} />
    );
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 600 });
    fireEvent.scroll(window);
    await act(async () => Promise.resolve());
    expect(observersMade).toBe(1);

    fireEvent.wheel(window, { deltaY: 200 });
    await waitFor(() => {
      expect(observersMade).toBe(2);
    });
  });

  // Back from a recipe drew this shell, the first page alone, though Load more had brought more
  // (owner's report, 2026-11-15): the browser was put back only after a scroll, too late for the
  // reader's place. A listing kept with later pages is handed to the browser before the paint.
  describe('drawn again after a recipe', () => {
    afterEach(() => {
      addressBar.search = null;
      window.sessionStorage.clear();
    });

    // As on the reader's first visit to the listing: Load more brought the browser.
    async function browserCameInThisDocument() {
      const firstVisit = render(
        <MarketplaceBootstrap initialPage={createPage(4, true)} initialFilters={INITIAL_FILTERS} sourceToolOptions={[]} />
      );
      fireEvent.click(screen.getByRole('button', { name: /load more recipes/i }));
      expect(await screen.findByTestId('interactive-marketplace-browser')).toBeInTheDocument();
      firstVisit.unmount();
    }

    function backToListing() {
      // The page is live: the address bar's query is read, and the listing's first page is asked for.
      addressBar.search = '';
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
      return render(
        <MarketplaceBootstrap initialPage={createPage(4, true)} initialFilters={INITIAL_FILTERS} sourceToolOptions={[]} />
      );
    }

    it('hands a listing kept with later pages to the browser in the first frame', async () => {
      await browserCameInThisDocument();
      rememberMarketplacePages(
        buildMarketplacePagesKey(marketplaceFiltersKey(INITIAL_FILTERS), null),
        4,
        createPage(16, true),
      );

      backToListing();

      expect(screen.getByTestId('interactive-marketplace-browser')).toBeInTheDocument();
      expect(screen.queryByText('Unlock 1')).not.toBeInTheDocument();
    });

    it('stays the shell for a listing kept at its first page alone', async () => {
      await browserCameInThisDocument();

      backToListing();

      expect(screen.queryByTestId('interactive-marketplace-browser')).not.toBeInTheDocument();
      expect(screen.getByText('Unlock 1')).toBeInTheDocument();
    });

    // Review of #837: a phone that had left the filters open came back with them folded, the page
    // above the grid a panel shorter, and the reader landed that far down from their recipe.
    it('draws the filters open again where the reader left them open, the shell and the list it hands over', async () => {
      const listingKey = marketplaceFiltersKey(INITIAL_FILTERS);
      rememberMarketplaceFiltersOpen(listingKey, true);

      const shell = backToListing();
      const filters = screen.getByRole('button', { name: 'Filters' });
      expect(filters).toHaveAttribute('aria-expanded', 'true');
      expect(document.getElementById(filters.getAttribute('aria-controls') ?? '')).toHaveClass('block');
      shell.unmount();

      await browserCameInThisDocument();
      rememberMarketplacePages(buildMarketplacePagesKey(listingKey, null), 4, createPage(16, true));
      rememberMarketplaceFiltersOpen(listingKey, true);
      backToListing();
      expect(screen.getByTestId('interactive-marketplace-browser')).toBeInTheDocument();
      expect(browserProps.last).toMatchObject({ initialFiltersOpen: true });
    });

    it("draws them folded for another listing's, or once they were folded", () => {
      rememberMarketplaceFiltersOpen(marketplaceFiltersKey({ ...INITIAL_FILTERS, access: 'paid' }), true);

      backToListing();

      expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', 'false');
    });

    // Owner's recording, 2026-11-16: signed in, Back drew the first page alone, because the page's
    // auth provider, mounted again, was still asking who was signed in, and the kept listing was
    // looked for as a visitor's. The session cookie names the reader meanwhile.
    describe('for a signed-in reader the page is still asking about', () => {
      const SESSION_COOKIE = 'sb-project-auth-token';

      afterEach(() => {
        viewerState.value = null;
        document.cookie = `${SESSION_COOKIE}=; Max-Age=0; Path=/`;
        vi.unstubAllEnvs();
      });

      it('hands the reader\'s kept listing to the browser in the first frame', async () => {
        await browserCameInThisDocument();
        rememberMarketplacePages(
          buildMarketplacePagesKey(marketplaceFiltersKey(INITIAL_FILTERS), 'viewer-1'),
          4,
          createPage(16, true),
        );
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
        const cookieSession = btoa(JSON.stringify({ access_token: 'token', user: { id: 'viewer-1' } }))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        document.cookie = `${SESSION_COOKIE}=base64-${cookieSession}; Path=/`;
        viewerState.value = { session: null, user: null, isLoading: true };

        backToListing();

        expect(screen.getByTestId('interactive-marketplace-browser')).toBeInTheDocument();
        expect(screen.queryByText('Unlock 1')).not.toBeInTheDocument();
      });

      it('never hands another account\'s kept listing over', async () => {
        await browserCameInThisDocument();
        rememberMarketplacePages(
          buildMarketplacePagesKey(marketplaceFiltersKey(INITIAL_FILTERS), 'someone-else'),
          4,
          createPage(16, true),
        );
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
        const cookieSession = btoa(JSON.stringify({ access_token: 'token', user: { id: 'viewer-1' } }))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        document.cookie = `${SESSION_COOKIE}=base64-${cookieSession}; Path=/`;
        viewerState.value = { session: null, user: null, isLoading: true };

        backToListing();

        expect(screen.queryByTestId('interactive-marketplace-browser')).not.toBeInTheDocument();
        expect(screen.getByText('Unlock 1')).toBeInTheDocument();
      });
    });
  });
});

/** A first page as the server hands it to the shell, asked for four recipes. */
function createPage(count: number, hasMore: boolean) {
  return createMarketplacePage(count, hasMore, 0, 4);
}
