import { PassThrough } from 'node:stream';

import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShowcaseFeedItem } from '@/lib/showcase';

const getServerAuthStateMock = vi.fn();
const headersMock = vi.fn();
const cookiesMock = vi.fn();
const getShowcaseFeedPageMock = vi.fn();
const loadPublishedGenerationModelCatalogMock = vi.fn();
const feedClientPropsMock = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

vi.mock('next/headers', () => ({
  headers: () => headersMock(),
  cookies: () => cookiesMock(),
}));

vi.mock('@/lib/showcase-feed', () => ({
  getShowcaseFeedPage: (options: unknown) => getShowcaseFeedPageMock(options),
}));

vi.mock('@/lib/generation-model-catalog-store', () => ({
  loadPublishedGenerationModelCatalog: (options: unknown) => (
    loadPublishedGenerationModelCatalogMock(options)
  ),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}));

vi.mock('@/app/feed/FeedClient', () => ({
  default: (props: Record<string, unknown>) => {
    feedClientPropsMock(props);
    return <div data-testid="feed-client" />;
  },
}));

vi.mock('next/link', () => ({
  default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
    <a
      {...props}
      data-prefetch={prefetch === undefined ? undefined : String(prefetch)}
    />
  ),
}));

/**
 * Renders the page the way production does — as a streamed server tree, with
 * `onAllReady` waiting for every Suspense boundary to resolve. RTL's
 * client-side render cannot settle `use(promise)` components (the parent
 * re-render would mint fresh promises), so the stream renderer is the
 * faithful harness here.
 */
function renderPageToHtml(element: ReactElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    sink.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sink.on('error', reject);

    const { pipe } = renderToPipeableStream(element, {
      onAllReady() {
        pipe(sink);
      },
      onError(error) {
        reject(error);
      },
    });
  });
}

function buildFeedItem(id: string): ShowcaseFeedItem {
  return {
    id,
    postFormat: 'text',
    category: 'text',
    title: `Community note ${id}`,
    body: 'A reusable note body.',
    mediaUrl: null,
    mediaItems: [],
    commentCount: 0,
    createdAt: '2026-07-20T10:00:00.000Z',
    creator: { username: 'batman', name: 'Batman' },
  } as unknown as ShowcaseFeedItem;
}

function mockFeed(items: ShowcaseFeedItem[]) {
  getShowcaseFeedPageMock.mockResolvedValue({
    items,
    availableTools: [],
    pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 0 },
  });
}

describe('Anonymous home cacheability', () => {
  beforeEach(() => {
    vi.resetModules();
    getServerAuthStateMock.mockReset();
    headersMock.mockReset();
    cookiesMock.mockReset();
    getShowcaseFeedPageMock.mockReset();
    loadPublishedGenerationModelCatalogMock.mockReset();
    feedClientPropsMock.mockReset();
    getServerAuthStateMock.mockImplementation(() => {
      throw new Error('Anonymous home must not read server auth — / must stay statically prerenderable');
    });
    headersMock.mockImplementation(() => {
      throw new Error('Anonymous home must not read request headers — / must stay statically prerenderable');
    });
    cookiesMock.mockImplementation(() => {
      throw new Error('Anonymous home must not read cookies — / must stay statically prerenderable');
    });
    loadPublishedGenerationModelCatalogMock.mockResolvedValue({
      catalog: {
        models: [
          {
            id: 'kling-3.0-turbo',
            kind: 'video',
            displayName: 'Kling 3 Turbo',
            description: 'Fast Kling generation',
            badge: 'New',
            sortOrder: 10,
          },
        ],
      },
    });
    mockFeed([buildFeedItem('a')]);
  });

  it('renders the feed-first shell without request-time auth, header, or cookie reads', async () => {
    const pageModule = await import('@/app/page');

    const html = await renderPageToHtml(<pageModule.default />);

    expect(html).toContain('feed-client');
    expect(getServerAuthStateMock).not.toHaveBeenCalled();
    expect(headersMock).not.toHaveBeenCalled();
    expect(cookiesMock).not.toHaveBeenCalled();
    expect(pageModule.revalidate).toBe(60);
    expect(pageModule.metadata).toBeDefined();
  });

  it('loads the identityless (cache-eligible) feed lane', async () => {
    const { default: Home } = await import('@/app/page');

    await renderPageToHtml(<Home />);

    expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({
      viewerUserId: null,
      countryCode: null,
      sort: 'for-you',
      offset: 0,
    }));
    expect(feedClientPropsMock).toHaveBeenCalledWith(expect.objectContaining({
      variant: 'embedded',
      initialChipId: 'for-you',
      detailContext: { from: 'home', returnTo: '/' },
    }));
  });

  it('keeps the hero, sign-in rail, quick starts, and legal footer', async () => {
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);

    expect(html).toContain('What will you create');
    expect(html).toContain('Sign in');
    expect(html).toContain('Quick starts');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('Child safety');
  });

  it('renders the dynamic models card from the published catalog', async () => {
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);

    expect(html).toContain('Kling 3 Turbo');
    expect(html).toContain('/create-video?model=kling-3.0-turbo');
  });

  it('keeps secondary navigation out of first-paint prefetching', async () => {
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);
    const container = document.createElement('div');
    container.innerHTML = html;

    const startCreating = [...container.querySelectorAll('a')]
      .find((link) => link.textContent?.includes('Start creating'));
    const browseShowcase = [...container.querySelectorAll('a')]
      .find((link) => link.textContent?.includes('Browse Showcase'));
    const quickStartImage = [...container.querySelectorAll('a')]
      .find((link) => link.getAttribute('href') === '/create-image');

    // The primary action keeps Next's default prefetch; everything else opts
    // out so the signed-out landing does not warm routes nobody asked for.
    expect(startCreating).toBeDefined();
    expect(startCreating).not.toHaveAttribute('data-prefetch');
    expect(browseShowcase).toHaveAttribute('data-prefetch', 'false');
    expect(quickStartImage).toHaveAttribute('data-prefetch', 'false');
  });

  it('degrades to a callout when the feed is unavailable', async () => {
    getShowcaseFeedPageMock.mockRejectedValue(new Error('feed offline'));
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);

    expect(html).toContain('Could not load the community feed');
    expect(html).not.toContain('feed-client');
  });
});
