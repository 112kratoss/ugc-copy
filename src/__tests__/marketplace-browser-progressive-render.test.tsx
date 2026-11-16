import { StrictMode, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MarketplaceBootstrap from '@/app/marketplace/MarketplaceBootstrap';
import MarketplaceBrowser from '@/app/marketplace/MarketplaceBrowser';
import { marketplaceFiltersKey } from '@/app/marketplace/marketplace-address';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

// One router for every render, so the browser's effects never see a new one.
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const pushMock = routerMock.push;

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  // No router around these lists: the shell keeps the address it was given.
  useSearchParams: () => null,
}));

const authState = vi.hoisted(() => ({
  session: null as { access_token: string } | null,
  user: null as { id: string } | null,
  // Whether the page's auth provider is still asking who is signed in.
  isLoading: false,
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: authState.session, user: authState.user, isLoading: authState.isLoading }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const INITIAL_FILTERS = {
  access: 'all' as const,
  resource: 'all' as const,
  tool: '',
  sort: 'recent' as const,
  q: '',
};

describe('MarketplaceBrowser bootstrap pagination', () => {
  beforeEach(() => {
    pushMock.mockReset();
    authState.session = null;
    authState.user = null;
    // A listing keeps what Load more brought for the tab: one case's pages must not reach the next.
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serializes all four production bootstrap cards and exposes pagination', () => {
    const markup = renderToStaticMarkup(
      <MarketplaceBrowser
        initialPage={createPage(4, true, 0, 4)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    expect(markup).toContain('Unlock 1');
    expect(markup).toContain('Unlock 4');
    expect(markup).not.toContain('Unlock 5');
    expect(markup).toContain('Load more recipes');
    expect(markup).not.toContain('data-marketplace-bootstrap-sentinel');
  });

  // Same words as the bootstrap tile it replaces: credits on the chip, every way
  // to pay on the unlock action, credits alone below the cash minimum.
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

    renderMarketplace(page);

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

  // The catalog is the same cached page for everyone; a signed-in viewer's own
  // recipes are read apart from it, and their cards say so with no price
  // (glossary: "Unlocked" / "Your recipe", never the price).
  it("re-labels the signed-in viewer's unlocked and own recipes, without a price", async () => {
    authState.session = { access_token: 'token-1' };
    authState.user = { id: 'creator-2' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (
      String(input) === '/api/me/unlocked-recipes'
        ? new Response(JSON.stringify({ success: true, bundleIds: ['bundle-1'] }))
        : new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const page = createPage(3, false);
    page.items[0] = {
      ...page.items[0],
      accessMode: 'paid',
      priceUsdCents: 900,
      priceQuote: { currency: 'USD', amountSubunits: 900, formatted: '$9.00', note: null },
    };
    page.items[1] = {
      ...page.items[1],
      accessMode: 'paid',
      priceUsdCents: 300,
      priceQuote: { currency: 'USD', amountSubunits: 300, formatted: '$3.00', note: null },
    };

    renderMarketplace(page);

    const unlocked = await screen.findByRole('link', { name: 'View recipe: Unlock 1' });
    expect(within(unlocked).getByText('Unlocked')).toBeInTheDocument();
    expect(unlocked).not.toHaveTextContent('900 credits');
    expect(unlocked).not.toHaveTextContent('$9.00');
    const own = screen.getByRole('link', { name: 'View recipe: Unlock 2' });
    expect(within(own).getByText('Your recipe')).toBeInTheDocument();
    expect(own).not.toHaveTextContent('300 credits');
    // Anyone else's recipe keeps its words.
    expect(screen.getByRole('link', { name: 'View free recipe: Unlock 3' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A free unlock stopped counting as a sale on 2026-10-17 (decision 6).
  it("counts a free recipe's free unlocks and a paid recipe's sales", () => {
    const page = createPage(2, false);
    page.items[0] = { ...page.items[0], salesCount: 0, freeUnlockCount: 5 };
    page.items[1] = {
      ...page.items[1],
      accessMode: 'paid',
      priceUsdCents: 900,
      priceQuote: { currency: 'INR', amountSubunits: 75000, formatted: '₹750', note: null },
      salesCount: 3,
      freeUnlockCount: 2,
    };

    renderMarketplace(page);

    expect(within(screen.getByRole('link', { name: 'View free recipe: Unlock 1' })).getByText('5 opened')).toBeInTheDocument();
    expect(
      within(screen.getByRole('link', { name: 'Unlock for ₹750 · 900 credits: Unlock 2' })).getByText('3 sold')
    ).toBeInTheDocument();
  });

  it('continues a four-item bootstrap at offset four with the compact API page size', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      items: [
        createMarketplaceItem(4),
        createMarketplaceItem(5),
        createMarketplaceItem(5),
      ],
      pageInfo: {
        hasMore: false,
        nextOffset: null,
        offset: 4,
        limit: 12,
      },
    })));
    renderMarketplace(createPage(4, true, 0, 4));

    fireEvent.click(screen.getByRole('button', { name: /load more recipes/i }));

    await waitFor(() => {
      expect(screen.getByText('Unlock 5')).toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/marketplace/resources?offset=4&limit=12',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      })
    );
    expect(screen.getAllByText('Unlock 4')).toHaveLength(1);
    expect(screen.getAllByText('Unlock 5')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /load more recipes/i })).not.toBeInTheDocument();
  });

  // "Load more" sent no session, so the API could not take a signed-in
  // viewer's blocked creators out of any page after the first.
  it("sends a signed-in viewer's session with Load more, and nothing for a visitor", async () => {
    const nextPage = () => new Response(JSON.stringify({
      items: [createMarketplaceItem(4)],
      pageInfo: { hasMore: false, nextOffset: null, offset: 3, limit: 12 },
    }));
    vi.mocked(fetch).mockImplementation(async () => nextPage());
    authState.session = { access_token: 'token-1' };
    authState.user = { id: 'viewer-1' };
    const { unmount } = renderMarketplace(createPage(3, true, 0, 3));

    fireEvent.click(screen.getByRole('button', { name: /load more recipes/i }));
    await screen.findByText('Unlock 4');

    expect(fetch).toHaveBeenCalledWith(
      '/api/marketplace/resources?offset=3&limit=12',
      expect.objectContaining({
        headers: { Accept: 'application/json', Authorization: 'Bearer token-1' },
      })
    );
    unmount();

    authState.session = null;
    authState.user = null;
    renderMarketplace(createPage(3, true, 0, 3));
    fireEvent.click(screen.getByRole('button', { name: /load more recipes/i }));
    await screen.findByText('Unlock 4');

    // Bare, so the edge keeps serving the shared copy.
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/marketplace/resources?offset=3&limit=12',
      expect.objectContaining({ headers: { Accept: 'application/json' } })
    );
  });

  it('says no recipes match, and offers to clear the filters, when a search finds nothing', () => {
    render(
      <MarketplaceBrowser
        initialPage={createPage(0, false)}
        initialFilters={{ ...INITIAL_FILTERS, tool: 'runway' }}
        sourceToolOptions={[]}
      />
    );

    expect(screen.getByRole('heading', { name: 'No recipes match' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute('href', '/marketplace');
    expect(screen.queryByRole('link', { name: 'Share a post' })).not.toBeInTheDocument();
  });

  // The page is cached for everyone: a filter or a search moves the listing in
  // place (`useMarketplaceListing`), and the list says so while it is read.
  describe('on the cached page', () => {
    it('moves a filter, a sort, Clear and the search in place, and the router is not asked', () => {
      const onNavigate = vi.fn();
      render(
        <MarketplaceBrowser
          initialPage={createPage(2, false)}
          initialFilters={{ ...INITIAL_FILTERS, access: 'paid' }}
          sourceToolOptions={[{ slug: 'runway', label: 'Runway' }]}
          onNavigate={onNavigate}
        />
      );

      fireEvent.click(screen.getByRole('link', { name: 'Free' }));
      fireEvent.click(screen.getByRole('link', { name: 'Top sales' }));
      fireEvent.click(screen.getByRole('link', { name: 'Runway' }));
      fireEvent.click(screen.getByRole('link', { name: 'Clear' }));
      fireEvent.change(screen.getByPlaceholderText('Search prompts, tools, creators'), { target: { value: 'neon' } });
      fireEvent.submit(screen.getByPlaceholderText('Search prompts, tools, creators').closest('form')!);

      expect(onNavigate.mock.calls.map(([href]) => href)).toEqual([
        '/marketplace?access=free&sort=recent',
        '/marketplace?access=paid&sort=top-sales',
        '/marketplace?access=paid&tool=runway&sort=recent',
        '/marketplace',
        '/marketplace?access=paid&q=neon&sort=recent',
      ]);
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('leaves a click with a modifier to the link itself', () => {
      const onNavigate = vi.fn();
      render(
        <MarketplaceBrowser
          initialPage={createPage(2, false)}
          initialFilters={INITIAL_FILTERS}
          sourceToolOptions={[]}
          onNavigate={onNavigate}
        />
      );

      fireEvent.click(screen.getByRole('link', { name: 'Free' }), { ctrlKey: true });
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it('draws the listing loading, then failed with Try again, in place of the cards', () => {
      const onRetry = vi.fn();
      const view = render(
        <MarketplaceBrowser
          initialPage={createPage(0, false)}
          initialFilters={{ ...INITIAL_FILTERS, access: 'free' }}
          sourceToolOptions={[]}
          listingStatus="loading"
          onNavigate={vi.fn()}
          onRetry={onRetry}
        />
      );
      expect(screen.getByLabelText('Loading marketplace recipes')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'No recipes match' })).not.toBeInTheDocument();

      view.rerender(
        <MarketplaceBrowser
          initialPage={createPage(0, false)}
          initialFilters={{ ...INITIAL_FILTERS, access: 'free' }}
          sourceToolOptions={[]}
          listingStatus="failed"
          onNavigate={vi.fn()}
          onRetry={onRetry}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  it('says no recipes yet only when nothing is filtered', () => {
    renderMarketplace(createPage(0, false));

    expect(screen.getByRole('heading', { name: 'No recipes yet' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No recipes match' })).not.toBeInTheDocument();
  });

  it('answers a query under three characters with the hint and keeps it in the box', () => {
    render(
      <MarketplaceBrowser
        initialPage={createPage(0, false)}
        initialFilters={INITIAL_FILTERS}
        shortQuery="ai"
        sourceToolOptions={[]}
      />
    );

    expect(screen.getByRole('heading', { name: 'Type at least 3 characters' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search prompts, tools, creators')).toHaveValue('ai');
    expect(screen.getByRole('link', { name: 'Clear search' })).toHaveAttribute('href', '/marketplace?sort=recent');
  });

  it('offers the next page, not an empty state, when every first-page card was taken out', () => {
    renderMarketplace({ items: [], pageInfo: { hasMore: true, nextOffset: 3, offset: 0, limit: 3 } });

    expect(screen.queryByRole('heading', { name: 'No recipes yet' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load more recipes/i })).toBeInTheDocument();
  });

  it('uses each response nextOffset without gaps when loading another normal page', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: Array.from({ length: 12 }, (_, index) => createMarketplaceItem(index + 4)),
        pageInfo: {
          hasMore: true,
          nextOffset: 15,
          offset: 3,
          limit: 12,
        },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [createMarketplaceItem(16)],
        pageInfo: {
          hasMore: false,
          nextOffset: null,
          offset: 15,
          limit: 12,
        },
      })));
    renderMarketplace(createPage(3, true, 0, 3));

    fireEvent.click(screen.getByRole('button', { name: /load more recipes/i }));
    await screen.findByText('Unlock 15');
    fireEvent.click(screen.getByRole('button', { name: /load more recipes/i }));

    await waitFor(() => {
      expect(screen.getByText('Unlock 16')).toBeInTheDocument();
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/marketplace/resources?offset=15&limit=12',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('ignores a continuation response that resolves after filter navigation', async () => {
    let resolveRequest: ((response: Response) => void) | null = null;
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));
    const { rerender } = renderMarketplace(createPage(3, true, 0, 3));

    fireEvent.click(screen.getByRole('button', { name: /load more recipes/i }));
    const requestSignal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;

    rerender(
      <MarketplaceBrowser
        initialPage={createPage(3, false, 100, 3)}
        initialFilters={{ ...INITIAL_FILTERS, q: 'new query' }}
        sourceToolOptions={[]}
      />
    );

    expect(requestSignal?.aborted).toBe(true);
    await act(async () => {
      resolveRequest?.(new Response(JSON.stringify({
        items: [createMarketplaceItem(4)],
        pageInfo: {
          hasMore: true,
          nextOffset: 15,
          offset: 3,
          limit: 12,
        },
      })));
      await Promise.resolve();
    });

    expect(screen.getByText('Unlock 101')).toBeInTheDocument();
    expect(screen.queryByText('Unlock 4')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more recipes/i })).not.toBeInTheDocument();
  });

  it('replaces accumulated items when navigation supplies a new result page', async () => {
    const { rerender } = renderMarketplace(createPage(3, true));

    rerender(
      <MarketplaceBrowser
        initialPage={createPage(3, false, 100, 3)}
        initialFilters={{ ...INITIAL_FILTERS, q: 'new query' }}
        sourceToolOptions={[]}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Unlock 101')).toBeInTheDocument();
    });
    expect(screen.getByText('Unlock 103')).toBeInTheDocument();
    expect(screen.queryByText('Unlock 1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more recipes/i })).not.toBeInTheDocument();
  });

  // The shell draws the first page until this list takes it over (Load more,
  // or a scroll down to it). Both draw `MarketplaceRecipeTile`, so the hand-off
  // moves nothing on screen, a video's poster included, and each tile opens
  // the same address from either list.
  it('draws the same tiles as the first-paint shell it replaces', () => {
    const page = createPage(3, false);
    page.items[1] = {
      ...page.items[1],
      accessMode: 'paid',
      priceUsdCents: 900,
      priceQuote: { currency: 'INR', amountSubunits: 75000, formatted: '₹750', note: null },
      post: createImagePost('post-2'),
    };
    page.items[2] = {
      ...page.items[2],
      post: {
        ...createImagePost('post-3'),
        title: 'Video post',
        category: 'video',
        mediaUrl: 'https://example.com/clip.mp4',
        mediaPreviewUrl: 'https://example.com/uploads/clip-poster.jpg',
        mediaRenditionUrl: 'https://example.com/clip.rendition.mp4',
        mediaKind: 'video',
      },
    };

    const shell = render(
      <MarketplaceBootstrap
        initialPage={page}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );
    const shellTiles = drawnTiles(shell.container);
    shell.unmount();

    const list = renderMarketplace(page);
    expect(shellTiles).toHaveLength(3);
    expect(shellTiles[2]).toContain('<video');
    expect(drawnTiles(list.container)).toEqual(shellTiles);
  });
});

// Back from a recipe drew the first four recipes alone (owner's report, 2026-11-15): opening a
// recipe unmounts the listing, so what "Load more" brought lived in its state only. The listing now
// keeps it for the tab and draws it again from its first render (marketplace-pages-memory; the
// shell hands such a listing over at once, marketplace-bootstrap's).
describe('MarketplaceBrowser drawn again after a recipe', () => {
  beforeEach(() => {
    pushMock.mockReset();
    authState.session = null;
    authState.user = null;
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  async function loadSecondPage() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(createPage(12, false, 4, 12))));
    vi.stubGlobal('fetch', fetchMock);
    const listing = renderMarketplace(createPage(4, true, 0, 4));
    fireEvent.click(screen.getByRole('button', { name: 'Load more recipes' }));
    expect(await screen.findByText('Unlock 16')).toBeInTheDocument();
    return { listing, fetchMock };
  }

  const drawnTitles = () => screen.getAllByRole('link', { name: /: Unlock \w+$/ })
    .map((link) => link.getAttribute('aria-label')?.replace(/^.*: /, ''));

  it('draws the recipes "Load more" brought in its first render, and asks for none of them again', async () => {
    const { listing, fetchMock } = await loadSecondPage();
    listing.unmount();
    fetchMock.mockClear();

    renderMarketplace(createPage(4, true, 0, 4));

    expect(screen.getByText('Unlock 16')).toBeInTheDocument();
    expect(drawnTitles()).toHaveLength(16);
    expect(screen.queryByRole('button', { name: 'Load more recipes' })).not.toBeInTheDocument();
    await act(async () => Promise.resolve());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('puts a first page that has moved in front of the recipes kept, each once and in order', async () => {
    const { listing } = await loadSecondPage();
    listing.unmount();

    // A recipe published since: the listing's first page starts with it.
    const moved = createPage(4, true, 0, 4);
    moved.items = [{ ...createMarketplaceItem(99), title: 'Unlock new' }, ...moved.items.slice(0, 3)];
    renderMarketplace(moved);

    expect(drawnTitles()).toEqual(['Unlock new', ...Array.from({ length: 16 }, (_, index) => `Unlock ${index + 1}`)]);
  });

  // Back to a filtered listing: its first page is read in the browser, and meanwhile the listing
  // as the reader left it is drawn, not the loading state, so the page keeps its height.
  it("draws what was kept, not the loading state, while the listing's first page is read", async () => {
    const { listing } = await loadSecondPage();
    listing.unmount();

    render(
      <MarketplaceBrowser
        initialPage={{ items: [], pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 4 } }}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
        listingStatus="loading"
      />
    );

    expect(drawnTitles()).toHaveLength(16);
  });

  it('keeps a listing apart for each viewer, whose blocks it leaves out', async () => {
    const { listing } = await loadSecondPage();
    listing.unmount();

    authState.session = { access_token: 'token-1' };
    authState.user = { id: 'viewer-1' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
    renderMarketplace(createPage(4, true, 0, 4));

    expect(screen.queryByText('Unlock 16')).not.toBeInTheDocument();
  });

  // Review of #815: the session arriving after a full load started the listing again, which cut
  // the Load more under way short and put back the search being typed.
  it('goes on with a Load more, and the search being typed, when the session arrives', async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      answer = resolve;
    })));
    const page = createPage(4, true, 0, 4);
    const view = renderMarketplace(page);
    fireEvent.click(screen.getByRole('button', { name: 'Load more recipes' }));
    const search = screen.getByPlaceholderText('Search prompts, tools, creators');
    fireEvent.change(search, { target: { value: 'cats' } });

    authState.session = { access_token: 'token-1' };
    authState.user = { id: 'viewer-1' };
    view.rerender(
      <MarketplaceBrowser initialPage={page} initialFilters={INITIAL_FILTERS} sourceToolOptions={[]} />
    );
    await act(async () => {
      answer(new Response(JSON.stringify(createPage(12, false, 4, 12))));
    });

    expect(await screen.findByText('Unlock 16')).toBeInTheDocument();
    expect(search).toHaveValue('cats');
  });

  // Back to a listing a signed-in reader left: the page's auth provider, mounted again, asks who is
  // signed in, and meanwhile draws what was kept for the account the session cookie names (owner's
  // recording, 2026-11-16). Review of #835: what may happen before the answer comes.
  describe('for the reader the session cookie names, while the page asks who is signed in', () => {
    const SESSION_COOKIE = 'sb-project-auth-token';
    const signedIn = { session: { access_token: 'token-1' }, user: { id: 'viewer-1' } };

    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
      const cookieSession = btoa(JSON.stringify({ access_token: 'token-1', user: { id: 'viewer-1' } }))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      document.cookie = `${SESSION_COOKIE}=base64-${cookieSession}; Path=/`;
    });

    afterEach(() => {
      document.cookie = `${SESSION_COOKIE}=; Max-Age=0; Path=/`;
      vi.unstubAllEnvs();
      authState.isLoading = false;
    });

    /** Signed in, Load more brought a second page, with more after it; then the reader left. */
    async function leftSignedIn() {
      Object.assign(authState, signedIn, { isLoading: false });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(createPage(12, true, 4, 12)))));
      const listing = renderMarketplace(createPage(4, true, 0, 4));
      fireEvent.click(screen.getByRole('button', { name: 'Load more recipes' }));
      expect(await screen.findByText('Unlock 16')).toBeInTheDocument();
      listing.unmount();
      // Back: nobody is known yet, the cookie names the reader.
      Object.assign(authState, { session: null, user: null, isLoading: true });
    }

    it('holds Load more until the session comes, then asks for the next page as theirs and keeps it', async () => {
      await leftSignedIn();
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(createPage(12, false, 16, 12))));
      vi.stubGlobal('fetch', fetchMock);
      const view = renderMarketplace(createPage(4, true, 0, 4));

      expect(drawnTitles()).toHaveLength(16);
      const loadMore = screen.getByRole('button', { name: 'Load more recipes' });
      expect(loadMore).toBeDisabled();
      fireEvent.click(loadMore);
      await act(async () => Promise.resolve());
      expect(fetchMock).not.toHaveBeenCalled();

      // The session comes, then the reader's own first page.
      Object.assign(authState, signedIn, { isLoading: false });
      view.rerender(
        <MarketplaceBrowser initialPage={createPage(4, true, 0, 4)} initialFilters={INITIAL_FILTERS} sourceToolOptions={[]} />
      );
      expect(drawnTitles()).toHaveLength(16);
      fireEvent.click(screen.getByRole('button', { name: 'Load more recipes' }));
      expect(await screen.findByText('Unlock 28')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/marketplace/resources?offset=16&limit=12',
        expect.objectContaining({ headers: { Accept: 'application/json', Authorization: 'Bearer token-1' } }),
      );

      // Kept as theirs: Back again draws all of it.
      view.unmount();
      renderMarketplace(createPage(4, true, 0, 4));
      expect(drawnTitles()).toHaveLength(28);
    });

    it('draws the listing again as a visitor\'s when nobody turns out to be signed in', async () => {
      await leftSignedIn();
      // What a visitor's Load more brings: two recipes the reader's blocks had left out.
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(createPage(2, false, 100, 12)))));
      const page = createPage(4, true, 0, 4);
      const view = renderMarketplace(page);
      expect(drawnTitles()).toHaveLength(16);

      // The session had ended elsewhere: nobody is signed in, and the visitor's first page has not
      // come (or could not be read).
      Object.assign(authState, { session: null, user: null, isLoading: false });
      view.rerender(<MarketplaceBrowser initialPage={page} initialFilters={INITIAL_FILTERS} sourceToolOptions={[]} />);

      expect(drawnTitles()).toEqual(['Unlock 1', 'Unlock 2', 'Unlock 3', 'Unlock 4']);
      // Load more goes on as the visitor's, and keeps nothing of the reader's under the visitor.
      fireEvent.click(screen.getByRole('button', { name: 'Load more recipes' }));
      expect(await screen.findByText('Unlock 102')).toBeInTheDocument();
      const visitorsListing = ['Unlock 1', 'Unlock 2', 'Unlock 3', 'Unlock 4', 'Unlock 101', 'Unlock 102'];
      expect(drawnTitles()).toEqual(visitorsListing);
      view.unmount();
      renderMarketplace(createPage(4, true, 0, 4));
      expect(drawnTitles()).toEqual(visitorsListing);
    });
  });
});

// Live sweep, 2026-11-17: the first-paint shell's "Load more recipes" only brought this list in,
// which drew the same four recipes, so a second press was needed. The shell now hands its press over
// (`loadMoreOnOpen`, the listing it was pressed on), and the list asks for the next page itself: once,
// as soon as it can read on (marketplace-bootstrap's cases hand it; marketplace-keeps-place.spec.ts
// presses it in a browser).
describe('MarketplaceBrowser opened by the shell\'s Load more', () => {
  const pressedOn = marketplaceFiltersKey(INITIAL_FILTERS);

  beforeEach(() => {
    authState.session = null;
    authState.user = null;
    authState.isLoading = false;
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  const listRequests = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.startsWith('/api/marketplace/resources'));

  it('asks for the next page once, in the development double render too, and reads as loading meanwhile', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      answer = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <StrictMode>
        <MarketplaceBrowser
          initialPage={createPage(4, true, 0, 4)}
          initialFilters={INITIAL_FILTERS}
          sourceToolOptions={[]}
          loadMoreOnOpen={pressedOn}
        />
      </StrictMode>
    );

    expect(screen.getByRole('button', { name: 'Loading' })).toBeDisabled();
    await waitFor(() => expect(listRequests(fetchMock)).toEqual(['/api/marketplace/resources?offset=4&limit=12']));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal?.aborted).toBe(false);

    await act(async () => {
      answer(new Response(JSON.stringify(createPage(12, true, 4, 12))));
    });

    expect(await screen.findByText('Unlock 16')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /: Unlock \d+$/ })).toHaveLength(16);
    // The press is spent: the button asks for the page after, and only when pressed.
    expect(screen.getByRole('button', { name: 'Load more recipes' })).toBeEnabled();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(listRequests(fetchMock)).toHaveLength(1);
  });

  // Signed in, the page reads the listing's first page again for the reader. That read landing
  // starts this list again, which cut a page asked for before it short: the press waits for it.
  it("waits for the listing's own first page, then asks once from where it ends", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(createPage(12, false, 4, 12))));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(
      <MarketplaceBrowser
        initialPage={createPage(4, true, 0, 4)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
        listingSettled={false}
        loadMoreOnOpen={pressedOn}
      />
    );

    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(listRequests(fetchMock)).toEqual([]);
    expect(screen.getByRole('button', { name: 'Loading' })).toBeDisabled();

    // The reader's own first page lands.
    view.rerender(
      <MarketplaceBrowser
        initialPage={createPage(4, true, 0, 4)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
        listingSettled
        loadMoreOnOpen={pressedOn}
      />
    );

    expect(await screen.findByText('Unlock 16')).toBeInTheDocument();
    expect(listRequests(fetchMock)).toEqual(['/api/marketplace/resources?offset=4&limit=12']);
    expect(screen.queryByRole('button', { name: /Load more recipes|Loading/ })).not.toBeInTheDocument();
  });

  it("holds the press for a signed-in reader until their session comes, and asks with it", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(createPage(12, false, 4, 12))));
    vi.stubGlobal('fetch', fetchMock);
    const SESSION_COOKIE = 'sb-project-auth-token';
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    const cookieSession = btoa(JSON.stringify({ access_token: 'token-1', user: { id: 'viewer-1' } }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    document.cookie = `${SESSION_COOKIE}=base64-${cookieSession}; Path=/`;
    try {
      Object.assign(authState, { session: null, user: null, isLoading: true });
      const page = createPage(4, true, 0, 4);
      const view = render(
        <MarketplaceBrowser initialPage={page} initialFilters={INITIAL_FILTERS} sourceToolOptions={[]} loadMoreOnOpen={pressedOn} />
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
      expect(listRequests(fetchMock)).toEqual([]);

      Object.assign(authState, { session: { access_token: 'token-1' }, user: { id: 'viewer-1' }, isLoading: false });
      view.rerender(
        <MarketplaceBrowser initialPage={page} initialFilters={INITIAL_FILTERS} sourceToolOptions={[]} loadMoreOnOpen={pressedOn} />
      );

      expect(await screen.findByText('Unlock 16')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/marketplace/resources?offset=4&limit=12',
        expect.objectContaining({ headers: { Accept: 'application/json', Authorization: 'Bearer token-1' } }),
      );
    } finally {
      document.cookie = `${SESSION_COOKIE}=; Max-Age=0; Path=/`;
      vi.unstubAllEnvs();
    }
  });

  it('carries out a press for this listing only', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(createPage(12, false, 4, 12))));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MarketplaceBrowser
        initialPage={createPage(4, true, 0, 4)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
        loadMoreOnOpen={marketplaceFiltersKey({ ...INITIAL_FILTERS, access: 'paid' })}
      />
    );

    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Load more recipes' })).toBeEnabled();
  });

  it('says a failed page, and offers the button again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Could not load more recipes.' }), { status: 503 })));
    render(
      <MarketplaceBrowser
        initialPage={createPage(4, true, 0, 4)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
        loadMoreOnOpen={pressedOn}
      />
    );

    expect(await screen.findByText('Could not load more recipes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more recipes' })).toBeEnabled();
  });

  // The shell keeps the filters behind Filters below 1024px; the list keeps them as the reader left
  // them there, and as they have them when the listing's own first page lands, until a filter is picked.
  it('keeps the filters as handed over, until another listing is picked', () => {
    const onNavigate = vi.fn();
    const view = render(
      <MarketplaceBrowser
        initialPage={createPage(4, true, 0, 4)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
        initialFiltersOpen
        onNavigate={onNavigate}
      />
    );
    const filters = screen.getByRole('button', { name: 'Filters' });
    const panel = document.getElementById(filters.getAttribute('aria-controls') ?? '');
    expect(filters).toHaveAttribute('aria-expanded', 'true');
    expect(panel).toHaveClass('block');

    // The same listing read again: left open.
    view.rerender(
      <MarketplaceBrowser
        initialPage={createPage(4, true, 0, 4)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
        initialFiltersOpen
        onNavigate={onNavigate}
      />
    );
    expect(filters).toHaveAttribute('aria-expanded', 'true');

    // Another listing: folded.
    view.rerender(
      <MarketplaceBrowser
        initialPage={createPage(2, false, 0, 4)}
        initialFilters={{ ...INITIAL_FILTERS, access: 'paid' }}
        sourceToolOptions={[]}
        initialFiltersOpen
        onNavigate={onNavigate}
      />
    );
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveClass('hidden');
  });
});

function drawnTiles(container: HTMLElement) {
  const grid = container.querySelector('a[aria-label^="View"], a[aria-label^="Unlock for"]')?.parentElement;
  return Array.from(grid?.children ?? [], (tile) => tile.outerHTML);
}

function createImagePost(id: string): NonNullable<MarketplaceResourceListItem['post']> {
  return {
    id,
    generationId: null,
    title: 'Image post',
    category: 'image',
    body: '',
    postFormat: 'media',
    visibility: 'public',
    archivedAt: null,
    tombstoned: false,
    reviewStatus: 'visible',
    sourceKind: 'magicbooklet',
    sourceTool: 'Kling 3.0',
    sourceToolSlug: 'kling',
    mediaUrl: 'https://example.com/image.jpg',
    mediaPreviewUrl: null,
    mediaRenditionUrl: null,
    mediaKind: 'image',
    saveCount: 0,
    remixCount: 0,
    shareVisitCount: 0,
  };
}

function renderMarketplace(initialPage: ReturnType<typeof createPage>) {
  return render(
    <MarketplaceBrowser
      initialPage={initialPage}
      initialFilters={INITIAL_FILTERS}
      sourceToolOptions={[]}
    />
  );
}

function createPage(count: number, hasMore: boolean, startAt = 0, limit = 3) {
  return {
    items: Array.from({ length: count }, (_, index) => createMarketplaceItem(startAt + index + 1)),
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? startAt + count : null,
      offset: startAt,
      limit,
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
