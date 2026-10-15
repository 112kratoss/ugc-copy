import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MarketplaceBrowser from '@/app/marketplace/MarketplaceBrowser';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

// One router for every render, so the browser's effects never see a new one.
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const pushMock = routerMock.push;

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

const authState = vi.hoisted(() => ({
  session: null as { access_token: string } | null,
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: authState.session }),
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
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serializes all three production bootstrap cards and exposes pagination', () => {
    const markup = renderToStaticMarkup(
      <MarketplaceBrowser
        initialPage={createPage(3, true, 0, 3)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    expect(markup).toContain('Unlock 1');
    expect(markup).toContain('Unlock 3');
    expect(markup).not.toContain('Unlock 4');
    expect(markup).toContain('Load more recipes');
    expect(markup).not.toContain('data-marketplace-bootstrap-sentinel');
  });

  // Same words as the bootstrap card it replaces: one figure on the badge,
  // every way to pay on the pill and the button, credits alone below the
  // cash minimum.
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
    expect(within(cashCard).getByText('₹750')).toBeInTheDocument();
    expect(within(cashCard).getByText('₹750 · 900 credits')).toBeInTheDocument();
    expect(within(cashCard).getByText('Unlock for ₹750 · 900 credits')).toBeInTheDocument();

    const creditsCard = screen.getByRole('link', { name: 'Unlock for 50 credits: Unlock 2' });
    expect(within(creditsCard).getAllByText('50 credits')).toHaveLength(2);
    expect(creditsCard).not.toHaveTextContent('$0.50');

    const freeCard = screen.getByRole('link', { name: 'View free recipe: Unlock 3' });
    expect(within(freeCard).getByText('Free recipe')).toBeInTheDocument();
    expect(within(freeCard).getByText('Free')).toBeInTheDocument();
    expect(freeCard).not.toHaveTextContent('$0.00');
  });

  it('continues a three-item bootstrap at offset three with the compact API page size', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      items: [
        createMarketplaceItem(3),
        createMarketplaceItem(4),
        createMarketplaceItem(4),
      ],
      pageInfo: {
        hasMore: false,
        nextOffset: null,
        offset: 3,
        limit: 12,
      },
    })));
    renderMarketplace(createPage(3, true, 0, 3));

    fireEvent.click(screen.getByRole('button', { name: /load more recipes/i }));

    await waitFor(() => {
      expect(screen.getByText('Unlock 4')).toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/marketplace/resources?offset=3&limit=12',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      })
    );
    expect(screen.getAllByText('Unlock 3')).toHaveLength(1);
    expect(screen.getAllByText('Unlock 4')).toHaveLength(1);
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
});

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
