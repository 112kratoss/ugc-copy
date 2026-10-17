import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MarketplacePage, { revalidate } from '@/app/marketplace/page';

const getMarketplaceResourceListMock = vi.fn();
const headersMock = vi.fn();
const getServerAuthStateMock = vi.fn();
const filterMarketplaceItemsForViewerMock = vi.fn();
const sourceToolCatalog = vi.hoisted(() => [
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
  { slug: 'runway', label: 'Runway', models: [], supportedMediaKinds: ['image', 'video'] },
]);

vi.mock('next/headers', () => ({
  headers: () => headersMock(),
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getMarketplaceResourceList: (...args: unknown[]) => getMarketplaceResourceListMock(...args),
}));

vi.mock('@/lib/source-tools-server', () => ({
  listSourceToolsCatalog: () => Promise.resolve(sourceToolCatalog),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

vi.mock('@/lib/marketplace-viewer-filter', () => ({
  filterMarketplaceItemsForViewer: (...args: unknown[]) => filterMarketplaceItemsForViewerMock(...args),
}));

function requestHeaders(country: string | null) {
  return { get: vi.fn((name: string) => (name === 'x-vercel-ip-country' ? country : null)) };
}

describe('MarketplacePage', () => {
  beforeEach(() => {
    headersMock.mockReset();
    getMarketplaceResourceListMock.mockReset();
    getServerAuthStateMock.mockReset();
    getServerAuthStateMock.mockResolvedValue({ session: null, credits: null });
    filterMarketplaceItemsForViewerMock.mockReset();
    filterMarketplaceItemsForViewerMock.mockImplementation(async (items: unknown[]) => items);
  });

  // The first page was quoted in USD for everyone while "Load more" and the
  // post a card opens were quoted in the visitor's currency.
  it("quotes the first page in the visitor's country, as every later page is", async () => {
    headersMock.mockResolvedValue(requestHeaders('IN'));
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [],
    });

    await act(async () => {
      render(MarketplacePage({
        searchParams: Promise.resolve({}),
      }));
    });

    expect(revalidate).toBe(60);
    expect(getMarketplaceResourceListMock).toHaveBeenCalledWith(expect.objectContaining({
      countryCode: 'IN',
      limit: 3,
      offset: 0,
    }));
    expect(screen.getByRole('heading', {
      name: /buy the reusable parts behind community posts/i,
    })).toBeInTheDocument();
  });

  // The storefront was the one list that kept showing a creator the viewer
  // blocked, or who blocked them; each card then opened a 404.
  it("takes a signed-in viewer's blocked creators off the first page, and no one's for a visitor", async () => {
    headersMock.mockResolvedValue(requestHeaders(null));
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [
        createMarketplaceResourceItem({ id: 'bundle-kept', title: 'Kept recipe', post: null }),
        createMarketplaceResourceItem({
          id: 'bundle-blocked',
          postId: 'post-blocked',
          title: 'Blocked recipe',
          post: null,
          seller: { id: 'creator-blocked', username: 'blocked', name: 'Blocked', avatar: null },
        }),
      ],
      pageInfo: { hasMore: true, nextOffset: 3, offset: 0, limit: 3 },
    });
    filterMarketplaceItemsForViewerMock.mockImplementation(async (
      items: Array<{ seller: { id: string } }>,
      viewerUserId: string | null,
    ) => (viewerUserId ? items.filter((item) => item.seller.id !== 'creator-blocked') : items));
    getServerAuthStateMock.mockResolvedValue({ session: { user: { id: 'viewer-1' } }, credits: 10 });

    let unmount!: () => void;
    await act(async () => {
      ({ unmount } = render(MarketplacePage({
        searchParams: Promise.resolve({}),
      })));
    });

    expect(filterMarketplaceItemsForViewerMock).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'bundle-kept' }), expect.objectContaining({ id: 'bundle-blocked' })],
      'viewer-1',
    );
    expect(await screen.findByText('Kept recipe')).toBeInTheDocument();
    expect(screen.queryByText('Blocked recipe')).not.toBeInTheDocument();
    // The next page still starts where the unfiltered one ended.
    expect(screen.getByRole('button', { name: /load more recipes/i })).toBeInTheDocument();
    unmount();

    getServerAuthStateMock.mockResolvedValue({ session: null, credits: null });
    await act(async () => {
      render(MarketplacePage({
        searchParams: Promise.resolve({}),
      }));
    });

    expect(filterMarketplaceItemsForViewerMock).toHaveBeenLastCalledWith(expect.any(Array), null);
    expect(await screen.findByText('Blocked recipe')).toBeInTheDocument();
  });

  // A one- or two-character query was dropped without a word: every recipe
  // was listed and the search box emptied.
  it('answers a query under three characters with the hint, keeps it in the box, and lists nothing', async () => {
    headersMock.mockResolvedValue(requestHeaders(null));

    await act(async () => {
      render(MarketplacePage({
        searchParams: Promise.resolve({ q: 'ai', access: 'paid' }),
      }));
    });

    expect(await screen.findByRole('heading', { name: 'Type at least 3 characters' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /search marketplace recipes/i })).toHaveValue('ai');
    // Clearing the search keeps the other filters.
    expect(screen.getByRole('link', { name: 'Clear search' })).toHaveAttribute('href', '/marketplace?access=paid&sort=recent');
    expect(getMarketplaceResourceListMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'No recipes yet' })).not.toBeInTheDocument();
  });

  it('builds a valid recent sort link and keeps both empty-state entry points visible', async () => {
    headersMock.mockResolvedValue({
      get: vi.fn(() => null),
    });
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [],
    });

    await act(async () => {
      render(MarketplacePage({
        searchParams: Promise.resolve({}),
      }));
    });

    expect(await screen.findByRole('link', { name: /^recent$/i })).toHaveAttribute('href', '/marketplace?sort=recent');
    expect(screen.getAllByRole('link', { name: /share a post/i })[0]).toHaveAttribute(
      'href',
      '/post/new?from=marketplace&returnTo=%2Fmarketplace'
    );
    expect(screen.queryByRole('link', { name: /create a listing/i })).not.toBeInTheDocument();
  });

  it('renders text-only unlocks with note-style previews', async () => {
    headersMock.mockResolvedValue({
      get: vi.fn(() => null),
    });
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [
        {
          id: 'bundle-1',
          postId: 'post-1',
          legacyAssetId: null,
          title: 'Prompt pacing unlock',
          summary: '',
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
            itemPreviews: [{
              type: 'prompt',
              title: 'Prompt',
              role: 'primary',
              remixUse: 'none',
            }],
            hasPrompt: true,
            hasNotes: false,
            hasWorkflow: false,
            hasRemix: false,
            updatedAt: '2026-04-25T10:00:00.000Z',
          },
          createdAt: '2026-04-25T10:00:00.000Z',
          updatedAt: '2026-04-25T10:00:00.000Z',
          seller: {
            id: 'creator-1',
            username: 'creator-name',
            name: 'Creator Name',
            avatar: null,
          },
          post: {
            id: 'post-1',
            title: 'Prompt pacing tip',
            category: 'text',
            body: 'Lead with the product benefit before adding style language.',
            postFormat: 'text',
            visibility: 'public',
            archivedAt: null,
            sourceKind: 'manual',
            sourceTool: null,
            sourceToolSlug: null,
            mediaUrl: null,
            mediaKind: null,
          },
          priceQuote: {
            currency: 'USD',
            amountSubunits: 0,
            formatted: '$0.00',
            note: null,
          },
        },
      ],
    });

    await act(async () => {
      render(MarketplacePage({
        searchParams: Promise.resolve({}),
      }));
    });

    // A text post is labelled "Text", as on the post page (it read "Tip / note").
    expect(await screen.findByText('Text')).toBeInTheDocument();
    expect(screen.getAllByText('Prompt pacing tip')).toHaveLength(2);
    expect(screen.getByText('Lead with the product benefit before adding style language.')).toBeInTheDocument();
    expect(screen.getByText('Free recipe')).toBeInTheDocument();
    expect(screen.queryByText('Text-only attached post')).not.toBeInTheDocument();
  });

  it('renders lazy images without attaching video bytes before interaction', async () => {
    headersMock.mockResolvedValue({
      get: vi.fn(() => null),
    });
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [
        createMarketplaceResourceItem({
          id: 'image-bundle',
          title: 'Image unlock',
          post: {
            id: 'image-post',
            title: 'Image post',
            category: 'image',
            body: '',
            postFormat: 'media',
            visibility: 'public',
            archivedAt: null,
            sourceKind: 'magicbooklet',
            sourceTool: null,
            sourceToolSlug: null,
            mediaUrl: 'https://example.com/image.jpg',
            mediaKind: 'image',
          },
        }),
        createMarketplaceResourceItem({
          id: 'video-bundle',
          title: 'Video unlock',
          postId: 'video-post',
          post: {
            id: 'video-post',
            title: 'Video post',
            category: 'video',
            body: '',
            postFormat: 'media',
            visibility: 'public',
            archivedAt: null,
            sourceKind: 'magicbooklet',
            sourceTool: null,
            sourceToolSlug: null,
            mediaUrl: 'https://example.com/video.mp4',
            mediaKind: 'video',
          },
        }),
      ],
    });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(MarketplacePage({
        searchParams: Promise.resolve({}),
      })));
    });

    const image = await screen.findByRole('img', { name: 'Image post' });
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('decoding', 'async');

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video).not.toHaveAttribute('src');
    expect(video).toHaveAttribute('preload', 'none');
    expect(video).not.toHaveAttribute('autoplay');
  });
});

function createMarketplaceResourceItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bundle-1',
    postId: 'post-1',
    legacyAssetId: null,
    title: 'Prompt pacing unlock',
    summary: 'Prompt included.',
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
      itemPreviews: [{
        type: 'prompt',
        title: 'Prompt',
        role: 'primary',
        remixUse: 'none',
      }],
      hasPrompt: true,
      hasNotes: false,
      hasWorkflow: false,
      hasRemix: false,
      updatedAt: '2026-04-25T10:00:00.000Z',
    },
    createdAt: '2026-04-25T10:00:00.000Z',
    updatedAt: '2026-04-25T10:00:00.000Z',
    seller: {
      id: 'creator-1',
      username: 'creator-name',
      name: 'Creator Name',
      avatar: null,
    },
    post: {
      id: 'post-1',
      title: 'Prompt pacing tip',
      category: 'text',
      body: 'Lead with the product benefit before adding style language.',
      postFormat: 'text',
      visibility: 'public',
      archivedAt: null,
      sourceKind: 'manual',
      sourceTool: null,
      sourceToolSlug: null,
      mediaUrl: null,
      mediaKind: null,
    },
    priceQuote: {
      currency: 'USD',
      amountSubunits: 0,
      formatted: '$0.00',
      note: null,
    },
    ...overrides,
  };
}
