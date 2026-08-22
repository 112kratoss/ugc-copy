import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MarketplaceBootstrap from '@/app/marketplace/MarketplaceBootstrap';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

const browserModuleLoaded = vi.hoisted(() => vi.fn());

vi.mock('@/app/marketplace/MarketplaceBrowser', () => {
  browserModuleLoaded();

  return {
    default: () => <div data-testid="interactive-marketplace-browser">Interactive marketplace browser</div>,
  };
});

const INITIAL_FILTERS = {
  access: 'all' as const,
  resource: 'all' as const,
  tool: '',
  sort: 'recent' as const,
  q: '',
};

describe('MarketplaceBootstrap', () => {
  it('constrains mobile filter rows so long tool lists cannot widen the page', () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(3, true)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[
          {
            label: 'A deliberately long source tool name',
            slug: 'long-source-tool',
            models: [],
            supportedMediaKinds: ['image'],
          },
        ]}
      />
    );

    for (const label of ['Access', 'Kind', 'Tool']) {
      expect(screen.getByText(label).parentElement).toHaveClass('min-w-0');
    }
  });

  beforeEach(() => {
    browserModuleLoaded.mockClear();
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('server-renders only the compact filter surface and first three cards', () => {
    const markup = renderToStaticMarkup(
      <MarketplaceBootstrap
        initialPage={createPage(4, true)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    expect(markup).toContain('data-marketplace-bootstrap-shell');
    expect(markup).toContain('Unlock 1');
    expect(markup).toContain('Unlock 3');
    expect(markup).not.toContain('Unlock 4');
    expect(markup).toContain('Load more recipes');
    expect(markup).not.toContain('Interactive marketplace browser');
    expect(browserModuleLoaded).not.toHaveBeenCalled();
  });

  it('resizes an original image when no generated preview is available', () => {
    const page = createPage(1, false);
    page.items[0].post = {
      id: 'post-1',
      generationId: null,
      title: 'Large source image',
      category: 'image',
      body: '',
      postFormat: 'media',
      visibility: 'public',
      archivedAt: null,
      tombstoned: false,
      reviewStatus: 'visible',
      sourceKind: 'magicbooklet',
      sourceTool: null,
      sourceToolSlug: null,
      mediaUrl: '/large-source.png',
      mediaPreviewUrl: null,
      mediaRenditionUrl: null,
      mediaKind: 'image',
      saveCount: 0,
      remixCount: 0,
      shareVisitCount: 0,
    };

    render(
      <MarketplaceBootstrap
        initialPage={page}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    const image = screen.getByRole('img', { name: 'Large source image' });
    const renderedUrl = new URL(image.getAttribute('src') ?? '', 'http://localhost');
    expect(renderedUrl.pathname).toBe('/_next/image');
    expect(renderedUrl.searchParams.get('url')).toBe('/large-source.png');
  });

  it('keeps search, filters, and card destinations accessible without activating JavaScript', async () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(3, true)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[
          { slug: 'runway', label: 'Runway', models: [], supportedMediaKinds: ['image', 'video'] },
        ]}
      />
    );

    expect(screen.getByRole('searchbox', { name: /search marketplace recipes/i }))
      .toHaveAttribute('name', 'q');
    expect(screen.getByRole('searchbox', { name: /search marketplace recipes/i }))
      .toHaveClass('min-w-0');
    expect(screen.getByRole('link', { name: 'Recent' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Paid' })).toHaveAttribute(
      'href',
      '/marketplace?access=paid&sort=recent'
    );
    expect(screen.getByRole('link', { name: 'Runway' })).toHaveAttribute(
      'href',
      '/marketplace?tool=runway&sort=recent'
    );
    expect(screen.getByRole('link', { name: 'View free recipe: Unlock 1' })).toHaveAttribute(
      'href',
      '/showcase/post-1?from=unlocks&returnTo=%2Fmarketplace%3Fsort%3Drecent#recipe'
    );

    await act(async () => Promise.resolve());
    expect(browserModuleLoaded).not.toHaveBeenCalled();
    expect(screen.queryByTestId('interactive-marketplace-browser')).not.toBeInTheDocument();
  });

  it('preserves active filters in the native search form', () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(3, false)}
        initialFilters={{
          access: 'free',
          resource: 'prompt',
          tool: 'runway',
          sort: 'top-sales',
          q: 'product demo',
        }}
        sourceToolOptions={[
          { slug: 'runway', label: 'Runway', models: [], supportedMediaKinds: ['image', 'video'] },
        ]}
      />
    );

    const form = screen.getByRole('search');
    expect(form).toBeInstanceOf(HTMLFormElement);
    const formData = new FormData(form as HTMLFormElement);

    expect(form).toHaveAttribute('action', '/marketplace');
    expect(form).toHaveAttribute('method', 'get');
    expect(formData.get('access')).toBe('free');
    expect(formData.get('resource')).toBe('prompt');
    expect(formData.get('tool')).toBe('runway');
    expect(formData.get('sort')).toBe('top-sales');
    expect(formData.get('q')).toBe('product demo');
  });

  it('warms on focus but hands off to the full browser only for load-more demand', async () => {
    render(
      <MarketplaceBootstrap
        initialPage={createPage(3, true)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    fireEvent.focus(screen.getByRole('searchbox', { name: /search marketplace recipes/i }));

    await waitFor(() => {
      expect(browserModuleLoaded).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('Unlock 1')).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-marketplace-browser')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more recipes/i }));

    expect(await screen.findByTestId('interactive-marketplace-browser')).toBeInTheDocument();
    expect(screen.queryByText('Unlock 1')).not.toBeInTheDocument();
  });

  it('activates near the continuation sentinel only after scroll intent', async () => {
    let intersectionCallback: IntersectionObserverCallback | null = null;

    class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '160px 0px';
      readonly thresholds = [0];

      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }

      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    }

    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    render(
      <MarketplaceBootstrap
        initialPage={createPage(3, true)}
        initialFilters={INITIAL_FILTERS}
        sourceToolOptions={[]}
      />
    );

    expect(intersectionCallback).toBeNull();
    expect(screen.queryByTestId('interactive-marketplace-browser')).not.toBeInTheDocument();

    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 200,
    });
    fireEvent.scroll(window);

    await waitFor(() => {
      expect(intersectionCallback).not.toBeNull();
    });
    act(() => {
      const callback = intersectionCallback as IntersectionObserverCallback;
      callback([
        { isIntersecting: true } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    expect(await screen.findByTestId('interactive-marketplace-browser')).toBeInTheDocument();
  });
});

function createPage(count: number, hasMore: boolean) {
  return {
    items: Array.from({ length: count }, (_, index) => createMarketplaceItem(index + 1)),
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? count : null,
      offset: 0,
      limit: 3,
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
