import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseClient from '@/app/showcase/ShowcaseClient';
import {
  SHOWCASE_INITIAL_RENDER_COUNT,
  SHOWCASE_PAGE_SIZE,
  type ShowcaseFeedItem,
  type ShowcaseFeedPage,
} from '@/lib/showcase';
import type { SourceToolOption } from '@/lib/source-tools';
import {
  clearShowcaseClientCacheForTests,
  forgetShowcaseSnapshotsInMemoryForTests,
  takeBlockedCreatorOffClientFeeds,
} from '@/lib/showcase-client-cache';

const mockPush = vi.fn();
const mockReplace = vi.fn();
const authState = vi.hoisted(() => ({
  session: {
    access_token: 'test-token',
    user: { id: 'user-1' },
  } as { access_token: string; user: { id: string } } | null,
  user: { id: 'user-1' } as { id: string } | null,
  credits: 25,
  isLoading: false,
}));

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

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => authState,
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
    commentCount: 0,
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
  itemOrItems: ShowcaseFeedItem | ShowcaseFeedItem[],
  pageInfo: Partial<ShowcaseFeedPage['pageInfo']> = {}
): ShowcaseFeedPage {
  return {
    items: Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems],
    pageInfo: {
      hasMore: false,
      nextOffset: null,
      limit: 24,
      offset: 0,
      ...pageInfo,
    },
  };
}

/** Drops the copies Explore keeps of its pages, and nothing else the tab remembers. */
function clearShowcaseSnapshotsOnly() {
  for (const key of Object.keys(window.sessionStorage)) {
    if (key.startsWith('magicbooklet:showcase:')) window.sessionStorage.removeItem(key);
  }
  forgetShowcaseSnapshotsInMemoryForTests();
}

function renderShowcase(itemOrItems: ShowcaseFeedItem | ShowcaseFeedItem[]) {
  return render(
    <ShowcaseClient
      initialFeed={createFeed(itemOrItems)}
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
    observedTargets: Element[];
    rootMargin: string;
    trigger: (isIntersecting?: boolean) => void;
  }> = [];

  beforeEach(() => {
    clearShowcaseClientCacheForTests();
    window.history.replaceState(null, '', '/showcase');
    mockPush.mockReset();
    mockReplace.mockReset();
    authState.session = {
      access_token: 'test-token',
      user: { id: 'user-1' },
    };
    authState.user = { id: 'user-1' };
    authState.credits = 25;
    authState.isLoading = false;
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
    vi.stubGlobal('IntersectionObserver', vi.fn(function IntersectionObserverMock(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit
    ) {
      const observedTargets: Element[] = [];
      const observer = {
        root: null,
        rootMargin: options?.rootMargin ?? '0px',
        thresholds: [0],
        observe: vi.fn((target: Element) => { observedTargets.push(target); }),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
        takeRecords: vi.fn(() => []),
      } satisfies IntersectionObserver;

      intersectionObservers.push({
        observe: observer.observe,
        disconnect: observer.disconnect,
        observedTargets,
        rootMargin: observer.rootMargin,
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
    vi.useRealTimers();
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
    await waitFor(() => {
      const eventRequest = vi.mocked(fetch).mock.calls.find(([input, request]) => {
        if (String(input) !== '/api/showcase/feed/events') return false;
        return JSON.parse(String(request?.body)).eventType === 'save';
      });
      expect(eventRequest).toBeDefined();
    });
  });

  it('gives anonymous viewers the same complete card the bootstrap shell handed over', async () => {
    authState.session = null;
    authState.user = null;
    const items = [
      createShowcaseItem(),
      createShowcaseItem({
        id: 'post-2',
        generationId: 'gen-2',
        title: 'Deferred Campaign',
      }),
    ];

    const { container } = render(
      <ShowcaseClient
        initialFeed={createFeed(items)}
        initialCategory="all"
        initialSort="recent"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
        initialPriorityPoster={{
          postId: 'post-1',
          mediaId: 'post-1:cover',
          dataUrl: 'data:image/webp;base64,UklGRg==',
        }}
      />
    );

    // No intermediate poster-only card: the static bootstrap shell already
    // played that role, so upgrading through a second stripped-down card
    // would only add another visible mutation.
    expect(container.querySelector('[data-showcase-lightweight-card="true"]')).not.toBeInTheDocument();
    expect(screen.getAllByText('Creator Name')).toHaveLength(items.length);
    expect(screen.getByRole('button', { name: /save campaign frame\. 4 saves/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more actions for campaign frame/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('post')).toBe('post-1');
    });
    expect(await screen.findByRole('button', { name: /explore/i })).toBeInTheDocument();
  });

  it('keeps the complete initial card actions for authenticated viewers', () => {
    const { container } = renderShowcase([
      createShowcaseItem(),
      createShowcaseItem({ id: 'post-2', generationId: 'gen-2', title: 'Deferred Campaign' }),
    ]);

    expect(container.querySelector('[data-showcase-lightweight-card="true"]')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save campaign frame\. 4 saves/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more actions for campaign frame/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(2);
  });

  it('takes over the bootstrap prefix, then fills the rest one card per tick without scrolling', () => {
    vi.useFakeTimers();
    const items = Array.from({ length: SHOWCASE_INITIAL_RENDER_COUNT + 3 }, (_, index) => createShowcaseItem({
      id: `post-${index + 1}`,
      generationId: `gen-${index + 1}`,
      title: `Campaign ${index + 1}`,
      mediaUrl: `https://example.com/campaign-${index + 1}.jpg`,
    }));
    const firstDeferred = SHOWCASE_INITIAL_RENDER_COUNT + 1;

    renderShowcase(items);

    // The client mounts showing exactly what the bootstrap shell painted, so
    // the grid never shrinks at handoff.
    expect(screen.getByText(`Campaign ${SHOWCASE_INITIAL_RENDER_COUNT}`)).toBeInTheDocument();
    expect(screen.queryByText(`Campaign ${firstDeferred}`)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(159);
    });
    expect(screen.queryByText(`Campaign ${firstDeferred}`)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText(`Campaign ${firstDeferred}`)).toBeInTheDocument();
    expect(screen.queryByText(`Campaign ${firstDeferred + 1}`)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(160 * 2);
    });
    expect(screen.getByText(`Campaign ${items.length}`)).toBeInTheDocument();
  });

  it('reveals a complete desktop column row per tick so wide grids fill in a few frames', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(min-width: 1280px)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const items = Array.from({ length: SHOWCASE_INITIAL_RENDER_COUNT + 5 }, (_, index) => createShowcaseItem({
      id: `desktop-post-${index + 1}`,
      generationId: `desktop-gen-${index + 1}`,
      title: `Desktop Campaign ${index + 1}`,
      mediaUrl: `https://example.com/desktop-campaign-${index + 1}.jpg`,
    }));

    renderShowcase(items);

    expect(screen.getByText(`Desktop Campaign ${SHOWCASE_INITIAL_RENDER_COUNT}`)).toBeInTheDocument();
    expect(screen.queryByText(`Desktop Campaign ${SHOWCASE_INITIAL_RENDER_COUNT + 1}`)).not.toBeInTheDocument();

    // One xl row is four columns wide.
    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(screen.getByText(`Desktop Campaign ${SHOWCASE_INITIAL_RENDER_COUNT + 4}`)).toBeInTheDocument();
    expect(screen.queryByText(`Desktop Campaign ${SHOWCASE_INITIAL_RENDER_COUNT + 5}`)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(screen.getByText(`Desktop Campaign ${SHOWCASE_INITIAL_RENDER_COUNT + 5}`)).toBeInTheDocument();
  });

  it('establishes an anonymous feed session only after demand and an idle window', () => {
    vi.useFakeTimers();
    authState.session = null;
    authState.user = null;
    const idleCallbacks: IdleRequestCallback[] = [];
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    }));
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/showcase/feed?')) {
        return new Promise<Response>(() => undefined);
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const items = Array.from({ length: 5 }, (_, index) => createShowcaseItem({
      id: `anonymous-post-${index + 1}`,
      generationId: `anonymous-gen-${index + 1}`,
      title: `Anonymous Campaign ${index + 1}`,
    }));

    render(
      <ShowcaseClient
        initialFeed={createFeed(items)}
        initialCategory="all"
        initialSort="for-you"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    const drainIdleCallbacks = () => act(() => {
      // Other idle work (the debounced restore-cache write) shares this queue,
      // so drain it rather than counting entries.
      while (idleCallbacks.length > 0) {
        idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 50 });
      }
    });

    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    // Card hydration no longer waits for demand — the reveal ticks fill the
    // bootstrap — but the anonymous feed session must not start on its own.
    expect(screen.getByText('Anonymous Campaign 1')).toBeInTheDocument();
    expect(screen.getByText('Anonymous Campaign 5')).toBeInTheDocument();

    // Idle alone must not establish the session: only real demand may.
    drainIdleCallbacks();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/showcase\/feed\?/),
      expect.anything()
    );

    fireEvent.pointerDown(window);

    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/showcase\/feed\?/),
      expect.anything()
    );

    drainIdleCallbacks();

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/showcase/feed?limit=${SHOWCASE_PAGE_SIZE}&category=media`,
      expect.objectContaining({
      headers: undefined,
      })
    );
  });

  it('records an unsave only after the save API confirms removal', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/showcase/saved-state')) {
        return {
          ok: true,
          json: async () => ['post-1'],
        };
      }

      return {
        ok: true,
        json: async () => ({ success: true, isSaved: false, saveCount: 3, changed: true }),
      };
    }));

    renderShowcase(createShowcaseItem({ isSaved: true }));
    fireEvent.click(screen.getByRole('button', { name: /remove save from campaign frame/i }));

    await waitFor(() => {
      const eventRequest = vi.mocked(fetch).mock.calls.find(([input, request]) => {
        if (String(input) !== '/api/showcase/feed/events') return false;
        return JSON.parse(String(request?.body)).eventType === 'unsave';
      });
      expect(eventRequest).toBeDefined();
    });
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
    expect(unlockLink).toHaveAttribute('href', expect.stringContaining('#recipe'));
  });

  it('disables prefetching for community card detail and creator links', async () => {
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

    expect((await screen.findAllByRole('link', { name: /unlock for \$9\.00/i })).at(-1)).toHaveAttribute('data-prefetch', 'false');
    expect(await screen.findByRole('link', { name: /post details/i })).toHaveAttribute('data-prefetch', 'false');
  });

  it('prioritizes the first image preview in the public showcase grid', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [],
    })));

    renderShowcase(createShowcaseItem());

    const image = screen.getByRole('img', { name: 'Campaign Frame' });
    expect(image).toHaveAttribute('loading', 'eager');
    expect(image).toHaveAttribute('fetchpriority', 'high');
    expect(image).toHaveAttribute('decoding', 'async');
  });

  it('prioritizes the first visual preview when a text post leads the feed', async () => {
    renderShowcase([
      createShowcaseItem({
        id: 'text-post',
        title: 'Creator note',
        postFormat: 'text',
        category: 'text',
        body: 'A useful production note.',
      }),
      createShowcaseItem({
        id: 'visual-post',
        title: 'First visual frame',
      }),
    ]);

    expect(await screen.findByRole('img', { name: 'First visual frame' }))
      .toHaveAttribute('fetchpriority', 'high');
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

    fireEvent.click(await screen.findByRole('button', { name: /explore/i }));
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
    expect(await screen.findByRole('button', { name: /explore/i })).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole('button', { name: /explore/i }));

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
    const feedFetch = vi.fn(async (url: string) => {
      void url;
      return {
        ok: true,
        json: async () => ({
          items: [secondItem],
          pageInfo: {
            hasMore: false,
            nextOffset: null,
            limit: 12,
            offset: 2,
          },
        }),
      };
    });

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/feed')) {
        return feedFetch(url);
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
        initialFeed={createFeed(firstItem, { hasMore: true, nextOffset: 2, limit: 2 })}
        initialCategory="all"
        initialSort="recent"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    let loadMoreObserver: (typeof intersectionObservers)[number] | undefined;
    await waitFor(() => {
      loadMoreObserver = intersectionObservers.find((observer) => (
        observer.observedTargets.some((target) => (
          target.getAttribute('data-showcase-load-more-sentinel') === 'true'
        ))
      ));
      expect(loadMoreObserver).toBeDefined();
    });

    act(() => {
      loadMoreObserver?.trigger(true);
    });

    await waitFor(() => {
      expect(feedFetch).toHaveBeenCalledTimes(1);
    });
    expect(feedFetch).toHaveBeenCalledWith('/api/showcase/feed?limit=12&offset=2&category=media&sort=recent');

    // Appended pages ride the same reveal ticks — no scrolling required.
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

    let loadMoreObserver: (typeof intersectionObservers)[number] | undefined;
    await waitFor(() => {
      loadMoreObserver = intersectionObservers.find((observer) => (
        observer.observedTargets.some((target) => (
          target.getAttribute('data-showcase-load-more-sentinel') === 'true'
        ))
      ));
      expect(loadMoreObserver).toBeDefined();
    });

    act(() => {
      loadMoreObserver?.trigger(true);
      loadMoreObserver?.trigger(true);
    });

    await waitFor(() => {
      expect(feedFetch).toHaveBeenCalledTimes(1);
    });
    const loadMoreSkeleton = document.querySelector('[data-showcase-load-more-skeleton="true"]');
    expect(loadMoreSkeleton).toHaveAttribute('aria-hidden', 'true');
    expect(loadMoreSkeleton?.children).toHaveLength(1);

    await act(async () => {
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

    await waitFor(() => {
      expect(document.querySelector('[data-showcase-load-more-skeleton="true"]')).toBeNull();
    });
  });

  it('keeps the visible server fallback while a signed-in For You session continues by cursor', async () => {
    const fallbackItem = createShowcaseItem({
      id: 'post-fallback',
      title: 'Server fallback',
      generationId: 'gen-fallback',
    });
    const personalizedItem = createShowcaseItem({
      id: 'post-ranked',
      title: 'Ranked for you',
      generationId: 'gen-ranked',
      recommendation: {
        deliveryId: 'delivery-ranked',
        position: 0,
        reason: 'Based on your saves',
        algorithmVersion: 'feed-v1',
      },
    });
    const continuedItem = createShowcaseItem({
      id: 'post-continued',
      title: 'More for you',
      generationId: 'gen-continued',
      recommendation: {
        deliveryId: 'delivery-continued',
        position: 1,
        reason: 'Fresh creator',
        algorithmVersion: 'feed-v1',
      },
    });
    const feedFetch = vi.fn(async (url: string) => {
      if (url.includes('cursor=cursor-1')) {
        return {
          ok: true,
          json: async () => ({
            items: [continuedItem],
            feedSessionId: 'session-1',
            pageInfo: {
              hasMore: false,
              nextOffset: null,
              nextCursor: null,
              limit: 12,
              offset: 12,
            },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          items: [personalizedItem],
          feedSessionId: 'session-1',
          pageInfo: {
            hasMore: true,
            nextOffset: null,
            nextCursor: 'cursor-1',
            limit: 12,
            offset: 0,
          },
        }),
      };
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/feed?')) {
        return feedFetch(url);
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
        initialFeed={createFeed(fallbackItem, { hasMore: true, nextOffset: 12 })}
        initialCategory="all"
        initialSort="for-you"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/showcase/feed?limit=12&category=media', expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }));
    });
    expect(screen.getByText('Server fallback')).toBeInTheDocument();

    expect(await screen.findByText('Ranked for you')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'Server fallback',
      'Ranked for you',
    ]);

    let loadMoreObserver: (typeof intersectionObservers)[number] | undefined;
    await waitFor(() => {
      loadMoreObserver = intersectionObservers.findLast((observer) => (
        observer.observedTargets.some((target) => (
          target.getAttribute('data-showcase-load-more-sentinel') === 'true'
          && target.isConnected
        ))
      ));
      expect(loadMoreObserver).toBeDefined();
    });
    act(() => {
      loadMoreObserver?.trigger(true);
    });

    await waitFor(() => {
      expect(feedFetch).toHaveBeenCalledWith(expect.stringContaining('cursor=cursor-1'));
    });

    expect(await screen.findByText('More for you')).toBeInTheDocument();
    expect(feedFetch).toHaveBeenCalledWith(expect.stringContaining('cursor=cursor-1'));
  });

  it('keeps the anonymous fallback idle until interaction establishes a feed session', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => {
      callback({
        didTimeout: false,
        timeRemaining: () => 50,
      });
      return 1;
    }));
    authState.session = null;
    authState.user = null;
    const anonymousItem = createShowcaseItem({
      id: 'post-anonymous-ranked',
      title: 'Anonymous discovery',
      generationId: 'gen-anonymous-ranked',
      recommendation: {
        deliveryId: 'delivery-anonymous',
        position: 0,
        reason: 'Popular with new creators',
        algorithmVersion: 'feed-v1',
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/showcase/feed?')) {
        return {
          ok: true,
          json: async () => ({
            items: [anonymousItem],
            feedSessionId: 'anonymous-session-1',
            pageInfo: {
              hasMore: false,
              nextOffset: null,
              nextCursor: null,
              limit: SHOWCASE_PAGE_SIZE,
              offset: 0,
            },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({ success: true }),
      };
    }));

    render(
      <ShowcaseClient
        initialFeed={createFeed(createShowcaseItem({ title: 'Server fallback' }))}
        initialCategory="all"
        initialSort="for-you"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(vi.mocked(fetch).mock.calls.some(([input]) => (
      String(input).startsWith('/api/showcase/feed?')
    ))).toBe(false);

    fireEvent.pointerDown(window);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetch).toHaveBeenCalledWith(
      `/api/showcase/feed?limit=${SHOWCASE_PAGE_SIZE}&category=media`,
      expect.objectContaining({
        headers: undefined,
      })
    );

    // The card already on screen keeps its slot; the ranked result lands
    // behind it rather than replacing what the viewer is looking at.
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'Server fallback',
      'Anonymous discovery',
    ]);
  });

  it('retries a transient anonymous feed refresh and keeps visible cards in place', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => {
      callback({
        didTimeout: false,
        timeRemaining: () => 50,
      });
      return 1;
    }));
    authState.session = null;
    authState.user = null;
    const rankedItem = createShowcaseItem({
      id: 'post-retry-ranked',
      title: 'Recovered discovery',
      generationId: 'gen-retry-ranked',
      recommendation: {
        deliveryId: 'delivery-retry',
        position: 0,
        reason: 'Recovered ranking',
        algorithmVersion: 'feed-v1',
      },
    });
    const feedFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Temporarily unavailable' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [rankedItem],
          feedSessionId: 'anonymous-session-retry',
          pageInfo: {
            hasMore: false,
            nextOffset: null,
            nextCursor: null,
            limit: SHOWCASE_PAGE_SIZE,
            offset: 0,
          },
        }),
      } as Response);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/showcase/feed?')) {
        return feedFetch();
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);
    }));
    const fallbackItems = Array.from({ length: 2 }, (_, index) => createShowcaseItem({
      id: `retry-fallback-${index + 1}`,
      generationId: `retry-fallback-gen-${index + 1}`,
      title: `Retry Fallback ${index + 1}`,
    }));

    render(
      <ShowcaseClient
        initialFeed={createFeed(fallbackItems)}
        initialCategory="all"
        initialSort="for-you"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    await act(async () => Promise.resolve());
    expect(feedFetch).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'ArrowDown' });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(feedFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Retry Fallback 1')).toBeInTheDocument();
    expect(screen.getByText('Retry Fallback 2')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Both fallback cards keep their slots across the retry, and the
    // recovered ranking lands behind them.
    expect(feedFetch).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'Retry Fallback 1',
      'Retry Fallback 2',
      'Recovered discovery',
    ]);
  });

  it('optimistically removes a post after Not interested and records ranked feedback', async () => {
    const rankedItem = createShowcaseItem({
      recommendation: {
        deliveryId: 'delivery-1',
        position: 3,
        reason: 'Because you save product photography',
        algorithmVersion: 'feed-v1',
      },
    });
    const rankedFeed = {
      ...createFeed(rankedItem),
      feedSessionId: 'feed-session-1',
    };

    render(
      <ShowcaseClient
        initialFeed={rankedFeed}
        initialCategory="all"
        initialSort="recent"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /not interested/i }));

    expect(screen.queryByText('Campaign Frame')).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(/show you fewer posts like that/i);

    const eventRequest = vi.mocked(fetch).mock.calls.find(([input]) => (
      String(input) === '/api/showcase/feed/events'
    ));
    expect(eventRequest).toBeDefined();
    expect(JSON.parse(String(eventRequest?.[1]?.body))).toEqual(expect.objectContaining({
      feedSessionId: 'feed-session-1',
      deliveryId: 'delivery-1',
      postId: 'post-1',
      eventType: 'not_interested',
      position: 3,
      sourceSurface: 'showcase',
    }));
  });

  it('describes successful anonymous feedback as limited to this visit', async () => {
    authState.session = null;
    authState.user = null;
    renderShowcase(createShowcaseItem());

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /not interested/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/post removed for this visit/i);
  });

  it('restores an optimistically hidden post when feedback cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let resolveFeedback: (response: { ok: boolean }) => void = () => undefined;
    const feedbackResponse = new Promise<{ ok: boolean }>((resolve) => {
      resolveFeedback = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/showcase/feed/events') {
        return feedbackResponse;
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
    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /not interested/i }));
    expect(screen.queryByText('Campaign Frame')).not.toBeInTheDocument();

    resolveFeedback({ ok: false });

    expect(await screen.findByText('Campaign Frame')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/post was restored/i);
  });

  // The safety rows the app's Explore card and the web's feed card carry, sent
  // and worded as the feed card's are. Explore's tile and its reel had only the
  // two feed preferences until 2026-10-10.
  const otherCreator = { id: 'creator-2', username: 'second-creator', name: 'Second Creator', avatar: null };

  function tileMenuRows(title: string) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`more actions for ${title}`, 'i') }));
    return screen.getAllByRole('menuitem').map((row) => row.querySelector('.font-semibold')?.textContent);
  }

  function chooseFromTileMenu(title: string, row: RegExp) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`more actions for ${title}`, 'i') }));
    fireEvent.click(screen.getByRole('menuitem', { name: row }));
  }

  function requestTo(path: string) {
    return vi.mocked(fetch).mock.calls.find(([input]) => String(input) === path);
  }

  it("offers a tile the feed card's five rows", () => {
    renderShowcase(createShowcaseItem());

    expect(tileMenuRows('Campaign Frame'))
      .toEqual(['Not interested', 'Hide @creator-name', 'Report content', 'Report user', 'Block user']);
  });

  it("offers Not interested and nothing else on the viewer's own post", () => {
    renderShowcase(createShowcaseItem({ creator: { id: 'user-1', username: 'me', name: 'Me', avatar: null } }));

    expect(tileMenuRows('Campaign Frame')).toEqual(['Not interested']);
  });

  it('draws the open menu in the page body, where a short tile cannot clip its five rows', () => {
    renderShowcase(createShowcaseItem());
    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));

    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toContain('fixed');
  });

  it('reports a post after a confirmation, removes it from the grid and says so', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderShowcase([
      createShowcaseItem(),
      createShowcaseItem({ id: 'post-2', title: 'Second Frame', creator: otherCreator }),
    ]);

    chooseFromTileMenu('Campaign Frame', /report content/i);

    expect(await screen.findByRole('status')).toHaveTextContent('Content reported and removed from your feed.');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Report content?'));
    const [, init] = requestTo('/api/posts/post-1/report') ?? [];
    expect(init).toMatchObject({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) });
    expect(JSON.parse(String(init?.body))).toEqual({
      reason: 'unsafe_content',
      details: 'Reported from the web Explore grid.',
    });
    expect(screen.queryByText('Campaign Frame')).not.toBeInTheDocument();
    expect(screen.getByText('Second Frame')).toBeInTheDocument();
  });

  it('sends nothing and keeps the post when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderShowcase(createShowcaseItem());

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /report content/i }));
    });

    expect(requestTo('/api/posts/post-1/report')).toBeUndefined();
    expect(screen.getByText('Campaign Frame')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps the post and says why when the report is refused', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/posts/post-1/report') {
        return { ok: false, status: 400, json: async () => ({ error: 'You cannot report your own post.' }) };
      }
      return { ok: true, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { success: true }) };
    }));
    renderShowcase(createShowcaseItem());

    chooseFromTileMenu('Campaign Frame', /report content/i);

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Could not report this post. You cannot report your own post.');
    expect(screen.getByText('Campaign Frame')).toBeInTheDocument();
  });

  it('asks a signed-out viewer to sign in before reporting or blocking, and brings them back to Explore', () => {
    authState.session = null;
    authState.user = null;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderShowcase(createShowcaseItem());

    chooseFromTileMenu('Campaign Frame', /report content/i);
    chooseFromTileMenu('Campaign Frame', /report user/i);
    chooseFromTileMenu('Campaign Frame', /block user/i);

    expect(mockPush.mock.calls).toEqual([
      ['/login?returnUrl=%2Fshowcase'],
      ['/login?returnUrl=%2Fshowcase'],
      ['/login?returnUrl=%2Fshowcase'],
    ]);
    expect(confirm).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => /\/report|\/moderation\//.test(String(input)))).toEqual([]);
  });

  it('reports the creator with the reason and surface the feed card sends, and removes nothing', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderShowcase(createShowcaseItem());

    chooseFromTileMenu('Campaign Frame', /report user/i);

    expect(await screen.findByRole('status')).toHaveTextContent('Creator reported. Our moderation team will take a look.');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Report this creator?'));
    const [, init] = requestTo('/api/moderation/reports') ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      targetType: 'user',
      targetId: 'creator-1',
      reason: 'harassment',
      sourceSurface: 'showcase',
    });
    expect(screen.getByText('Campaign Frame')).toBeInTheDocument();
  });

  it('blocks the creator after a confirmation and drops every post of theirs from the grid', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderShowcase([
      createShowcaseItem(),
      createShowcaseItem({ id: 'post-2', title: 'Second Frame', creator: otherCreator }),
      createShowcaseItem({ id: 'post-3', title: 'Third Frame' }),
    ]);

    chooseFromTileMenu('Campaign Frame', /block user/i);

    expect(await screen.findByRole('status'))
      .toHaveTextContent('Creator Name is blocked. Their posts are gone from your feed.');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Block this creator?'));
    expect(requestTo('/api/moderation/blocks/creator-1')?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
    });
    expect(screen.queryByText('Campaign Frame')).not.toBeInTheDocument();
    expect(screen.queryByText('Third Frame')).not.toBeInTheDocument();
    expect(screen.getByText('Second Frame')).toBeInTheDocument();
  });

  it('does not bring a reported post back when a later page carries it again', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const reportedItem = createShowcaseItem();
    const keptItem = createShowcaseItem({ id: 'post-keep', title: 'Kept Frame', creator: otherCreator });
    const laterItem = createShowcaseItem({ id: 'post-later', title: 'Later Frame', creator: otherCreator });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/feed?')) {
        return {
          ok: true,
          json: async () => ({
            items: [reportedItem, laterItem],
            pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 2 },
          }),
        };
      }
      return { ok: true, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { success: true }) };
    }));
    render(
      <ShowcaseClient
        initialFeed={createFeed([reportedItem, keptItem], { hasMore: true, nextOffset: 2, limit: 2 })}
        initialCategory="all"
        initialSort="recent"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    chooseFromTileMenu('Campaign Frame', /report content/i);
    expect(await screen.findByRole('status')).toHaveTextContent('Content reported and removed from your feed.');

    let loadMoreObserver: (typeof intersectionObservers)[number] | undefined;
    await waitFor(() => {
      loadMoreObserver = intersectionObservers.find((observer) => (
        observer.observedTargets.some((target) => (
          target.getAttribute('data-showcase-load-more-sentinel') === 'true'
        ))
      ));
      expect(loadMoreObserver).toBeDefined();
    });
    act(() => {
      loadMoreObserver?.trigger(true);
    });

    expect(await screen.findByText('Later Frame')).toBeInTheDocument();
    expect(screen.getByText('Kept Frame')).toBeInTheDocument();
    expect(screen.queryByText('Campaign Frame')).not.toBeInTheDocument();
  });

  // A creator can be blocked on their own page, which then sends the viewer
  // here. This page's first rows are the server's for everyone, so the creator
  // was back on screen under the line that said their posts were gone.
  it('does not draw a creator who was blocked on another page a moment ago, from its first page or a later one', async () => {
    const theirFirstPost = createShowcaseItem();
    const theirLaterPost = createShowcaseItem({ id: 'post-theirs-later', title: 'Third Frame' });
    const keptItem = createShowcaseItem({ id: 'post-keep', title: 'Kept Frame', creator: otherCreator });
    const laterItem = createShowcaseItem({ id: 'post-later', title: 'Later Frame', creator: otherCreator });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/feed?')) {
        return {
          ok: true,
          json: async () => ({
            items: [theirLaterPost, laterItem],
            pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 2 },
          }),
        };
      }
      return { ok: true, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { success: true }) };
    }));
    // What a block does wherever it is made (`blockCreatorAfterConfirmation`).
    takeBlockedCreatorOffClientFeeds('creator-1');

    render(
      <ShowcaseClient
        initialFeed={createFeed([theirFirstPost, keptItem], { hasMore: true, nextOffset: 2, limit: 2 })}
        initialCategory="all"
        initialSort="recent"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    expect(await screen.findByText('Kept Frame')).toBeInTheDocument();
    expect(screen.queryByText('Campaign Frame')).not.toBeInTheDocument();

    let loadMoreObserver: (typeof intersectionObservers)[number] | undefined;
    await waitFor(() => {
      loadMoreObserver = intersectionObservers.find((observer) => (
        observer.observedTargets.some((target) => (
          target.getAttribute('data-showcase-load-more-sentinel') === 'true'
        ))
      ));
      expect(loadMoreObserver).toBeDefined();
    });
    act(() => {
      loadMoreObserver?.trigger(true);
    });

    expect(await screen.findByText('Later Frame')).toBeInTheDocument();
    expect(screen.queryByText('Third Frame')).not.toBeInTheDocument();
    expect(screen.queryByText('Campaign Frame')).not.toBeInTheDocument();
  });

  it('names the reel as the surface when a creator is reported from it, as the app does', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window.history, 'pushState');
    renderShowcase(createShowcaseItem());

    fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));
    const reel = await screen.findByRole('dialog');
    fireEvent.click(await within(reel).findByRole('button', { name: /more actions for campaign frame/i }));
    fireEvent.click(within(reel).getByRole('menuitem', { name: /report user/i }));

    expect(await screen.findByText('Creator reported. Our moderation team will take a look.')).toBeInTheDocument();
    expect(JSON.parse(String(requestTo('/api/moderation/reports')?.[1]?.body))).toEqual({
      targetType: 'user',
      targetId: 'creator-1',
      reason: 'harassment',
      sourceSurface: 'showcase-reel',
    });
    // Reporting a creator takes nothing away: the reel stays on the post.
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /more actions for campaign frame/i }))
      .toBeInTheDocument();
  });

  it('offers the same rows in the reel, and moves on to the next post when the open one is reported', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window.history, 'pushState');
    renderShowcase([
      createShowcaseItem(),
      createShowcaseItem({ id: 'post-2', title: 'Second Frame', creator: otherCreator }),
    ]);

    fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));
    const reel = await screen.findByRole('dialog');
    fireEvent.click(await within(reel).findByRole('button', { name: /more actions for campaign frame/i }));
    expect(within(reel).getAllByRole('menuitem').map((row) => row.querySelector('.font-semibold')?.textContent))
      .toEqual(['Not interested', 'Hide @creator-name', 'Report content', 'Report user', 'Block user']);

    fireEvent.click(within(reel).getByRole('menuitem', { name: /report content/i }));

    // By its words: the reel has a status line of its own.
    expect(await screen.findByText('Content reported and removed from your feed.')).toBeInTheDocument();
    expect(JSON.parse(String(requestTo('/api/posts/post-1/report')?.[1]?.body))).toEqual({
      reason: 'unsafe_content',
      details: 'Reported from the web reel.',
    });
    // The reel stays open on the post that followed the reported one.
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('post')).toBe('post-2');
    });
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /more actions for second frame/i }))
      .toBeInTheDocument();
  });

  it("offers the reel Not interested and nothing else on the viewer's own post", async () => {
    renderShowcase(createShowcaseItem({ creator: { id: 'user-1', username: 'me', name: 'Me', avatar: null } }));

    fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));
    const reel = await screen.findByRole('dialog');
    fireEvent.click(await within(reel).findByRole('button', { name: /more actions for campaign frame/i }));

    expect(within(reel).getAllByRole('menuitem').map((row) => row.querySelector('.font-semibold')?.textContent))
      .toEqual(['Not interested']);
  });

  // Explore's first page is the server's for everyone, and the viewer's own feed
  // is merged in under the rows already drawn. A creator the viewer had blocked
  // or hidden was back in those rows after every reload.
  describe("what the viewer's own feed leaves out of the first page", () => {
    const blockedCreator = { id: 'creator-blocked', username: 'blocked', name: 'Blocked', avatar: null };
    const hiddenCreator = { id: 'creator-hidden', username: 'hidden', name: 'Hidden', avatar: null };
    const theirs = createShowcaseItem({ id: 'post-blocked', title: 'Blocked Frame', creator: blockedCreator });
    const hiddenCreators = createShowcaseItem({ id: 'post-hidden-creator', title: 'Hidden Creator Frame', creator: hiddenCreator });
    const notInterested = createShowcaseItem({ id: 'post-not-interested', title: 'Not Interested Frame', creator: otherCreator });
    const kept = createShowcaseItem({ id: 'post-kept', title: 'Kept Frame', creator: otherCreator });
    const answer = {
      blockedCreatorIds: [blockedCreator.id],
      hiddenCreatorIds: [hiddenCreator.id],
      hiddenPostIds: [notInterested.id],
    };

    function answerRequests({ exclusions = answer, ok = true, feedItems = [] as ShowcaseFeedItem[] } = {}) {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/showcase/viewer-exclusions') {
          return { ok, status: ok ? 200 : 500, json: async () => (ok ? exclusions : { error: 'unavailable' }) };
        }
        if (url.startsWith('/api/showcase/feed?')) {
          return {
            ok: true,
            json: async () => ({
              items: feedItems,
              pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 4 },
            }),
          };
        }
        return { ok: true, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { success: true }) };
      }));
    }
    const exclusionRequests = () => vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input) === '/api/showcase/viewer-exclusions');
    const firstPage = (sort: 'recent' | 'for-you', feed: ShowcaseFeedPage) => (
      <ShowcaseClient
        initialFeed={feed}
        initialCategory="all"
        initialSort={sort}
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );
    const renderFirstPage = (sort: 'recent' | 'for-you', pageInfo: Partial<ShowcaseFeedPage['pageInfo']> = {}) => render(
      firstPage(sort, createFeed([theirs, hiddenCreators, notInterested, kept], pageInfo))
    );

    it('asks the server about the posts it drew, once, as the signed-in viewer', async () => {
      answerRequests();
      renderFirstPage('recent');

      await waitFor(() => expect(exclusionRequests()).toHaveLength(1));
      const [, init] = exclusionRequests()[0];
      expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer test-token' } });
      expect(JSON.parse(String(init?.body))).toEqual({
        items: [
          { postId: 'post-blocked', creatorId: 'creator-blocked' },
          { postId: 'post-hidden-creator', creatorId: 'creator-hidden' },
          { postId: 'post-not-interested', creatorId: 'creator-2' },
          { postId: 'post-kept', creatorId: 'creator-2' },
        ],
      });
    });

    // Until sign-in has settled the page does not know whose feed to ask about.
    it('waits until it is known who is looking before it asks', async () => {
      answerRequests();
      authState.isLoading = true;
      const feed = createFeed([theirs, hiddenCreators, notInterested, kept]);
      const view = render(firstPage('recent', feed));
      await act(async () => Promise.resolve());
      expect(exclusionRequests()).toHaveLength(0);
      expect(screen.getByText('Blocked Frame')).toBeInTheDocument();

      authState.isLoading = false;
      view.rerender(firstPage('recent', feed));

      await waitFor(() => expect(exclusionRequests()).toHaveLength(1));
      await waitFor(() => expect(screen.queryByText('Blocked Frame')).not.toBeInTheDocument());
    });

    // The viewer is looking at it. It goes when the reel is closed.
    it('leaves the post that is open in the reel where it is, takes the rest, and takes it too once the reel is closed', async () => {
      vi.spyOn(window.history, 'pushState');
      const theirsToo = createShowcaseItem({ id: 'post-blocked-2', title: 'Other Blocked Frame', creator: blockedCreator });
      let answerNow: () => void = () => undefined;
      const untilAsked = new Promise<void>((resolve) => { answerNow = resolve; });
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/showcase/viewer-exclusions') {
          await untilAsked;
          return { ok: true, status: 200, json: async () => answer };
        }
        return { ok: true, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { success: true }) };
      }));
      render(firstPage('recent', createFeed([theirs, theirsToo, kept])));

      fireEvent.click(screen.getByRole('img', { name: 'Blocked Frame' }));
      const reel = await screen.findByRole('dialog');
      expect(await within(reel).findByRole('button', { name: /more actions for blocked frame/i })).toBeInTheDocument();
      await act(async () => {
        answerNow();
        await Promise.resolve();
      });

      await waitFor(() => expect(screen.queryByText('Other Blocked Frame')).not.toBeInTheDocument());
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: /more actions for blocked frame/i }))
        .toBeInTheDocument();
      expect(screen.getByText('Kept Frame')).toBeInTheDocument();

      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Explore' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.queryByRole('img', { name: 'Blocked Frame' })).not.toBeInTheDocument());
      expect(screen.getByRole('img', { name: 'Kept Frame' })).toBeInTheDocument();
    });

    it("takes a blocked creator's posts out on any lane, and leaves Hide and Not interested to For you", async () => {
      answerRequests();
      renderFirstPage('recent');

      await waitFor(() => expect(screen.queryByText('Blocked Frame')).not.toBeInTheDocument());
      // The server keeps the viewer's feed preferences out of For you only, so Recent shows them, as its later pages do.
      expect(screen.getByText('Hidden Creator Frame')).toBeInTheDocument();
      expect(screen.getByText('Not Interested Frame')).toBeInTheDocument();
      expect(screen.getByText('Kept Frame')).toBeInTheDocument();
    });

    it('takes out what the viewer hid or marked not interested as well, on For you', async () => {
      // The viewer's own feed arrives too, and carries none of them.
      answerRequests({ feedItems: [kept] });
      renderFirstPage('for-you');

      await waitFor(() => expect(screen.queryByText('Blocked Frame')).not.toBeInTheDocument());
      expect(screen.queryByText('Hidden Creator Frame')).not.toBeInTheDocument();
      expect(screen.queryByText('Not Interested Frame')).not.toBeInTheDocument();
      expect(screen.getByText('Kept Frame')).toBeInTheDocument();
    });

    it('keeps them out of a later page that carries them again', async () => {
      const theirSecond = createShowcaseItem({ id: 'post-blocked-2', title: 'Blocked Again Frame', creator: blockedCreator });
      const later = createShowcaseItem({ id: 'post-later', title: 'Later Frame', creator: otherCreator });
      answerRequests({ feedItems: [theirSecond, later] });
      renderFirstPage('recent', { hasMore: true, nextOffset: 4, limit: 4 });
      await waitFor(() => expect(screen.queryByText('Blocked Frame')).not.toBeInTheDocument());

      let loadMoreObserver: (typeof intersectionObservers)[number] | undefined;
      await waitFor(() => {
        loadMoreObserver = intersectionObservers.find((observer) => (
          observer.observedTargets.some((target) => (
            target.getAttribute('data-showcase-load-more-sentinel') === 'true'
          ))
        ));
        expect(loadMoreObserver).toBeDefined();
      });
      act(() => {
        loadMoreObserver?.trigger(true);
      });

      expect(await screen.findByText('Later Frame')).toBeInTheDocument();
      expect(screen.queryByText('Blocked Again Frame')).not.toBeInTheDocument();
    });

    it('asks nothing for a signed-out viewer, who has blocked and hidden nobody', async () => {
      authState.session = null;
      authState.user = null;
      answerRequests();
      renderFirstPage('recent');

      expect(await screen.findByText('Blocked Frame')).toBeInTheDocument();
      await act(async () => Promise.resolve());
      expect(exclusionRequests()).toHaveLength(0);
    });

    it('keeps what it drew when the server cannot answer', async () => {
      answerRequests({ ok: false });
      renderFirstPage('recent');

      await waitFor(() => expect(exclusionRequests()).toHaveLength(1));
      await act(async () => Promise.resolve());
      expect(screen.getByText('Blocked Frame')).toBeInTheDocument();
      expect(screen.getByText('Kept Frame')).toBeInTheDocument();
    });

    it('does not draw them at all the next time Explore opens in this tab', async () => {
      answerRequests();
      const first = renderFirstPage('for-you');
      await waitFor(() => expect(screen.queryByText('Blocked Frame')).not.toBeInTheDocument());
      first.unmount();
      // No kept copy of the page: what is remembered is the server's answer.
      clearShowcaseSnapshotsOnly();
      answerRequests({ exclusions: { blockedCreatorIds: [], hiddenCreatorIds: [], hiddenPostIds: [] }, ok: false });

      renderFirstPage('for-you');

      expect(screen.getByText('Kept Frame')).toBeInTheDocument();
      expect(screen.queryByText('Blocked Frame')).not.toBeInTheDocument();
      expect(screen.queryByText('Hidden Creator Frame')).not.toBeInTheDocument();
      expect(screen.queryByText('Not Interested Frame')).not.toBeInTheDocument();
    });

    // Signing out, or in as someone else, does not reload the page: the tab
    // went on leaving the last viewer's blocks out of the next one's Explore.
    it('draws the whole page for a visitor who has signed out, and for another viewer, in the same tab', async () => {
      answerRequests();
      const first = renderFirstPage('for-you');
      await waitFor(() => expect(screen.queryByText('Blocked Frame')).not.toBeInTheDocument());
      first.unmount();
      clearShowcaseSnapshotsOnly();

      authState.session = null;
      authState.user = null;
      const signedOut = renderFirstPage('for-you');
      for (const title of ['Blocked Frame', 'Hidden Creator Frame', 'Not Interested Frame', 'Kept Frame']) {
        expect(screen.getByText(title)).toBeInTheDocument();
      }
      signedOut.unmount();
      clearShowcaseSnapshotsOnly();

      // The next viewer has blocked and hidden nobody, and the server says so.
      authState.session = { access_token: 'other-token', user: { id: 'user-2' } };
      authState.user = { id: 'user-2' };
      answerRequests({ exclusions: { blockedCreatorIds: [], hiddenCreatorIds: [], hiddenPostIds: [] } });
      renderFirstPage('for-you');
      await waitFor(() => expect(exclusionRequests()).toHaveLength(1));
      await act(async () => Promise.resolve());
      for (const title of ['Blocked Frame', 'Hidden Creator Frame', 'Not Interested Frame', 'Kept Frame']) {
        expect(screen.getByText(title)).toBeInTheDocument();
      }
    });

    it('forgets the first viewer for good once someone else has looked', async () => {
      answerRequests();
      const first = renderFirstPage('for-you');
      await waitFor(() => expect(screen.queryByText('Blocked Frame')).not.toBeInTheDocument());
      first.unmount();
      clearShowcaseSnapshotsOnly();

      authState.session = null;
      authState.user = null;
      renderFirstPage('for-you').unmount();
      clearShowcaseSnapshotsOnly();

      // The first viewer signs in again: the page asks afresh, and until the
      // answer comes it draws what the server sent.
      authState.session = { access_token: 'test-token', user: { id: 'user-1' } };
      authState.user = { id: 'user-1' };
      answerRequests({ ok: false });
      renderFirstPage('for-you');

      expect(screen.getByText('Blocked Frame')).toBeInTheDocument();
      await waitFor(() => expect(exclusionRequests()).toHaveLength(1));
    });
  });
});
