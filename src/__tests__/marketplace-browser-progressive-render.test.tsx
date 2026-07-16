import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MarketplaceBrowser from '@/app/marketplace/MarketplaceBrowser';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
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
    expect(markup).toContain('Load more unlocks');
    expect(markup).not.toContain('data-marketplace-bootstrap-sentinel');
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

    fireEvent.click(screen.getByRole('button', { name: /load more unlocks/i }));

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
    expect(screen.queryByRole('button', { name: /load more unlocks/i })).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: /load more unlocks/i }));
    await screen.findByText('Unlock 15');
    fireEvent.click(screen.getByRole('button', { name: /load more unlocks/i }));

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

    fireEvent.click(screen.getByRole('button', { name: /load more unlocks/i }));
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
    expect(screen.queryByRole('button', { name: /load more unlocks/i })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: /load more unlocks/i })).not.toBeInTheDocument();
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
