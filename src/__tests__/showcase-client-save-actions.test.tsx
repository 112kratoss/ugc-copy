import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseClient from '@/app/showcase/ShowcaseClient';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';
import type { SourceToolOption } from '@/lib/source-tools';

const mockPush = vi.fn();
const mockReplace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  usePathname: () => '/showcase',
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: boolean;
    children: ReactNode;
  }) => (
    <a
      href={href}
      data-prefetch={prefetch === undefined ? undefined : String(prefetch)}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: {
      access_token: 'test-token',
      user: { id: 'user-1' },
    },
    user: { id: 'user-1' },
    credits: 25,
    isLoading: false,
  }),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    span: ({ children, ...props }: HTMLAttributes<HTMLSpanElement>) => <span {...props}>{children}</span>,
  },
  useReducedMotion: () => false,
}));

const SOURCE_TOOL_OPTIONS: SourceToolOption[] = [
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
];

function createShowcaseItem(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: 'https://example.com/image.jpg',
    mediaKind: 'image',
    model: 'nano-banana-2',
    title: 'Campaign Frame',
    prompt: 'A creator-style product shot by a bright window.',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 4,
    remixCount: 2,
    createdAt: '2026-03-28T10:00:00.000Z',
    creator: {
      id: 'creator-1',
      username: 'creator-name',
      name: 'Creator Name',
      avatar: null,
    },
    isSaved: false,
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: 'gen-1',
    asset: null,
    canRemix: false,
    ...overrides,
  };
}

function createFeed(
  item: ShowcaseFeedItem,
  pageInfo: Partial<ShowcaseFeedPage['pageInfo']> = {}
): ShowcaseFeedPage {
  return {
    items: [item],
    pageInfo: {
      hasMore: false,
      nextOffset: null,
      limit: 24,
      offset: 0,
      ...pageInfo,
    },
  };
}

function renderShowcase(item: ShowcaseFeedItem) {
  return render(
    <ShowcaseClient
      initialFeed={createFeed(item)}
      initialCategory="all"
      initialSort="recent"
      initialTool={null}
      initialUnlock="all"
      initialResource="all"
      sourceToolOptions={SOURCE_TOOL_OPTIONS}
    />
  );
}

describe('ShowcaseClient save actions', () => {
  const intersectionObservers: Array<{
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    trigger: (isIntersecting?: boolean) => void;
  }> = [];

  beforeEach(() => {
    window.history.replaceState(null, '', '/showcase');
    mockPush.mockReset();
    mockReplace.mockReset();
    intersectionObservers.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/saved-state')) {
        return {
          ok: true,
          json: async () => [],
        };
      }

      return {
        ok: true,
        json: async () => ({ success: true }),
      };
    }));
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal('IntersectionObserver', vi.fn(function IntersectionObserverMock(callback: IntersectionObserverCallback) {
      const observer = {
        root: null,
        rootMargin: '0px',
        thresholds: [0],
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
        takeRecords: vi.fn(() => []),
      } satisfies IntersectionObserver;

      intersectionObservers.push({
        observe: observer.observe,
        disconnect: observer.disconnect,
        trigger: (isIntersecting = true) => {
          callback([
            {
              isIntersecting,
              target: document.createElement('div'),
            } as unknown as IntersectionObserverEntry,
          ], observer);
        },
      });

      return observer;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('optimistically saves a showcase card with accessible pressed state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, isSaved: true, saveCount: 5, changed: true }),
    })));

    renderShowcase(createShowcaseItem());

    const saveButton = screen.getByRole('button', {
      name: /save campaign frame\. 4 saves/i,
    });
    expect(saveButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: /remove save from campaign frame\. 5 saves/i,
      })).toHaveAttribute('aria-pressed', 'true');
    });
    expect(fetch).toHaveBeenCalledWith('/api/showcase/save', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        postId: 'post-1',
        shouldSave: true,
        sourceSurface: 'showcase',
      }),
    }));
  });

  it('rolls the showcase card save state back when the API fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'Failed' }),
    })));

    renderShowcase(createShowcaseItem());

    fireEvent.click(screen.getByRole('button', {
      name: /save campaign frame\. 4 saves/i,
    }));

    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: /save campaign frame\. 4 saves/i,
      })).toHaveAttribute('aria-pressed', 'false');
    });
  });

  it('hydrates saved state after the signed-in client loads cached public feed items', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/saved-state')) {
        return {
          ok: true,
          json: async () => ['post-1'],
        };
      }

      return {
        ok: true,
        json: async () => ({ success: true }),
      };
    }));

    renderShowcase(createShowcaseItem({ isSaved: false }));

    expect(screen.getByRole('button', {
      name: /save campaign frame\. 4 saves/i,
    })).toHaveAttribute('aria-pressed', 'false');

    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: /remove save from campaign frame\. 4 saves/i,
      })).toHaveAttribute('aria-pressed', 'true');
    });
    expect(fetch).toHaveBeenCalledWith('/api/showcase/saved-state?ids=post-1%2Cgen-1', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer test-token',
      }),
    }));
  });

  it('reconciles an optimistic save with canonical server state when saved-state hydration is stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/saved-state')) {
        return {
          ok: true,
          json: async () => [],
        };
      }

      return {
        ok: true,
        json: async () => ({
          success: true,
          isSaved: true,
          saveCount: 4,
          changed: false,
        }),
      };
    }));

    renderShowcase(createShowcaseItem({ isSaved: false }));

    fireEvent.click(screen.getByRole('button', {
      name: /save campaign frame\. 4 saves/i,
    }));

    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: /remove save from campaign frame\. 4 saves/i,
      })).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('labels paid unlock links with the price instead of a generic view action', () => {
    renderShowcase(createShowcaseItem({
      asset: {
        id: 'bundle-1',
        postId: 'post-1',
        title: 'Prompt pack',
        accessMode: 'paid',
        priceUsdCents: 900,
        priceQuote: {
          currency: 'USD',
          amountSubunits: 900,
          formatted: '$9.00',
          note: null,
        },
        previewText: 'Unlock the exact reusable prompt.',
        allowRemix: false,
        resourceKinds: ['prompt', 'notes'],
        itemCounts: { prompt: 1, note: 1 },
        lockedPreview: {
          resourceKinds: ['prompt', 'notes'],
          attachmentPreviews: [],
          itemCounts: { prompt: 1, note: 1 },
          itemPreviews: [
            {
              type: 'prompt',
              title: 'Prompt',
              role: 'primary',
              sectionId: null,
              remixUse: 'none',
            },
          ],
          hasPrompt: true,
          hasNotes: true,
          hasWorkflow: false,
          hasRemix: false,
          updatedAt: '2026-04-02T10:00:00.000Z',
        },
      },
    }));

    const unlockLink = screen.getByRole('link', { name: /unlock for \$9\.00/i });
    expect(unlockLink).toHaveAttribute('href', expect.stringContaining('#resources'));
  });

  it('disables prefetching for community card detail and creator links', () => {
    renderShowcase(createShowcaseItem({
      asset: {
        id: 'bundle-1',
        postId: 'post-1',
        title: 'Campaign Frame Unlock',
        accessMode: 'paid',
        priceUsdCents: 900,
        previewText: 'Prompt and workflow included.',
        allowRemix: false,
        resourceKinds: ['prompt'],
      },
    }));

    expect(screen.getByRole('link', { name: /creator name/i })).toHaveAttribute('data-prefetch', 'false');
    expect(screen.getByRole('link', { name: /unlock for \$9\.00/i })).toHaveAttribute('data-prefetch', 'false');

    fireEvent.click(screen.getByAltText('Campaign Frame'));

    expect(screen.getAllByRole('link', { name: /unlock for \$9\.00/i }).at(-1)).toHaveAttribute('data-prefetch', 'false');
    expect(screen.getByRole('link', { name: /open full page/i })).toHaveAttribute('data-prefetch', 'false');
  });

  it('lazy-loads image previews in the public showcase grid', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [],
    })));

    renderShowcase(createShowcaseItem());

    const image = screen.getByRole('img', { name: 'Campaign Frame' });
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('decoding', 'async');
  });

  it('adds a shareable post URL when a feed card opens and returns through history on close', async () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);

    renderShowcase(createShowcaseItem());
    fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('post')).toBe('post-1');
    });
    expect(pushState).toHaveBeenCalledWith(null, '', '/showcase?post=post-1');

    fireEvent.click(screen.getByRole('button', { name: /feed/i }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('preserves the selected carousel slide when opening the reel', async () => {
    renderShowcase(createShowcaseItem({
      mediaItems: [
        {
          id: 'media-1',
          url: 'https://example.com/cover.jpg',
          mediaKind: 'image',
          contentType: 'image/jpeg',
          originalName: 'cover.jpg',
          width: 800,
          height: 1000,
          durationSeconds: null,
          sortOrder: 0,
        },
        {
          id: 'media-2',
          url: 'https://example.com/second.jpg',
          mediaKind: 'image',
          contentType: 'image/jpeg',
          originalName: 'second.jpg',
          width: 1200,
          height: 800,
          durationSeconds: null,
          sortOrder: 1,
        },
      ],
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Next media' }));
    fireEvent.click(screen.getByRole('button', { name: 'Campaign Frame' }));

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get('post')).toBe('post-1');
      expect(params.get('media')).toBe('1');
    });
  });

  it('loads a shared post URL that is not present in the first feed page without pushing a duplicate history entry', async () => {
    const sharedItem = createShowcaseItem({
      id: 'post-shared',
      title: 'Shared Campaign',
      generationId: 'gen-shared',
      mediaUrl: 'https://example.com/shared.jpg',
    });
    window.history.replaceState(null, '', '/showcase?post=post-shared');
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/showcase/posts/post-shared') {
        return {
          ok: true,
          json: async () => ({ success: true, item: sharedItem }),
        };
      }

      if (url.startsWith('/api/showcase/saved-state')) {
        return {
          ok: true,
          json: async () => [],
        };
      }

      return {
        ok: true,
        json: async () => ({ success: true }),
      };
    }));

    renderShowcase(createShowcaseItem());

    expect((await screen.findAllByRole('heading', { name: 'Shared Campaign' })).length).toBeGreaterThan(1);
    expect(pushState).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /feed/i }));

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).has('post')).toBe(false);
    });
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/showcase');
  });

  it('automatically loads the next showcase page when the feed sentinel enters view', async () => {
    const firstItem = createShowcaseItem({ id: 'post-1', title: 'Campaign Frame', generationId: 'gen-1' });
    const secondItem = createShowcaseItem({
      id: 'post-2',
      title: 'Second Campaign Frame',
      generationId: 'gen-2',
      mediaUrl: 'https://example.com/second.jpg',
    });
    const feedFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        items: [secondItem],
        pageInfo: {
          hasMore: false,
          nextOffset: null,
          limit: 12,
          offset: 12,
        },
      }),
    }));

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/feed')) {
        return feedFetch();
      }

      if (url.startsWith('/api/showcase/saved-state')) {
        return {
          ok: true,
          json: async () => [],
        };
      }

      return {
        ok: true,
        json: async () => ({ success: true }),
      };
    }));

    render(
      <ShowcaseClient
        initialFeed={createFeed(firstItem, { hasMore: true, nextOffset: 12, limit: 12 })}
        initialCategory="all"
        initialSort="recent"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    await waitFor(() => {
      expect(intersectionObservers.length).toBeGreaterThan(0);
    });

    intersectionObservers.at(-1)?.trigger(true);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Second Campaign Frame' })).toBeInTheDocument();
    });
    expect(feedFetch).toHaveBeenCalledTimes(1);
  });

  it('does not start duplicate automatic feed requests while a page is already loading', async () => {
    const firstItem = createShowcaseItem({ id: 'post-1', title: 'Campaign Frame', generationId: 'gen-1' });
    let resolveFeed: (value: {
      ok: boolean;
      json: () => Promise<ShowcaseFeedPage>;
    }) => void = () => undefined;
    const feedFetch = vi.fn(() => new Promise<{
      ok: boolean;
      json: () => Promise<ShowcaseFeedPage>;
    }>((resolve) => {
      resolveFeed = resolve;
    }));

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/feed')) {
        return feedFetch();
      }

      if (url.startsWith('/api/showcase/saved-state')) {
        return {
          ok: true,
          json: async () => [],
        };
      }

      return {
        ok: true,
        json: async () => ({ success: true }),
      };
    }));

    render(
      <ShowcaseClient
        initialFeed={createFeed(firstItem, { hasMore: true, nextOffset: 12, limit: 12 })}
        initialCategory="all"
        initialSort="recent"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    await waitFor(() => {
      expect(intersectionObservers.length).toBeGreaterThan(0);
    });

    intersectionObservers.at(-1)?.trigger(true);
    intersectionObservers.at(-1)?.trigger(true);

    await waitFor(() => {
      expect(feedFetch).toHaveBeenCalledTimes(1);
    });

    resolveFeed({
      ok: true,
      json: async () => ({
        items: [],
        pageInfo: {
          hasMore: false,
          nextOffset: null,
          limit: 12,
          offset: 12,
        },
      }),
    });
  });
});
