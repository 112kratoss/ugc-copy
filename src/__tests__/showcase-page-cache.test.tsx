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
    }));
  });
});
