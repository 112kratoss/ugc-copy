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
      status: 'published' as const,
      priceUsdCents: 1900,
      salesCount: 4,
      earningsUsdCents: 7600,
      priceQuote: {
        currency: 'INR' as const,
        amountSubunits: 159900,
        formatted: '₹1,599',
        note: 'Charged in INR for buyers in India.',
      },
      resourceKinds: ['prompt', 'notes'] as Array<'prompt' | 'workflow' | 'files' | 'notes' | 'remix'>,
      createdAt: '2026-04-06T00:00:00.000Z',
      updatedAt: '2026-04-07T00:00:00.000Z',
      quality: {
        eligible: true,
        issues: [],
      },
      post: {
        id: 'post-public',
        title: 'Launch proof',
        visibility: 'public',
        archivedAt: null,
        saveCount: 3,
        remixCount: 1,
        shareVisitCount: 20,
      },
    },
  ],
  deletedSnapshots: [],
  sales: [],
  totalSalesCount: 4,
  totalEarningsUsdCents: 7600,
};

describe('MarketplaceSellClient', () => {
  it('shows a seller unlock dashboard', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={dashboard}
      />
    );

    expect(screen.getByText(/seller dashboard/i)).toBeInTheDocument();
    expect(screen.getByText(/live and draft unlocks/i)).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText(/20 visits/i)).toBeInTheDocument();
    expect(screen.getByText(/₹1,599 unlock/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /share a post/i })).toHaveAttribute('href', '/post/new');
    expect(screen.getByRole('button', { name: /copy unlock link/i })).toBeInTheDocument();
  });

  it('shows the empty-state guidance when no bundles exist', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          bundles: [],
          deletedSnapshots: [],
          sales: [],
          totalSalesCount: 0,
          totalEarningsUsdCents: 0,
        }}
      />
    );

    expect(screen.getByText(/no unlocks yet/i)).toBeInTheDocument();
    expect(screen.getByText(/start in the post flow/i)).toBeInTheDocument();
  });
});
