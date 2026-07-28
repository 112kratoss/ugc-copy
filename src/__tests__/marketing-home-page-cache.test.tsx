import { PassThrough } from 'node:stream';

import type { ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShowcaseFeedItem } from '@/lib/showcase';

const getServerAuthStateMock = vi.fn();
const headersMock = vi.fn();
const cookiesMock = vi.fn();
const getShowcaseFeedPageMock = vi.fn();

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

vi.mock('@/lib/creator-tool-previews', () => ({
  buildCreatorToolPreviewMap: () => ({}),
  loadCreatorToolPreviewMap: () => Promise.resolve({}),
}));

vi.mock('@/app/components/DeferredHomeShowcasePreviewGrid', () => ({
  default: () => <div data-testid="home-showcase-grid" />,
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

function buildTextNote(id: string): ShowcaseFeedItem {
  return {
    id,
    postFormat: 'text',
    category: 'text',
    title: `Reusable framework ${id}`,
    body: 'A reusable note body.',
    mediaUrl: null,
    mediaItems: [],
    commentCount: 0,
    createdAt: '2026-07-20T10:00:00.000Z',
    creator: { username: 'batman', name: 'Batman' },
  } as unknown as ShowcaseFeedItem;
}

function emptyPageInfo(limit: number) {
  return { hasMore: false, nextOffset: null, limit, offset: 0 };
}

function mockFeeds({ notes }: { notes: ShowcaseFeedItem[] }) {
  getShowcaseFeedPageMock.mockImplementation((options) => {
    const request = options as { category?: string };
    if (request.category === 'text') {
      return Promise.resolve({ items: notes, availableTools: [], pageInfo: emptyPageInfo(6) });
    }
    return Promise.resolve({ items: [], availableTools: [], pageInfo: emptyPageInfo(12) });
  });
}

describe('Marketing home cacheability', () => {
  beforeEach(() => {
    vi.resetModules();
    getServerAuthStateMock.mockReset();
    headersMock.mockReset();
    cookiesMock.mockReset();
    getShowcaseFeedPageMock.mockReset();
    getServerAuthStateMock.mockImplementation(() => {
      throw new Error('Marketing home must not read server auth — / must stay statically prerenderable');
    });
    headersMock.mockImplementation(() => {
      throw new Error('Marketing home must not read request headers — / must stay statically prerenderable');
    });
    cookiesMock.mockImplementation(() => {
      throw new Error('Marketing home must not read cookies — / must stay statically prerenderable');
    });
  });

  it('renders without request-time auth, header, or cookie reads and keeps ISR', async () => {
    mockFeeds({ notes: [] });
    const pageModule = await import('@/app/page');

    const html = await renderPageToHtml(<pageModule.default />);

    expect(html).toContain('What will you create');
    expect(getServerAuthStateMock).not.toHaveBeenCalled();
    expect(headersMock).not.toHaveBeenCalled();
    expect(cookiesMock).not.toHaveBeenCalled();
    expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({
      viewerUserId: null,
      countryCode: null,
    }));
    expect(pageModule.revalidate).toBe(60);
    expect(pageModule.metadata).toBeDefined();
  });

  it('hides the creator-notes strip below three notes', async () => {
    mockFeeds({ notes: [buildTextNote('a'), buildTextNote('b')] });
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);

    expect(html).toContain('home-showcase-grid');
    expect(html).not.toContain('Notes and prompts from creators.');
  });

  it('shows the creator-notes strip at three notes', async () => {
    mockFeeds({ notes: [buildTextNote('a'), buildTextNote('b'), buildTextNote('c')] });
    const { default: Home } = await import('@/app/page');

    const html = await renderPageToHtml(<Home />);

    expect(html).toContain('Notes and prompts from creators.');
    expect(html).toContain('Reusable framework a');
  });
});
