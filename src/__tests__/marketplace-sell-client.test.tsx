import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The payout panel on this page reads the browser Supabase singleton, which
// needs real env vars to construct. The dashboard assertions below are about
// bundle rendering, so stub the client rather than the whole panel.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
  },
}));

vi.stubGlobal('fetch', vi.fn(async () => new Response(
  JSON.stringify({
    availableUsd: '$0.00',
    minimumUsd: '$100.00',
    canRequest: false,
    pendingRequest: null,
    history: [],
  }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
)));

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
    expect(screen.getByText(/live and draft recipes/i)).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText(/20 visits/i)).toBeInTheDocument();
    expect(within(screen.getByText('Launch resources').parentElement!).getByText('₹1,599')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /share a post/i })).toHaveAttribute(
      'href',
      '/post/new?from=seller&returnTo=%2Fmarketplace%2Fsell'
    );
    expect(screen.getByRole('button', { name: /copy recipe link/i })).toBeInTheDocument();
  });

  // The listing's chip printed "$0.50 recipe" for a recipe only credits buy.
  it('labels a credits-only listing in credits', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          bundles: [{
            ...dashboard.bundles[0],
            priceUsdCents: 50,
            priceQuote: { currency: 'USD', amountSubunits: 50, formatted: '$0.50', note: null },
          }],
        }}
      />
    );

    expect(within(screen.getByText('Launch resources').parentElement!).getByText('50 credits')).toBeInTheDocument();
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

    expect(screen.getByText(/no recipes yet/i)).toBeInTheDocument();
    expect(screen.getByText(/start in the post flow/i)).toBeInTheDocument();
  });

  // The edit links carried no way back, so the editor's back link went to the
  // studio instead of this page.
  it('opens the editor with the way back to this page', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          bundles: [{
            ...dashboard.bundles[0],
            post: { ...dashboard.bundles[0].post, visibility: 'private' },
          }],
        }}
      />
    );

    expect(screen.getByRole('link', { name: /open editor/i })).toHaveAttribute(
      'href',
      '/post/post-public/edit?from=seller&returnTo=%2Fmarketplace%2Fsell'
    );
    expect(screen.getByRole('link', { name: /edit recipe/i })).toHaveAttribute(
      'href',
      '/post/post-public/edit?from=seller&returnTo=%2Fmarketplace%2Fsell#recipe'
    );
  });

  // Only deleted posts showed what they had earned; a live listing showed a count.
  it("shows what each paid listing has earned, and leaves a free listing's count alone", () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          bundles: [
            dashboard.bundles[0],
            {
              ...dashboard.bundles[0],
              id: 'bundle-free',
              postId: 'post-free',
              title: 'Free starter notes',
              accessMode: 'free' as const,
              priceUsdCents: 0,
              salesCount: 3,
              earningsUsdCents: 0,
              post: { ...dashboard.bundles[0].post, id: 'post-free', title: 'Free proof' },
            },
          ],
        }}
      />
    );

    expect(screen.getByText('4 sold · $76.00 tracked earnings')).toBeInTheDocument();
    expect(screen.getByText('3 opened')).toBeInTheDocument();
  });

  // A post deleted after a sale is private and archived for its buyers. It read
  // "Needs work · Archived post", asked the seller to publish it again, and
  // offered the editor.
  it('labels a post deleted after a sale and offers no edit', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          bundles: [{
            ...dashboard.bundles[0],
            quality: {
              eligible: false,
              issues: [{
                code: 'post_not_public',
                field: 'post',
                message: 'Publish a visible public post before listing this recipe in the marketplace.',
              }],
            },
            post: {
              ...dashboard.bundles[0].post,
              visibility: 'private',
              archivedAt: '2026-10-10T00:00:00.000Z',
              tombstoned: true,
            },
          }],
        }}
      />
    );

    expect(screen.getByText('Deleted · buyers keep access')).toBeInTheDocument();
    expect(screen.getByText('This post was deleted. Buyers keep their copy.')).toBeInTheDocument();
    expect(screen.getByText('4 sold · $76.00 tracked earnings')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open editor/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /edit recipe/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Archived post')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs work')).not.toBeInTheDocument();
    expect(screen.queryByText(/publish a visible public post/i)).not.toBeInTheDocument();
  });

  // The server renders in UTC and the seller's browser hydrates in its own
  // zone: `toLocaleString()` printed another day there, and React threw the
  // server's markup away.
  it("hydrates the sale and deletion times without a mismatch, then shows them in the seller's zone", async () => {
    const soldAt = '2026-10-14T20:00:00.000Z';
    const history = {
      ...dashboard,
      generatedAt: '2026-10-15T00:00:00.000Z',
      sales: [{
        id: 'sale-1',
        bundleId: 'bundle-1',
        bundleTitle: 'Launch resources',
        buyerLabel: '@buyer',
        amountSubunits: 41550,
        currency: 'INR' as const,
        createdAt: soldAt,
      }],
      deletedSnapshots: [{
        id: 'audit-1',
        title: 'Old drop',
        visibility: 'public',
        bundleAccessMode: 'paid' as const,
        bundleStatus: 'published' as const,
        bundlePriceUsdCents: 900,
        resourceKinds: ['prompt'] as Array<'prompt' | 'workflow' | 'files' | 'notes' | 'remix'>,
        salesCount: 2,
        earningsUsdCents: 1530,
        hadPaidOrders: true,
        deletedAt: soldAt,
      }],
    };
    const serverTimeZone = process.env.TZ;
    const container = document.createElement('div');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let root: ReturnType<typeof hydrateRoot> | null = null;

    try {
      process.env.TZ = 'UTC';
      container.innerHTML = renderToString(<MarketplaceSellClient initialDashboard={history} />);
      document.body.appendChild(container);
      expect(container).toHaveTextContent('@buyer · Oct 14, 2026, 8:00 PM UTC');
      expect(container).toHaveTextContent('₹415.50 unlocked');

      process.env.TZ = 'Asia/Kolkata';
      const sellerTime = new Date(soldAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      const recoverableErrors: unknown[] = [];
      await act(async () => {
        root = hydrateRoot(
          container,
          <MarketplaceSellClient initialDashboard={history} />,
          { onRecoverableError: (error) => recoverableErrors.push(error) },
        );
      });

      expect(recoverableErrors).toEqual([]);
      expect(within(container).getByText(/^@buyer ·/)).toHaveTextContent(`@buyer · ${sellerTime}`);
      const times = Array.from(container.querySelectorAll('time'));
      expect(times.map((time) => [time.getAttribute('datetime'), time.textContent])).toEqual([
        [soldAt, sellerTime],
        [soldAt, sellerTime],
      ]);
      expect(sellerTime).toContain('Oct 15, 2026');
      expect(container).toHaveTextContent('₹415.50 unlocked');
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
      consoleError.mockRestore();
      if (serverTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = serverTimeZone;
      }
    }
  });
});
