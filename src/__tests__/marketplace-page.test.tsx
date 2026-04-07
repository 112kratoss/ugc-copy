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
    expect(screen.getAllByRole('link', { name: /open post composer/i })[0]).toHaveAttribute('href', '/post/new');
    expect(screen.queryByRole('link', { name: /create a listing/i })).not.toBeInTheDocument();
  });
});
