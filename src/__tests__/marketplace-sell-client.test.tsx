import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import MarketplaceSellClient from '@/app/marketplace/sell/MarketplaceSellClient';

const dashboard = {
  bundles: [
    {
      id: 'bundle-1',
      postId: 'post-public',
      title: 'Launch resources',
      summary: 'Reusable launch notes.',
      previewText: 'See the exact structure.',
      accessMode: 'paid' as const,
      priceUsdCents: 1900,
      salesCount: 4,
      earningsUsdCents: 7600,
      resourceKinds: ['prompt', 'notes'] as const,
      createdAt: '2026-04-06T00:00:00.000Z',
      post: {
        id: 'post-public',
        title: 'Launch proof',
        visibility: 'public',
      },
    },
  ],
  sales: [],
  totalSalesCount: 4,
  totalEarningsUsdCents: 7600,
};

describe('MarketplaceSellClient', () => {
  it('shows a manage-only resource dashboard', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={dashboard}
      />
    );

    expect(screen.getByText(/resource dashboard/i)).toBeInTheDocument();
    expect(screen.getByText(/live and draft resources/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open post composer/i })).toHaveAttribute('href', '/post/new');
    expect(screen.getByRole('button', { name: /copy post link/i })).toBeInTheDocument();
  });

  it('shows the empty-state guidance when no bundles exist', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          bundles: [],
          sales: [],
          totalSalesCount: 0,
          totalEarningsUsdCents: 0,
        }}
      />
    );

    expect(screen.getByText(/no attached resources yet/i)).toBeInTheDocument();
    expect(screen.getByText(/start in the post flow/i)).toBeInTheDocument();
  });
});
