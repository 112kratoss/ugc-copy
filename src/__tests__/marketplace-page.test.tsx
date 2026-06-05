import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MarketplacePage, { revalidate } from '@/app/marketplace/page';

const getMarketplaceResourceListMock = vi.fn();
const headersMock = vi.fn();

vi.mock('next/headers', () => ({
  headers: () => headersMock(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getMarketplaceResourceList: (...args: unknown[]) => getMarketplaceResourceListMock(...args),
}));

describe('MarketplacePage', () => {
  beforeEach(() => {
    headersMock.mockReset();
    getMarketplaceResourceListMock.mockReset();
  });

  it('renders as a cacheable anonymous marketplace page without reading request headers', async () => {
    headersMock.mockImplementation(() => {
      throw new Error('headers should not be read for the public marketplace page');
    });
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [],
    });

    render(await MarketplacePage({
      searchParams: Promise.resolve({}),
    }));

    expect(revalidate).toBe(60);
    expect(headersMock).not.toHaveBeenCalled();
    expect(getMarketplaceResourceListMock).toHaveBeenCalledWith(expect.objectContaining({
      countryCode: null,
    }));
    expect(screen.getByRole('heading', {
      name: /buy the reusable parts behind community posts/i,
    })).toBeInTheDocument();
  });

  it('builds a valid recent sort link and keeps both empty-state entry points visible', async () => {
    headersMock.mockResolvedValue({
      get: vi.fn(() => null),
    });
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [],
    });

    render(await MarketplacePage({
      searchParams: Promise.resolve({}),
    }));

    expect(screen.getByRole('link', { name: /^recent$/i })).toHaveAttribute('href', '/marketplace?sort=recent');
    expect(screen.getAllByRole('link', { name: /share a post/i })[0]).toHaveAttribute('href', '/post/new');
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

    render(await MarketplacePage({
      searchParams: Promise.resolve({}),
    }));

    expect(screen.getByText('Tip / note')).toBeInTheDocument();
    expect(screen.getByText('Prompt pacing tip')).toBeInTheDocument();
    expect(screen.getByText('Lead with the product benefit before adding style language.')).toBeInTheDocument();
    expect(screen.getByText('Free unlock')).toBeInTheDocument();
    expect(screen.queryByText('Text-only attached post')).not.toBeInTheDocument();
  });

  it('renders marketplace media previews with lazy image loading and metadata-only video loading', async () => {
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

    const { container } = render(await MarketplacePage({
      searchParams: Promise.resolve({}),
    }));

    const image = screen.getByRole('img', { name: 'Image post' });
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('decoding', 'async');

    const video = container.querySelector('video[src="https://example.com/video.mp4"]');
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('preload', 'metadata');
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
