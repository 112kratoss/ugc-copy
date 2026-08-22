import { PassThrough } from 'node:stream';

import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HOME_SLIDE_LOOP_PASSES, getHomeSlides } from '@/lib/home-slider';
import type { ShowcaseFeedItem } from '@/lib/showcase';

const getServerAuthStateMock = vi.fn();
const headersMock = vi.fn();
const cookiesMock = vi.fn();
const getShowcaseFeedPageMock = vi.fn();
const loadPublishedGenerationModelCatalogMock = vi.fn();
const feedClientPropsMock = vi.fn();
const getInlineShowcasePriorityPosterMock = vi.fn();

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

  it('keeps the create rail, sign-in rail, quick starts, and legal footer', async () => {
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);

    expect(html).toContain('Creator workspace');
    expect(html).toContain('Create new');
    expect(html).toContain('Sign in');
    expect(html).toContain('Quick starts');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('Child safety');
  });

  it('keeps exactly one h1 after the marketing hero was replaced by the rail', async () => {
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);
    const container = document.createElement('div');
    container.innerHTML = html;

    // The rail carries no heading of its own, so the h1 the document outline
    // and the search snippet both rely on is now visually hidden. Losing it
    // would be invisible in the design and costly everywhere else.
    const headings = container.querySelectorAll('h1');

    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toContain('What will you create');
    expect(headings[0].className).toContain('sr-only');
  });

  it('renders the rail server-side, repeated for the loop', async () => {
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);
    const container = document.createElement('div');
    container.innerHTML = html;

    // Three passes is what lets the rail wrap in both directions without a
    // seam; server-rendering them keeps the rail from popping in on hydration.
    expect(container.querySelectorAll('.home-slider-slide')).toHaveLength(
      HOME_SLIDE_LOOP_PASSES * getHomeSlides().length
    );
  });

  it('exposes only one copy of each rail link to assistive tech', async () => {
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);
    const container = document.createElement('div');
    container.innerHTML = html;

    // The repeated passes are scenery. Left exposed they would announce every
    // destination three times and put three tab stops on each.
    const exposed = [...container.querySelectorAll('.home-slider-slide')]
      .filter((slide) => slide.getAttribute('aria-hidden') !== 'true');

    expect(exposed).toHaveLength(getHomeSlides().length);
    expect(
      [...container.querySelectorAll('.home-slider-slide[aria-hidden="true"] a')]
        .every((link) => link.getAttribute('tabindex') === '-1')
    ).toBe(true);
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

    const createNew = [...container.querySelectorAll('a')]
      .find((link) => link.textContent?.includes('Create new'));
    const railTool = container.querySelector('.home-slider-slide a[href="/create-image"]');
    const quickStartImage = [...container.querySelectorAll('a')]
      .find((link) => (
        link.getAttribute('href') === '/create-image' && !link.closest('.home-slider-slide')
      ));

    // The primary action keeps Next's default prefetch; everything else opts
    // out so the signed-out landing does not warm routes nobody asked for —
    // the rail especially, which renders every tool three times over.
    expect(createNew).toBeDefined();
    expect(createNew).not.toHaveAttribute('data-prefetch');
    expect(railTool).toHaveAttribute('data-prefetch', 'false');
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
