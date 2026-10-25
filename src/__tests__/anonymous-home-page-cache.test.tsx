import { PassThrough } from 'node:stream';

import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeShelfItem } from '@/lib/home-shelf';
import type { ShowcaseFeedItem } from '@/lib/showcase';

const getServerAuthStateMock = vi.fn();
const headersMock = vi.fn();
const cookiesMock = vi.fn();
const getShowcaseFeedPageMock = vi.fn();
const loadPublishedGenerationModelCatalogMock = vi.fn();
const feedClientPropsMock = vi.fn();
const getInlineShowcasePriorityPosterMock = vi.fn();
const loadHomeShelfMock = vi.fn();

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

vi.mock('@/lib/home-shelf-server', () => ({
  loadHomeShelf: (identity?: unknown) => loadHomeShelfMock(identity),
}));

vi.mock('@/lib/showcase-priority-poster', () => ({
  getInlineShowcasePriorityPoster: (src: string) => getInlineShowcasePriorityPosterMock(src),
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

function shelfCreation(id: string, overrides: Partial<Extract<HomeShelfItem, { kind: 'creation' }>> = {}): HomeShelfItem {
  return {
    kind: 'creation',
    id,
    title: `Creation ${id}`,
    tool: 'video',
    posterUrl: `https://cdn.example.test/${id}/poster.webp`,
    posterThumbhash: null,
    clipUrl: null,
    modelName: 'Grok Imagine',
    price: { kind: 'credits', credits: 15 },
    fitsWelcomeCredits: true,
    badge: null,
    creator: { username: 'magicbooklet', name: 'Magicbooklet Team', avatar: null },
    makeHref: `/create-video?remix=generation-${id}&remixPost=${id}`,
    ...overrides,
  };
}

const SHELF = [shelfCreation('boat'), shelfCreation('serum', { price: { kind: 'credits', credits: 70 }, fitsWelcomeCredits: false }), shelfCreation('dance')];

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
    getInlineShowcasePriorityPosterMock.mockReset();
    getInlineShowcasePriorityPosterMock.mockResolvedValue(null);
    loadHomeShelfMock.mockReset();
    loadHomeShelfMock.mockResolvedValue(SHELF);
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
      // The page cannot read `?chip=`; the client switches to the lane it names.
      laneFromUrl: true,
      detailContext: { from: 'home', returnTo: '/' },
    }));
  });

  it('passes one bounded server-inlined preview to the first home feed card', async () => {
    const previewUrl = 'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/generation-1/cover.preview.abcdef0123456789.webp?token=signed-token';
    const imageItem = {
      ...buildFeedItem('image-post'),
      postFormat: 'media',
      category: 'image',
      mediaItems: [{
        id: 'media-1',
        url: 'https://project.supabase.co/storage/v1/object/public/showcase_media/source.webp',
        previewUrl,
        mediaKind: 'image',
        contentType: 'image/webp',
        originalName: 'source.webp',
        sortOrder: 0,
      }],
    } as unknown as ShowcaseFeedItem;
    mockFeed([imageItem]);
    getInlineShowcasePriorityPosterMock.mockResolvedValue('data:image/webp;base64,UklGRgAAAABXRUJQ');
    const { default: Home } = await import('@/app/page');

    await renderPageToHtml(<Home />);

    expect(getInlineShowcasePriorityPosterMock).toHaveBeenCalledWith(previewUrl);
    expect(feedClientPropsMock).toHaveBeenCalledWith(expect.objectContaining({
      initialPriorityPreview: {
        postId: 'image-post',
        mediaId: 'media-1',
        dataUrl: 'data:image/webp;base64,UklGRgAAAABXRUJQ',
      },
    }));
  });

  it('keeps the shelf, sign-in rail, quick starts, and legal footer', async () => {
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);

    expect(html).toContain('Make this');
    expect(html).toContain('Sign in');
    expect(html).toContain('Quick starts');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('Child safety');
  });

  it('keeps exactly one h1, visible and naming what the product does', async () => {
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);
    const container = document.createElement('div');
    container.innerHTML = html;

    // The h1 the document outline and the search snippet both rely on. It was
    // `sr-only` and read "What will you create today?", which named no
    // capability anyone searches for — and since the only other headings on `/`
    // are feed post titles, the site's highest-authority page had nothing to
    // rank on. Visible and specific now; losing either property is costly.
    const headings = container.querySelectorAll('h1');

    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toContain('motion-transfer');
    expect(headings[0].className).not.toContain('sr-only');
  });

  it('keeps feed post titles out of the top-level document outline', async () => {
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);
    const container = document.createElement('div');
    container.innerHTML = html;

    // Post titles are user input. As h2s they were top-level sections of `/`,
    // so the page's outline read as a list of whatever had most recently been
    // published — "test", "fake mask", "minnal2.0". A post title reaches the
    // page as a link to its detail route, so no h2 may contain one.
    const postLinkedHeadings = [...container.querySelectorAll('h2')]
      .filter((heading) => heading.querySelector('a[href*="/showcase/"]'));

    expect(postLinkedHeadings).toHaveLength(0);
  });

  it('renders the shelf server-side from the identityless lane, offering it free to try', async () => {
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);
    const container = document.createElement('div');
    container.innerHTML = html;

    // Part of the prerender, so the cards are in the first HTML; the signed-out
    // page asks for no viewer, which keeps it shared and cacheable.
    expect(loadHomeShelfMock).toHaveBeenCalledWith(undefined);
    const cards = [...container.querySelectorAll('.home-shelf-card[href^="/create-"]')];
    expect(cards.map((card) => card.getAttribute('href'))).toEqual(SHELF.map((item) => (
      item.kind === 'creation' ? item.makeHref : null
    )));
    // The welcome credits cover two of the three; the third says its price.
    expect(container.querySelectorAll('.home-shelf-card')[0].textContent).toContain('Free to try');
    expect(container.querySelectorAll('.home-shelf-card')[1].textContent).not.toContain('Free to try');
    expect(container.querySelectorAll('.home-shelf-card')[1].textContent).toContain('70 credits');
  });

  it('renders no shelf when there is nothing to put on it', async () => {
    loadHomeShelfMock.mockResolvedValue([]);
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);
    const container = document.createElement('div');
    container.innerHTML = html;

    expect(container.querySelector('.home-shelf')).toBeNull();
    expect(html).toContain('feed-client');
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

    const shelfLinks = [...container.querySelectorAll('.home-shelf a')];
    const quickStartImage = [...container.querySelectorAll('a')]
      .find((link) => (
        link.getAttribute('href') === '/create-image' && !link.closest('.home-shelf')
      ));

    // The signed-out landing does not warm routes nobody asked for: every
    // shelf card opens a create page, and the quick starts name the same tools.
    expect(shelfLinks.length).toBeGreaterThan(SHELF.length);
    expect(shelfLinks.every((link) => link.getAttribute('data-prefetch') === 'false')).toBe(true);
    expect(quickStartImage).toHaveAttribute('data-prefetch', 'false');
  });

  it('hands the lane to the client when the feed is unavailable', async () => {
    // This page is cached and shared: a callout baked into it would greet
    // every visitor until the next regeneration. The client lane fetches page
    // one itself instead, with a Retry that works in the browser.
    getShowcaseFeedPageMock.mockRejectedValue(new Error('feed offline'));
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);

    expect(html).not.toContain('Could not load the community feed');
    expect(html).toContain('feed-client');
    expect(feedClientPropsMock).toHaveBeenCalledWith(expect.objectContaining({
      initialFeed: null,
      laneFromUrl: true,
    }));
  });
});
