import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MarketplacePage from '@/app/marketplace/page';

const getMarketplaceResourceListMock = vi.fn();
const headersMock = vi.fn();

vi.mock('next/headers', () => ({
  headers: () => headersMock(),
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getMarketplaceResourceList: (...args: unknown[]) => getMarketplaceResourceListMock(...args),
}));

describe('MarketplacePage', () => {
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
});
