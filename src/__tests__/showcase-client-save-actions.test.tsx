import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseClient from '@/app/showcase/ShowcaseClient';
import {
  SHOWCASE_INITIAL_PAGE_SIZE,
  type ShowcaseFeedItem,
  type ShowcaseFeedPage,
} from '@/lib/showcase';
import type { SourceToolOption } from '@/lib/source-tools';

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

vi.mock('@/app/components/AuthProvider', () => ({
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

  it('uses a poster-only anonymous shell for the single critical visual card and opens the reel', async () => {
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

    expect(container.querySelector('[data-showcase-lightweight-card="true"]')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Campaign Frame' })).toHaveAttribute(
      'src',
      'data:image/webp;base64,UklGRg=='
    );
    expect(screen.getByText('Creator Name')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save campaign frame/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more actions for campaign frame/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open campaign frame in viewer/i }));

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('post')).toBe('post-1');
    });
    expect(container.querySelector('[data-showcase-lightweight-card="true"]')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /feed/i })).toBeInTheDocument();
  });

  it('keeps the complete initial card actions for authenticated viewers', () => {
    const { container } = renderShowcase([
      createShowcaseItem(),
      createShowcaseItem({ id: 'post-2', generationId: 'gen-2', title: 'Deferred Campaign' }),
    ]);

    expect(container.querySelector('[data-showcase-lightweight-card="true"]')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save campaign frame\. 4 saves/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more actions for campaign frame/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
  });

  it('restores the complete anonymous card when deferred rendering begins', async () => {
    authState.session = null;
    authState.user = null;
    const { container } = renderShowcase([
      createShowcaseItem(),
      createShowcaseItem({ id: 'post-2', generationId: 'gen-2', title: 'Deferred Campaign' }),
    ]);

    expect(container.querySelector('[data-showcase-lightweight-card="true"]')).toBeInTheDocument();
    const deferredObserver = intersectionObservers.find((observer) => (
      observer.observedTargets.some((target) => (
        target.getAttribute('data-showcase-deferred-reveal-sentinel') === 'true'
      ))
    ));

    act(() => {
      deferredObserver?.trigger(true);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-showcase-lightweight-card="true"]')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /save campaign frame\. 4 saves/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more actions for campaign frame/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(2);
  });

  it('hydrates only the priority card and reveals one deferred card per sentinel approach', async () => {
    const items = Array.from({ length: 5 }, (_, index) => createShowcaseItem({
      id: `post-${index + 1}`,
      generationId: `gen-${index + 1}`,
      title: `Campaign ${index + 1}`,
      mediaUrl: `https://example.com/campaign-${index + 1}.jpg`,
    }));

    renderShowcase(items);

    expect(screen.getByText('Campaign 1')).toBeInTheDocument();
    expect(screen.queryByText('Campaign 2')).not.toBeInTheDocument();

    const deferredObserver = intersectionObservers.find((observer) => (
      observer.observedTargets.some((target) => (
        target.getAttribute('data-showcase-deferred-reveal-sentinel') === 'true'
      ))
    ));
    expect(deferredObserver?.rootMargin).toBe('200px 0px');

    act(() => {
      deferredObserver?.trigger(true);
    });
    expect(await screen.findByText('Campaign 2')).toBeInTheDocument();
    expect(screen.queryByText('Campaign 3')).not.toBeInTheDocument();

    // Repeated intersecting callbacks for the same boundary entry must not
    // restart the old immediate reveal chain.
    act(() => {
      deferredObserver?.trigger(true);
    });
    expect(screen.queryByText('Campaign 3')).not.toBeInTheDocument();

    act(() => {
      deferredObserver?.trigger(false);
      deferredObserver?.trigger(true);
    });
    expect(await screen.findByText('Campaign 3')).toBeInTheDocument();
    expect(screen.queryByText('Campaign 4')).not.toBeInTheDocument();
  });

  it('reveals a complete desktop column row so the sentinel cannot stall in a partial row', async () => {
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
    const items = Array.from({ length: 6 }, (_, index) => createShowcaseItem({
      id: `desktop-post-${index + 1}`,
      generationId: `desktop-gen-${index + 1}`,
      title: `Desktop Campaign ${index + 1}`,
      mediaUrl: `https://example.com/desktop-campaign-${index + 1}.jpg`,
    }));

    renderShowcase(items);

    expect(screen.getByText('Desktop Campaign 1')).toBeInTheDocument();
    expect(screen.queryByText('Desktop Campaign 2')).not.toBeInTheDocument();

    const deferredObserver = intersectionObservers.find((observer) => (
      observer.observedTargets.some((target) => (
        target.getAttribute('data-showcase-deferred-reveal-sentinel') === 'true'
      ))
    ));
    act(() => {
      deferredObserver?.trigger(true);
    });

    expect(await screen.findByText('Desktop Campaign 5')).toBeInTheDocument();
    expect(screen.queryByText('Desktop Campaign 6')).not.toBeInTheDocument();

    act(() => {
      deferredObserver?.trigger(false);
      deferredObserver?.trigger(true);
    });
    expect(await screen.findByText('Desktop Campaign 6')).toBeInTheDocument();
  });

  it('keeps startup quiet for five seconds and reveals at a long fallback cadence', () => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', undefined);
    const items = Array.from({ length: 3 }, (_, index) => createShowcaseItem({
      id: `fallback-post-${index + 1}`,
      generationId: `fallback-gen-${index + 1}`,
      title: `Fallback Campaign ${index + 1}`,
    }));

    renderShowcase(items);

    expect(screen.getByText('Fallback Campaign 1')).toBeInTheDocument();
    expect(screen.queryByText('Fallback Campaign 2')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByText('Fallback Campaign 2')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByText('Fallback Campaign 2')).toBeInTheDocument();
    expect(screen.queryByText('Fallback Campaign 3')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(screen.queryByText('Fallback Campaign 3')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText('Fallback Campaign 3')).toBeInTheDocument();
  });

  it('establishes an anonymous feed session after demand and idle without hydrating hidden cards', () => {
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

    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(screen.getByText('Anonymous Campaign 1')).toBeInTheDocument();
    expect(screen.queryByText('Anonymous Campaign 2')).not.toBeInTheDocument();
    expect(idleCallbacks).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/showcase\/feed\?/),
      expect.anything()
    );

    fireEvent.pointerDown(window);

    expect(idleCallbacks).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/showcase\/feed\?/),
      expect.anything()
    );

    act(() => {
      idleCallbacks.shift()?.({
        didTimeout: false,
        timeRemaining: () => 50,
      });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/showcase/feed?limit=${SHOWCASE_INITIAL_PAGE_SIZE}`,
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
    expect(unlockLink).toHaveAttribute('href', expect.stringContaining('#resources'));
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
    expect(await screen.findByRole('link', { name: /open full page/i })).toHaveAttribute('data-prefetch', 'false');
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

    const deferredObserver = intersectionObservers.find((observer) => (
      observer.observedTargets.some((target) => (
        target.getAttribute('data-showcase-deferred-reveal-sentinel') === 'true'
      ))
    ));
    act(() => {
      deferredObserver?.trigger(true);
    });

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

    fireEvent.click(await screen.findByRole('button', { name: /feed/i }));
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
    expect(await screen.findByRole('button', { name: /feed/i })).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole('button', { name: /feed/i }));

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
    expect(feedFetch).toHaveBeenCalledWith('/api/showcase/feed?limit=12&offset=2&sort=recent');

    let deferredObserver: (typeof intersectionObservers)[number] | undefined;
    await waitFor(() => {
      deferredObserver = intersectionObservers.findLast((observer) => (
        observer.observedTargets.some((target) => (
          target.getAttribute('data-showcase-deferred-reveal-sentinel') === 'true'
        ))
      ));
      expect(deferredObserver).toBeDefined();
    });
    act(() => {
      deferredObserver?.trigger(true);
    });

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

  it('replaces the server fallback with a signed-in For You session and continues by cursor', async () => {
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

    expect(await screen.findByText('Ranked for you')).toBeInTheDocument();
    expect(screen.queryByText('Server fallback')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/showcase/feed?limit=12', expect.objectContaining({
      headers: { Authorization: 'Bearer test-token' },
    }));

    let loadMoreObserver: (typeof intersectionObservers)[number] | undefined;
    await waitFor(() => {
      loadMoreObserver = intersectionObservers.findLast((observer) => (
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
      expect(feedFetch).toHaveBeenCalledWith(expect.stringContaining('cursor=cursor-1'));
    });

    let deferredObserver: (typeof intersectionObservers)[number] | undefined;
    await waitFor(() => {
      deferredObserver = intersectionObservers.findLast((observer) => (
        observer.observedTargets.some((target) => (
          target.getAttribute('data-showcase-deferred-reveal-sentinel') === 'true'
        ))
      ));
      expect(deferredObserver).toBeDefined();
    });
    act(() => {
      deferredObserver?.trigger(true);
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
              limit: SHOWCASE_INITIAL_PAGE_SIZE,
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

    expect(screen.getByText('Anonymous discovery')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      `/api/showcase/feed?limit=${SHOWCASE_INITIAL_PAGE_SIZE}`,
      expect.objectContaining({
        headers: undefined,
      })
    );
  });

  it('retries a transient anonymous feed refresh without hydrating the fallback backlog', async () => {
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
            limit: SHOWCASE_INITIAL_PAGE_SIZE,
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
    expect(screen.queryByText('Retry Fallback 2')).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(feedFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Recovered discovery')).toBeInTheDocument();
    expect(screen.queryByText('Retry Fallback 2')).not.toBeInTheDocument();
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
});
