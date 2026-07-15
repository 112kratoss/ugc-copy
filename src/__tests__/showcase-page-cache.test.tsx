import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServerAuthStateMock = vi.fn();
const headersMock = vi.fn();
const getShowcaseFeedPageMock = vi.fn();
const sourceToolCatalog = vi.hoisted(() => [
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
]);

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

vi.mock('next/headers', () => ({
  headers: () => headersMock(),
}));

vi.mock('@/lib/showcase-feed', () => ({
  getShowcaseFeedPage: (options: unknown) => getShowcaseFeedPageMock(options),
}));

vi.mock('@/lib/source-tools-server', () => ({
  listSourceToolsCatalog: () => Promise.resolve(sourceToolCatalog),
}));

vi.mock('@/app/showcase/ShowcaseClient', () => ({
  default: () => <div data-testid="showcase-client" />,
}));

describe('ShowcasePage cacheability', () => {
  beforeEach(() => {
    vi.resetModules();
    getServerAuthStateMock.mockReset();
    headersMock.mockReset();
    getShowcaseFeedPageMock.mockReset();
    getServerAuthStateMock.mockImplementation(() => {
      throw new Error('Showcase should not read server auth for cacheable public content');
    });
    headersMock.mockImplementation(() => {
      throw new Error('Showcase should not read request headers for cacheable public content');
    });
    getShowcaseFeedPageMock.mockResolvedValue({
      items: [],
      pageInfo: {
        hasMore: false,
        nextOffset: null,
        limit: 24,
        offset: 0,
      },
    });
  });

  it('renders the initial feed without request-time auth or header dependencies', async () => {
    const { default: ShowcasePage } = await import('@/app/showcase/page');

    render(await ShowcasePage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId('showcase-client')).toBeInTheDocument();
    expect(getServerAuthStateMock).not.toHaveBeenCalled();
    expect(headersMock).not.toHaveBeenCalled();
    expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({
      viewerUserId: null,
      countryCode: null,
      limit: 6,
    }));
  });

  it('emits one server-owned preload for the initial priority video poster', async () => {
    getShowcaseFeedPageMock.mockResolvedValue({
      items: [
        {
          id: 'video-post',
          postFormat: 'media',
          mediaUrl: 'https://example.com/video.mp4',
          mediaKind: 'video',
          mediaItems: [
            {
              id: 'video-cover',
              url: 'https://example.com/video.mp4',
              previewUrl: 'https://example.com/video-preview.webp',
              mediaKind: 'video',
              sortOrder: 0,
            },
          ],
        },
      ],
      pageInfo: {
        hasMore: false,
        nextOffset: null,
        limit: 12,
        offset: 0,
      },
    });
    const { default: ShowcasePage } = await import('@/app/showcase/page');

    render(await ShowcasePage({ searchParams: Promise.resolve({ category: 'video' }) }));

    const preloads = document.querySelectorAll('link[rel="preload"][as="image"]');
    expect(preloads).toHaveLength(1);
    expect(preloads[0]).toHaveAttribute('href', 'https://example.com/video-preview.webp');
    expect(preloads[0]).toHaveAttribute('fetchpriority', 'high');
  });

  it('does not preload media outside the progressively rendered prefix', async () => {
    getShowcaseFeedPageMock.mockResolvedValue({
      items: [
        { id: 'text-1', postFormat: 'text', mediaItems: [] },
        { id: 'text-2', postFormat: 'text', mediaItems: [] },
        {
          id: 'deferred-video',
          postFormat: 'media',
          mediaItems: [{
            id: 'deferred-cover',
            url: 'https://example.com/deferred.mp4',
            previewUrl: 'https://example.com/deferred.webp',
            mediaKind: 'video',
            sortOrder: 0,
          }],
        },
      ],
      pageInfo: {
        hasMore: false,
        nextOffset: null,
        limit: 12,
        offset: 0,
      },
    });
    const { default: ShowcasePage } = await import('@/app/showcase/page');

    render(await ShowcasePage({ searchParams: Promise.resolve({}) }));

    expect(document.querySelector('link[rel="preload"][as="image"]')).toBeNull();
  });
});
