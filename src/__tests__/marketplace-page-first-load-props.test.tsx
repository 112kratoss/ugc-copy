import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MarketplacePage from '@/app/marketplace/page';

const marketplaceBootstrapPropsMock = vi.hoisted(() => vi.fn());
const sourceToolCatalog = vi.hoisted(() => [
  {
    slug: 'runway',
    label: 'Runway',
    models: [{ slug: 'gen-4', label: 'Gen-4', capabilities: ['video'], status: 'current', aliases: [] }],
    supportedMediaKinds: ['image', 'video'],
    toolType: 'platform',
    capabilities: ['image', 'video'],
    catalogTier: 'featured',
    status: 'current',
    providerSlug: 'runway',
    aliases: ['Runway ML'],
  },
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
]);

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getMarketplaceResourceList: async () => ({ items: [] }),
}));

vi.mock('@/lib/source-tools-server', () => ({
  listSourceToolsCatalog: () => Promise.resolve(sourceToolCatalog),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: async () => ({ session: null, credits: null }),
}));

vi.mock('@/lib/marketplace-viewer-filter', () => ({
  filterMarketplaceItemsForViewer: async (items: unknown[]) => items,
}));

vi.mock('@/app/marketplace/MarketplaceBootstrap', () => ({
  default: (props: unknown) => {
    marketplaceBootstrapPropsMock(props);
    return <div data-testid="marketplace-bootstrap" />;
  },
}));

describe('MarketplacePage first load', () => {
  // A client component's props are written into the flight data of every
  // first load; the tool filters draw each tool's label and link its slug.
  it('hands the client each tool filter’s slug and label alone', async () => {
    await act(async () => {
      render(MarketplacePage({ searchParams: Promise.resolve({}) }));
    });

    expect(await screen.findByTestId('marketplace-bootstrap')).toBeInTheDocument();
    expect(marketplaceBootstrapPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceToolOptions: [
        { slug: 'runway', label: 'Runway' },
        { slug: 'magicbooklet', label: 'magicbooklet' },
      ],
    }));
  });
});
