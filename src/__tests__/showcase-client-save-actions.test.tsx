import type { AnchorHTMLAttributes, ComponentProps, HTMLAttributes, ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseClient from '@/app/showcase/ShowcaseClient';
import { resetSaverNoticeForTests } from '@/components/saver-notice';
import {
  FEED_REMOVAL_UNDO_MS,
  flushShowcaseFeedEvents,
  resetShowcaseFeedEventQueueForTests,
} from '@/app/showcase/ShowcaseFeedInteraction';
import {
  SHOWCASE_INITIAL_RENDER_COUNT,
  SHOWCASE_PAGE_SIZE,
  type ShowcaseFeedItem,
  type ShowcaseFeedPage,
  type ShowcaseMediaItem,
  type ShowcaseSort,
} from '@/lib/showcase';
import type { SourceToolFilterOption } from '@/lib/source-tools';
import {
  buildShowcaseClientCacheKey,
  clearShowcaseClientCacheForTests,
  forgetShowcaseSnapshotsInMemoryForTests,
  getFeedPreferencesHiddenThisVisit,
  readShowcaseClientSnapshot,
  rememberViewerExclusionsForVisit,
  takeBlockedCreatorOffClientFeeds,
  writeShowcaseClientSnapshot,
} from '@/lib/showcase-client-cache';

// One router object for every render, as Next's is.
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));
const mockPush = routerMock.push;
const mockReplace = routerMock.replace;
const authState = vi.hoisted(() => ({
  session: {
    access_token: 'test-token',
    user: { id: 'user-1' },
  } as { access_token: string; user: { id: string } } | null,
  user: { id: 'user-1' } as { id: string } | null,
  credits: 25,
  isLoading: false,
  saverNoticeRecord: null as { userId: string; seen: boolean } | null,
}));

// Next's `useSearchParams` gives its readers one object per URL and re-renders
// them when the URL changes. The part this file relies on is
// `useSyncExternalStore`: it reads the URL in every render and counts a changed
// URL as an update, so React cannot drop a render the URL moved under. A plain
// getter, cached or not, let it drop one (#521); ShowcaseClient's closing guard
// now keeps the reel shut there too (see "closes the reel when Explore is
// pressed before…" below). On a plain getter, "keeps the reel closed when a page
// lands…" still fails (it needs the re-render after popstate) and so does "asks
// again when the URL effect runs…" (it needs one object per URL). Next applies
// the app's own pushState or replaceState from a microtask right after it (in a
// production build, in the same commit as the tap's own render), close to this
// mock, which has the new URL at the next render. And it re-renders after any
// popstate that changes the search, where Next acts only on history entries
// that carry its state (the app's own entries do; this file's PopStateEvents
// carry none).
function subscribeToPopstate(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
}

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => '/showcase',
  useSearchParams: () => {
    const search = useSyncExternalStore(subscribeToPopstate, () => window.location.search);
    return useMemo(() => new URLSearchParams(search), [search]);
  },
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

// Every Explore tile is drawn inside one impression boundary, which holds no
// state of its own, and nothing else on the page draws one (the reel does
// not): its renders are the tiles' renders. The real boundary is drawn.
const tileRenders = vi.hoisted(() => vi.fn<(postId: string) => void>());
vi.mock('@/app/showcase/ShowcaseFeedInteraction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/showcase/ShowcaseFeedInteraction')>();
  function CountedImpressionBoundary(props: ComponentProps<typeof actual.QualifiedImpressionBoundary>) {
    tileRenders(props.item.id);
    return <actual.QualifiedImpressionBoundary {...props} />;
  }
  return { ...actual, QualifiedImpressionBoundary: CountedImpressionBoundary };
});

const SOURCE_TOOL_OPTIONS: SourceToolFilterOption[] = [
  { slug: 'magicbooklet', label: 'magicbooklet' },
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
    thresholds: readonly number[];
    trigger: (isIntersecting?: boolean, entry?: Partial<IntersectionObserverEntry>) => void;
    /** One report of several targets, as a browser batches them. */
    deliver: (entries: Array<Partial<IntersectionObserverEntry>>) => void;
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
    authState.saverNoticeRecord = null;
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
    // jsdom does not scroll the window; a lane change and a Refresh ask it to.
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    vi.stubGlobal('IntersectionObserver', vi.fn(function IntersectionObserverMock(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit
    ) {
      const observedTargets: Element[] = [];
      const thresholds = Array.isArray(options?.threshold)
        ? options.threshold
        : [options?.threshold ?? 0];
      const observer = {
        root: null,
        rootMargin: options?.rootMargin ?? '0px',
        thresholds,
        observe: vi.fn((target: Element) => { observedTargets.push(target); }),
        unobserve: vi.fn((target: Element) => {
          const index = observedTargets.indexOf(target);
          if (index >= 0) observedTargets.splice(index, 1);
        }),
        disconnect: vi.fn(),
        takeRecords: vi.fn(() => []),
      } satisfies IntersectionObserver;

      intersectionObservers.push({
        observe: observer.observe,
        disconnect: observer.disconnect,
        observedTargets,
        rootMargin: observer.rootMargin,
        thresholds,
        trigger: (isIntersecting = true, entry = {}) => {
          callback([
            {
              isIntersecting,
              target: document.createElement('div'),
              ...entry,
            } as unknown as IntersectionObserverEntry,
          ], observer);
        },
        deliver: (entries) => {
          callback(entries as unknown as IntersectionObserverEntry[], observer);
        },
      });

      return observer;
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.removeItem('magicbooklet:saver-notice:v2:user-1');
    resetSaverNoticeForTests();
  });

  it('optimistically saves a showcase card with accessible pressed state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, isSaved: true, saveCount: 5, changed: true }),
    })));
    // This viewer was told on an earlier page, as the page was drawn knowing,
    // so the save may name them.
    authState.saverNoticeRecord = { userId: 'user-1', seen: true };

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
        creatorSeesSaver: true,
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

  // The heart used to lock until the save came back, so a second tap did
  // nothing; the app's takes every tap.
  it('takes a second tap while the first save is still on the wire', async () => {
    let answerSave: (answer: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/showcase/save') {
        return new Promise((resolve) => { answerSave = resolve; });
      }
      return Promise.resolve({ ok: true, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { success: true }) });
    }));
    const saveRequests = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/showcase/save');
    renderShowcase(createShowcaseItem());

    fireEvent.click(screen.getByRole('button', { name: /save campaign frame\. 4 saves/i }));
    fireEvent.click(screen.getByRole('button', { name: /remove save from campaign frame\. 5 saves/i }));

    expect(screen.getByRole('button', { name: /save campaign frame\. 4 saves/i })).toHaveAttribute('aria-pressed', 'false');
    expect(saveRequests()).toHaveLength(1);

    // The newest tap goes out once the first request has answered.
    await act(async () => answerSave({ ok: true, json: async () => ({ success: true, isSaved: true, saveCount: 5 }) }));
    await waitFor(() => expect(saveRequests()).toHaveLength(2));
    expect(JSON.parse(String(saveRequests()[1][1]?.body))).toMatchObject({ postId: 'post-1', shouldSave: false });
    await act(async () => answerSave({ ok: true, json: async () => ({ success: true, isSaved: false, saveCount: 4 }) }));
    expect(screen.getByRole('button', { name: /save campaign frame\. 4 saves/i })).toHaveAttribute('aria-pressed', 'false');
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

  // The ticks went through the transition of the lane controls, whose pending
  // state committed first, synchronously: every tick drew the page once more
  // just to turn the chips and the sort off and on again.
  it('leaves the lane controls alone while the reveal ticks fill the grid', () => {
    vi.useFakeTimers();
    const items = Array.from({ length: SHOWCASE_INITIAL_RENDER_COUNT + 3 }, (_, index) => createShowcaseItem({
      id: `post-${index + 1}`,
      generationId: `gen-${index + 1}`,
      title: `Campaign ${index + 1}`,
      mediaUrl: `https://example.com/campaign-${index + 1}.jpg`,
    }));
    renderShowcase(items);
    const sortSelect = screen.getByRole('combobox', { name: 'Sort community posts' });
    const imagesChip = screen.getByRole('button', { name: 'Images' });
    const disabledChanges: MutationRecord[] = [];
    const observer = new MutationObserver((records) => {
      disabledChanges.push(...records);
    });
    observer.observe(sortSelect, { attributes: true, attributeFilter: ['disabled'] });
    observer.observe(imagesChip, { attributes: true, attributeFilter: ['disabled'] });

    act(() => {
      vi.advanceTimersByTime(160 * 3);
    });
    disabledChanges.push(...observer.takeRecords());
    observer.disconnect();

    expect(screen.getByText(`Campaign ${items.length}`)).toBeInTheDocument();
    expect(disabledChanges).toEqual([]);
    expect(sortSelect).toBeEnabled();
    expect(imagesChip).toBeEnabled();
  });

  // A tile draws again only when what it shows changes. Drawn inline, every
  // tile on the page drew again at each reel landing, media swipe, save and
  // reveal tick, and the grid is not windowed: the cost grew with each page.
  describe('what draws a tile again', () => {
    const drawsOf = (postId: string) => tileRenders.mock.calls.filter(([id]) => id === postId).length;
    const threeTiles = () => [
      createShowcaseItem(),
      createShowcaseItem({
        id: 'post-2',
        generationId: 'gen-2',
        title: 'Second Frame',
        mediaUrl: 'https://example.com/second.jpg',
      }),
      createShowcaseItem({
        id: 'post-3',
        generationId: 'gen-3',
        title: 'Third Frame',
        mediaUrl: 'https://example.com/third.jpg',
        mediaItems: [
          {
            id: 'third-media-1',
            url: 'https://example.com/third.jpg',
            mediaKind: 'image',
            contentType: 'image/jpeg',
            originalName: 'third.jpg',
            width: 800,
            height: 1000,
            durationSeconds: null,
            sortOrder: 0,
          },
          {
            id: 'third-media-2',
            url: 'https://example.com/third-second.jpg',
            mediaKind: 'image',
            contentType: 'image/jpeg',
            originalName: 'third-second.jpg',
            width: 1200,
            height: 800,
            durationSeconds: null,
            sortOrder: 1,
          },
        ],
      }),
    ];

    beforeEach(() => {
      tileRenders.mockClear();
    });

    it('draws none as the reel opens, lands on other posts, swipes media and closes', async () => {
      vi.spyOn(window.history, 'pushState');
      // Back from the reel, sooner than a browser: the URL loses `post` and popstate fires at once (a browser fires it in a later task).
      vi.spyOn(window.history, 'back').mockImplementation(() => {
        window.history.replaceState(null, '', '/showcase');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      const feed = createFeed(threeTiles());
      // A new element with the same props, as Next draws the page again when
      // its URL changes.
      const drawShowcase = () => (
        <ShowcaseClient
          initialFeed={feed}
          initialCategory="all"
          initialSort="recent"
          initialTool={null}
          initialUnlock="all"
          initialResource="all"
          sourceToolOptions={SOURCE_TOOL_OPTIONS}
        />
      );
      const reel = async () => within(await screen.findByRole('dialog', { name: 'Explore reel viewer' }));
      const { rerender } = render(drawShowcase());
      // The count sees the tiles: each drew once.
      expect(['post-1', 'post-2', 'post-3'].map(drawsOf)).toEqual([1, 1, 1]);
      const tileDraws = tileRenders.mock.calls.length;

      fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));
      expect(await (await reel()).findByRole('button', { name: /more actions for campaign frame/i })).toBeInTheDocument();

      // A landing from the reel: its Next post (`selectPreviewItem`).
      fireEvent.click((await reel()).getByRole('button', { name: 'Next post' }));
      expect(await (await reel()).findByRole('button', { name: /more actions for second frame/i })).toBeInTheDocument();
      expect(new URLSearchParams(window.location.search).get('post')).toBe('post-2');

      // A landing from the URL (a link, the browser's history): `?post=` changes.
      window.history.replaceState(null, '', '/showcase?post=post-3');
      rerender(drawShowcase());
      expect(await (await reel()).findByRole('button', { name: /more actions for third frame/i })).toBeInTheDocument();

      // A media swipe in the reel: `?media=` changes.
      fireEvent.click((await reel()).getByRole('button', { name: 'Next media' }));
      await waitFor(() => {
        expect(new URLSearchParams(window.location.search).get('media')).toBe('1');
      });

      fireEvent.click((await reel()).getByRole('button', { name: 'Explore' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Explore reel viewer' })).not.toBeInTheDocument();
      });

      expect(tileRenders.mock.calls.length).toBe(tileDraws);
    });

    it('draws the saved tile alone when a post is saved', async () => {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/showcase/save') {
          return { ok: true, json: async () => ({ success: true, isSaved: true, saveCount: 5, changed: true }) };
        }
        if (url.startsWith('/api/showcase/saved-state')) {
          return { ok: true, json: async () => [] };
        }
        return { ok: true, json: async () => ({ success: true }) };
      }));
      renderShowcase(threeTiles());
      // The viewer's saved state answers after the first draw, and saves nothing here.
      await waitFor(() => {
        expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith('/api/showcase/saved-state')))
          .toBe(true);
      });
      await act(async () => undefined);
      const [firstDraws, savedDraws, thirdDraws] = ['post-1', 'post-2', 'post-3'].map(drawsOf);

      fireEvent.click(screen.getByRole('button', { name: /save second frame\. 4 saves/i }));

      const savedButton = await screen.findByRole('button', { name: /remove save from second frame\. 5 saves/i });
      expect(savedButton).toHaveAttribute('aria-pressed', 'true');
      // The save has come back and settled: the ranker hears of it after that.
      await waitFor(() => {
        expect(vi.mocked(fetch).mock.calls.some(([input, request]) => String(input) === '/api/showcase/feed/events'
          && JSON.parse(String(request?.body)).eventType === 'save')).toBe(true);
      });
      await act(async () => undefined);
      expect(drawsOf('post-2')).toBeGreaterThan(savedDraws);
      expect(drawsOf('post-1')).toBe(firstDraws);
      expect(drawsOf('post-3')).toBe(thirdDraws);
    });

    it('draws none of the tiles already shown when a reveal tick adds the next one', () => {
      vi.useFakeTimers();
      const items = Array.from({ length: SHOWCASE_INITIAL_RENDER_COUNT + 2 }, (_, index) => createShowcaseItem({
        id: `post-${index + 1}`,
        generationId: `gen-${index + 1}`,
        title: `Campaign ${index + 1}`,
        mediaUrl: `https://example.com/campaign-${index + 1}.jpg`,
      }));
      const shownIds = items.slice(0, SHOWCASE_INITIAL_RENDER_COUNT).map((item) => item.id);
      const revealedId = items[SHOWCASE_INITIAL_RENDER_COUNT].id;
      renderShowcase(items);
      const shownDraws = shownIds.map(drawsOf);
      expect(drawsOf(revealedId)).toBe(0);

      act(() => {
        vi.advanceTimersByTime(160);
      });

      expect(screen.getByText(`Campaign ${SHOWCASE_INITIAL_RENDER_COUNT + 1}`)).toBeInTheDocument();
      expect(drawsOf(revealedId)).toBeGreaterThan(0);
      expect(shownIds.map(drawsOf)).toEqual(shownDraws);
    });

    it("draws none when a lane is tapped, before that lane's page comes", () => {
      renderShowcase(threeTiles());
      const tileDraws = tileRenders.mock.calls.length;

      fireEvent.click(screen.getByRole('button', { name: 'Videos' }));

      expect(screen.getByRole('button', { name: 'Videos' })).toHaveAttribute('aria-pressed', 'true');
      expect(mockReplace).toHaveBeenCalledWith('/showcase?category=video&sort=recent', { scroll: false });
      expect(tileRenders.mock.calls.length).toBe(tileDraws);
    });

    it("names the lane alone as a tile's way back: not the reel's post, nor anything else the URL carries", async () => {
      window.history.replaceState(null, '', '/showcase?category=video&sort=recent&utm_source=newsletter');
      vi.spyOn(window.history, 'pushState');
      render(
        <ShowcaseClient
          initialFeed={createFeed(createShowcaseItem({
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
          }))}
          initialCategory="video"
          initialSort="recent"
          initialTool={null}
          initialUnlock="all"
          initialResource="all"
          sourceToolOptions={SOURCE_TOOL_OPTIONS}
        />
      );
      const recipeLink = screen.getByRole('link', { name: /unlock for \$9\.00/i });
      const wayBack = () => new URL(recipeLink.getAttribute('href') ?? '', 'https://magicbooklet.test')
        .searchParams.get('returnTo');
      expect(wayBack()).toBe('/showcase?category=video&sort=recent');

      fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));
      await screen.findByRole('dialog', { name: 'Explore reel viewer' });

      expect(new URLSearchParams(window.location.search).get('post')).toBe('post-1');
      expect(wayBack()).toBe('/showcase?category=video&sort=recent');
    });
  });

  // Where nothing hovers, Explore plays one tile's clip, the one most in view,
  // as Home plays its cards' and the app's Explore its one preview. A phone
  // used to see still tiles until one was tapped open.
  describe('the one clip the grid plays where nothing hovers', () => {
    /** `(hover: none)` and reduced motion as the page reads them; `set` changes them as a device would. */
    const stubViewport = (initial: { hover: boolean; reducedMotion?: boolean }) => {
      const preferences = { reducedMotion: false, ...initial };
      const listeners = new Set<() => void>();
      vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
        get matches() {
          return (!preferences.hover && query === '(hover: none)')
            || (preferences.reducedMotion && query === '(prefers-reduced-motion: reduce)');
        },
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((_type: string, listener: () => void) => { listeners.add(listener); }),
        removeEventListener: vi.fn((_type: string, listener: () => void) => { listeners.delete(listener); }),
        dispatchEvent: vi.fn(),
      })));
      return {
        set: (next: Partial<typeof preferences>) => {
          Object.assign(preferences, next);
          act(() => listeners.forEach((listener) => listener()));
        },
      };
    };
    const clipTile = (n: number, media: Partial<ShowcaseMediaItem> = {}) => createShowcaseItem({
      id: `clip-${n}`,
      generationId: `clip-gen-${n}`,
      title: `Clip ${n}`,
      mediaUrl: `https://example.com/clip-${n}.mp4`,
      mediaKind: 'video',
      category: 'video',
      mediaItems: [{
        id: `clip-${n}-media`,
        url: `https://example.com/clip-${n}.mp4`,
        feedStreamUrl: `https://example.com/clip-${n}-teaser.mp4`,
        mediaKind: 'video',
        contentType: 'video/mp4',
        originalName: `clip-${n}.mp4`,
        width: 1080,
        height: 1350,
        durationSeconds: 8,
        sortOrder: 0,
        ...media,
      }],
    });
    const postIdOf = (element: Element) => (
      element.closest('[data-showcase-post-id]')?.getAttribute('data-showcase-post-id') ?? null
    );
    // The grid's own observer reports a tile's share at many steps; a
    // carousel's reports at three, an impression's at one.
    const gridObservers = () => intersectionObservers.filter((observer) => observer.thresholds.length > 3);
    const gridObserver = () => {
      const observer = gridObservers().at(-1);
      if (!observer) throw new Error('the grid measures no tile');
      return observer;
    };
    const measuredTiles = () => gridObserver().observedTargets.map(postIdOf);
    const reportShares = (shares: Record<string, number>) => {
      const observer = gridObserver();
      const entries = Object.entries(shares).map(([postId, intersectionRatio]) => {
        const target = observer.observedTargets.find((frame) => postIdOf(frame) === postId);
        if (!target) throw new Error(`${postId} is not measured`);
        return { target, isIntersecting: intersectionRatio > 0, intersectionRatio };
      });
      act(() => observer.deliver(entries));
    };
    // A carousel plays only while its own report has 0.45 of it in view. Here
    // every carousel's has, so the grid's choice alone decides.
    const showEveryCarousel = () => {
      act(() => {
        intersectionObservers
          .filter((observer) => observer.thresholds.includes(0.45))
          .forEach((observer) => observer.trigger(true, { intersectionRatio: 0.7 }));
      });
    };
    // A grid clip plays once its carousel attaches the stream. The reel draws
    // no impression boundary, so these are the grid's tiles alone.
    const playingClips = () => Array.from(
      document.querySelectorAll('[data-showcase-post-id] video[src]'),
      postIdOf
    );
    const gridVideo = (postId: string) => {
      const video = document.querySelector<HTMLVideoElement>(`[data-showcase-post-id="${postId}"] video`);
      if (!video) throw new Error(`${postId} draws no video`);
      return video;
    };

    beforeEach(() => {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    });

    afterEach(() => {
      // Unmounted while jsdom's media methods are still stubbed: it has no
      // pause() of its own, and each clip pauses as it goes.
      cleanup();
      Reflect.deleteProperty(window.navigator, 'connection');
    });

    it('plays the clip most in view, and hands it on as the reader scrolls', () => {
      stubViewport({ hover: false });
      renderShowcase([
        clipTile(1),
        clipTile(2),
        createShowcaseItem({ id: 'picture', generationId: 'picture-gen', title: 'Picture' }),
        clipTile(3),
        // The server allowed this clip no stream: poster only.
        clipTile(4, { feedStreamUrl: null }),
      ]);
      showEveryCarousel();

      // One observer measures every tile that opens on a clip it may stream.
      expect(gridObservers()).toHaveLength(1);
      expect(measuredTiles()).toEqual(['clip-1', 'clip-2', 'clip-3']);
      expect(playingClips()).toEqual([]);

      reportShares({ 'clip-1': 0.6, 'clip-2': 1, 'clip-3': 0.2 });
      expect(playingClips()).toEqual(['clip-2']);
      expect(vi.mocked(HTMLMediaElement.prototype.play).mock.contexts).toEqual([gridVideo('clip-2')]);

      // Scrolling on, the third comes most into view. The turn passing draws
      // the two tiles it passes between, and no other.
      tileRenders.mockClear();
      reportShares({ 'clip-1': 0, 'clip-2': 0.4, 'clip-3': 0.9 });
      expect(playingClips()).toEqual(['clip-3']);
      expect(new Set(tileRenders.mock.calls.map(([postId]) => postId))).toEqual(new Set(['clip-2', 'clip-3']));

      // A step that leaves the same tile ahead draws nothing.
      tileRenders.mockClear();
      reportShares({ 'clip-3': 1, 'clip-2': 0.3 });
      expect(playingClips()).toEqual(['clip-3']);
      expect(tileRenders).not.toHaveBeenCalled();

      // The playing tile leaves the screen: the next most in view takes over.
      reportShares({ 'clip-3': 0 });
      expect(playingClips()).toEqual(['clip-2']);
    });

    it('gives a tie to the first in the grid, and keeps a playing clip through one', () => {
      stubViewport({ hover: false });
      renderShowcase([clipTile(1), clipTile(2)]);
      showEveryCarousel();

      // A row's tiles cross every step together.
      reportShares({ 'clip-1': 0.5, 'clip-2': 0.5 });
      expect(playingClips()).toEqual(['clip-1']);

      reportShares({ 'clip-1': 0.4, 'clip-2': 0.6 });
      expect(playingClips()).toEqual(['clip-2']);

      reportShares({ 'clip-1': 0.7, 'clip-2': 0.7 });
      expect(playingClips()).toEqual(['clip-2']);
    });

    it('plays none while Save-Data is on, as Home, and the chosen clip once it is off', () => {
      stubViewport({ hover: false });
      const connectionListeners = new Set<() => void>();
      const connection = {
        saveData: true,
        addEventListener: vi.fn((_type: string, listener: () => void) => { connectionListeners.add(listener); }),
        removeEventListener: vi.fn((_type: string, listener: () => void) => { connectionListeners.delete(listener); }),
      };
      Object.defineProperty(window.navigator, 'connection', { configurable: true, value: connection });
      renderShowcase([clipTile(1), clipTile(2)]);
      showEveryCarousel();

      reportShares({ 'clip-1': 1, 'clip-2': 0.5 });
      expect(playingClips()).toEqual([]);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

      connection.saveData = false;
      act(() => connectionListeners.forEach((listener) => listener()));
      expect(playingClips()).toEqual(['clip-1']);
    });

    it('plays none while the reader asks for reduced motion, as Home, and the chosen clip once they do not', () => {
      const viewport = stubViewport({ hover: false, reducedMotion: true });
      renderShowcase([clipTile(1), clipTile(2)]);
      showEveryCarousel();

      reportShares({ 'clip-1': 0.5, 'clip-2': 1 });
      expect(playingClips()).toEqual([]);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

      viewport.set({ reducedMotion: false });
      expect(playingClips()).toEqual(['clip-2']);
    });

    it('leaves pointers to hover as before: no tile is measured or played until one is hovered', () => {
      stubViewport({ hover: true });
      renderShowcase([clipTile(1), clipTile(2)]);
      showEveryCarousel();

      expect(gridObservers()).toEqual([]);
      expect(playingClips()).toEqual([]);

      const hovered = gridVideo('clip-2').closest('[data-showcase-media-viewport]');
      fireEvent.mouseEnter(hovered!);
      expect(playingClips()).toEqual(['clip-2']);
      fireEvent.mouseLeave(hovered!);
      expect(playingClips()).toEqual([]);
    });

    // After hydration the query turns true a render later (its server answer
    // is false), once the first page's tiles are already drawn.
    it('measures the tiles already drawn once the query turns, and stops when a hovering pointer takes over', () => {
      const viewport = stubViewport({ hover: true });
      renderShowcase([clipTile(1), clipTile(2)]);
      showEveryCarousel();
      expect(gridObservers()).toEqual([]);

      viewport.set({ hover: false });
      expect(measuredTiles()).toEqual(['clip-1', 'clip-2']);
      reportShares({ 'clip-1': 0.3, 'clip-2': 0.8 });
      expect(playingClips()).toEqual(['clip-2']);

      viewport.set({ hover: true });
      expect(gridObserver().disconnect).toHaveBeenCalled();
      expect(playingClips()).toEqual([]);
    });

    it('plays no tile under the open reel, and the chosen clip again once it closes', async () => {
      // Back from the reel, sooner than a browser: the URL loses `post` and popstate fires at once (a browser fires it in a later task).
      vi.spyOn(window.history, 'back').mockImplementation(() => {
        window.history.replaceState(null, '', '/showcase');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      stubViewport({ hover: false });
      renderShowcase([clipTile(1), clipTile(2)]);
      showEveryCarousel();
      reportShares({ 'clip-1': 1, 'clip-2': 0.3 });
      expect(playingClips()).toEqual(['clip-1']);

      fireEvent.click(gridVideo('clip-2'));
      const reel = await screen.findByRole('dialog', { name: 'Explore reel viewer' });
      // As the other reel tests do, act in the reel once its rows are drawn.
      expect(await within(reel).findByRole('button', { name: /more actions for clip 2/i })).toBeInTheDocument();
      expect(playingClips()).toEqual([]);

      fireEvent.click(within(reel).getByRole('button', { name: 'Explore' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Explore reel viewer' })).not.toBeInTheDocument();
      });
      expect(playingClips()).toEqual(['clip-1']);
    });

    it('hands the turn on at once when the playing tile leaves the grid', () => {
      stubViewport({ hover: false });
      renderShowcase([clipTile(1), clipTile(2), clipTile(3)]);
      showEveryCarousel();
      reportShares({ 'clip-1': 1, 'clip-2': 0.6, 'clip-3': 0.2 });
      expect(playingClips()).toEqual(['clip-1']);

      fireEvent.click(screen.getByRole('button', { name: /more actions for clip 1/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: /not interested/i }));

      // No report has come since the tile went.
      expect(measuredTiles()).toEqual(['clip-2', 'clip-3']);
      expect(playingClips()).toEqual(['clip-2']);
    });
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

  // A lane change is a server navigation, and the server builds every lane's
  // first page for everyone: its posts arrive unsaved. The lookup ran for the
  // first lane only, so a saved post drew an empty heart, and a tap saved it again.
  it("asks once whether the viewer saved a new lane's posts, and draws their hearts", async () => {
    const savedStateRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/saved-state')) {
        savedStateRequests.push(url);
        return { ok: true, json: async () => (url.includes('post-saved') ? ['post-saved'] : []) };
      }
      return { ok: true, json: async () => ({ success: true }) };
    }));
    const lane = (sort: ShowcaseSort, feed: ShowcaseFeedPage) => (
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
    const view = render(lane('recent', createFeed(createShowcaseItem())));
    await waitFor(() => expect(savedStateRequests).toHaveLength(1));

    view.rerender(lane('top-saves', createFeed(createShowcaseItem({
      id: 'post-saved',
      generationId: 'gen-saved',
      title: 'Saved Frame',
      isSaved: false,
    }))));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove save from saved frame/i }))
        .toHaveAttribute('aria-pressed', 'true');
    });
    await act(async () => Promise.resolve());
    expect(savedStateRequests).toEqual([
      '/api/showcase/saved-state?ids=post-1%2Cgen-1',
      '/api/showcase/saved-state?ids=post-saved%2Cgen-saved',
    ]);
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
    // Both ways to pay, as the post page names them.
    expect(unlockLink).toHaveAccessibleName(/^Unlock for \$9\.00 · 900 credits for /);
    // The tile's badge is a chip: credits alone, as the app prices it.
    expect(screen.getByText('900 credits')).toBeInTheDocument();
    expect(screen.queryByText('$9.00')).not.toBeInTheDocument();
  });

  it('prices a credits-only recipe in credits alone, with no cash figure the checkout refuses', () => {
    renderShowcase(createShowcaseItem({
      asset: {
        id: 'bundle-1',
        postId: 'post-1',
        title: 'Prompt pack',
        accessMode: 'paid',
        priceUsdCents: 50,
        priceQuote: { currency: 'USD', amountSubunits: 50, formatted: '$0.50', note: null },
        previewText: 'Unlock the exact reusable prompt.',
        allowRemix: false,
        resourceKinds: ['prompt'],
      },
    }));

    expect(screen.getByRole('link', { name: /^unlock for 50 credits for /i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /\$0\.50/ })).not.toBeInTheDocument();
    // The tile's badge as well, which read "$0.50 recipe".
    expect(screen.getByText('50 credits')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('$0.50');
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

  const nextPageItem = createShowcaseItem({
    id: 'post-next-page',
    title: 'Next Page Frame',
    generationId: 'gen-next-page',
    mediaUrl: 'https://example.com/next-page.jpg',
  });
  // Answers the next feed page (offset 24) with `nextPageItem`, and the rest as the default
  // stub does; `route` answers first, and passes with `undefined`.
  const answerWithNextPage = (route: (url: string, init?: RequestInit) => unknown = () => undefined) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const routed = route(url, init);
      if (routed !== undefined) {
        return routed;
      }
      if (url.startsWith('/api/showcase/feed?') && url.includes('&offset=24&')) {
        return { ok: true, json: async () => createFeed(nextPageItem) };
      }
      if (url.startsWith('/api/showcase/saved-state')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({ success: true }) };
    }));
  };
  // Draws a first page with more to come and returns a way to land the next one. The URL
  // effect reads `items`, so a page landing runs it again with `post` unchanged; a browser
  // lands the next page of a short first page at once.
  const renderWithNextPage = () => {
    render(
      <ShowcaseClient
        initialFeed={createFeed(createShowcaseItem(), { hasMore: true, nextOffset: 24 })}
        initialCategory="all"
        initialSort="recent"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );
    return async () => {
      const sentinelObserver = intersectionObservers.filter((observer) => observer.observedTargets.some((target) => (
        target.getAttribute('data-showcase-load-more-sentinel') === 'true' && target.isConnected
      ))).at(-1);
      expect(sentinelObserver).toBeDefined();
      act(() => {
        sentinelObserver?.trigger(true);
      });
      expect(await screen.findByText('Next Page Frame')).toBeInTheDocument();
      // The URL effect ran with the commit that took the page in; let what it started settle.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    };
  };

  // Explore closes the reel at once, but the URL keeps the post until the browser's Back comes
  // (popstate, a task later). A page that landed in between ran the URL effect on that URL and
  // opened the reel again for a frame: seen in a production build with Back held 5 ms
  // (archive/web-showcase-reel-races-2026-10-22).
  it('keeps the reel closed when a page lands between Explore and the browser going back', async () => {
    answerWithNextPage();
    // Back as a browser does it: the URL keeps `post` until popstate, which comes later.
    let finishBack = () => {};
    vi.spyOn(window.history, 'back').mockImplementation(() => {
      finishBack = () => {
        window.history.replaceState(null, '', '/showcase');
        window.dispatchEvent(new PopStateEvent('popstate'));
      };
    });

    const landNextPage = renderWithNextPage();
    fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));
    const reel = await screen.findByRole('dialog', { name: 'Explore reel viewer' });
    fireEvent.click(within(reel).getByRole('button', { name: 'Explore' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Explore reel viewer' })).not.toBeInTheDocument();
    });
    expect(new URLSearchParams(window.location.search).get('post')).toBe('post-1');

    await landNextPage();
    expect(screen.queryByRole('dialog', { name: 'Explore reel viewer' })).not.toBeInTheDocument();

    act(() => {
      finishBack();
    });
    expect(screen.queryByRole('dialog', { name: 'Explore reel viewer' })).not.toBeInTheDocument();
    // Once the URL has moved on it is followed again: Forward to the post opens the reel.
    act(() => {
      window.history.replaceState(null, '', '/showcase?post=post-1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByRole('dialog', { name: 'Explore reel viewer' })).toBeInTheDocument();
    // Room as #457 gave, so a wait above that never passes fails on its own assertion.
  }, 15_000);

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

  // A `?post=` link to a post the first page does not hold is read on its own.
  // The reel opened only once that read came back, and never when it failed:
  // a link to a deleted post showed the grid and nothing else.
  describe('a shared post outside the first page', () => {
    const sharedItem = createShowcaseItem({
      id: 'post-shared',
      title: 'Shared Campaign',
      generationId: 'gen-shared',
      mediaUrl: 'https://example.com/shared.jpg',
    });
    type SharedPostAnswer = { ok: boolean; status: number; json: () => Promise<unknown> };
    const answerSharedPost = (answer: (init?: RequestInit) => SharedPostAnswer | Promise<SharedPostAnswer>) => {
      const reads: string[] = [];
      answerWithNextPage((url, init) => {
        if (url !== '/api/showcase/posts/post-shared') return undefined;
        reads.push(url);
        return answer(init);
      });
      return reads;
    };

    it("says inside the reel that a deleted or hidden post isn't available", async () => {
      window.history.replaceState(null, '', '/showcase?post=post-shared');
      const replaceState = vi.spyOn(window.history, 'replaceState');
      answerSharedPost(() => ({ ok: false, status: 404, json: async () => ({ error: 'Post not found.' }) }));

      renderShowcase(createShowcaseItem());

      const reel = await screen.findByRole('dialog', { name: 'Explore reel viewer' });
      expect(await within(reel).findByRole('heading', { name: /this post isn.t available/i })).toBeInTheDocument();
      expect(within(reel).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

      fireEvent.click(within(reel).getByRole('button', { name: 'Back to Explore' }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Explore reel viewer' })).not.toBeInTheDocument();
      });
      expect(new URLSearchParams(window.location.search).has('post')).toBe(false);
      expect(replaceState).toHaveBeenLastCalledWith(null, '', '/showcase');
    });

    it('offers Try again when the read fails, asks nothing more on its own, and opens the post when it comes', async () => {
      window.history.replaceState(null, '', '/showcase?post=post-shared');
      let failing = true;
      const reads = answerSharedPost(() => failing
        ? { ok: false, status: 500, json: async () => ({ error: 'Failed to fetch showcase post.' }) }
        : { ok: true, status: 200, json: async () => ({ success: true, item: sharedItem }) });

      const landNextPage = renderWithNextPage();

      const reel = await screen.findByRole('dialog', { name: 'Explore reel viewer' });
      await within(reel).findByRole('button', { name: 'Try again' });
      expect(within(reel).getByRole('heading', { name: /couldn.t load this post/i })).toBeInTheDocument();
      const readsBeforeRetry = reads.length;
      // The URL effect runs again after the failure: it neither asks again nor shows a read
      // loading that nobody makes.
      await landNextPage();
      expect(reads).toHaveLength(readsBeforeRetry);
      expect(within(reel).getByRole('heading', { name: /couldn.t load this post/i })).toBeInTheDocument();

      failing = false;
      fireEvent.click(within(reel).getByRole('button', { name: 'Try again' }));

      expect((await screen.findAllByRole('heading', { name: 'Shared Campaign' })).length).toBeGreaterThan(1);
      expect(reads.length).toBeGreaterThan(readsBeforeRetry);
      // Room as #457 gave, so a wait above that never passes fails on its own assertion.
    }, 15_000);

    it('asks again when the URL effect runs while the read is out, and shows no failure for the read it cut short', async () => {
      window.history.replaceState(null, '', '/showcase?post=post-shared');
      const signals: Array<AbortSignal | undefined> = [];
      let answerSecondRead = () => {};
      const reads = answerSharedPost((init) => {
        signals.push(init?.signal ?? undefined);
        if (signals.length === 1) {
          // The first read stays out until it is aborted, then rejects as a browser's does.
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('The read was aborted.', 'AbortError')));
          });
        }
        return new Promise((resolve) => {
          answerSecondRead = () => resolve({ ok: true, status: 200, json: async () => ({ success: true, item: sharedItem }) });
        });
      });

      const landNextPage = renderWithNextPage();
      expect(reads).toHaveLength(1);

      await landNextPage();
      expect(signals[0]?.aborted).toBe(true);
      expect(reads).toHaveLength(2);
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

      answerSecondRead();
      expect((await screen.findAllByRole('heading', { name: 'Shared Campaign' })).length).toBeGreaterThan(1);
      // Room as #457 gave, so a wait above that never passes fails on its own assertion.
    }, 15_000);

    // A read can be cut short after its answer's headers came, while the body is still on its
    // way: a browser's `fetch` has resolved by then, and `json()` rejects with the AbortError.
    // That rejection was taken for a broken answer, and the reel said "Couldn't load this post"
    // with Try again until the read asked after it answered.
    it('shows no failure for a read cut short while its answer was still arriving', async () => {
      window.history.replaceState(null, '', '/showcase?post=post-shared');
      // Each read's headers come at once and its body when the test answers it, unless an abort
      // comes first: then `json()` rejects, as a browser's does.
      type HeldRead = { signal?: AbortSignal; bodyLoading: boolean; answer: () => void };
      const heldReads: HeldRead[] = [];
      answerSharedPost((init) => {
        const read: HeldRead = { signal: init?.signal ?? undefined, bodyLoading: false, answer: () => {} };
        heldReads.push(read);
        return {
          ok: true,
          status: 200,
          json: () => new Promise((resolve, reject) => {
            const abort = () => reject(new DOMException('The read was aborted.', 'AbortError'));
            if (read.signal?.aborted) return abort();
            read.signal?.addEventListener('abort', abort);
            read.bodyLoading = true;
            read.answer = () => resolve({ success: true, item: sharedItem });
          }),
        };
      });

      const landNextPage = renderWithNextPage();
      const reel = await screen.findByRole('dialog', { name: 'Explore reel viewer' });
      let cutShort: HeldRead | undefined;
      await waitFor(() => {
        cutShort = heldReads.find((read) => read.bodyLoading && !read.signal?.aborted);
        expect(cutShort).toBeDefined();
      });

      // The page landing runs the URL effect again: its cleanup aborts the read whose body is
      // loading, and the run asks again.
      await landNextPage();
      expect(cutShort?.signal?.aborted).toBe(true);
      expect(within(reel).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      expect(within(reel).getByRole('status')).toHaveTextContent('Loading post');

      const newest = heldReads.at(-1);
      expect(newest?.bodyLoading && !newest.signal?.aborted).toBe(true);
      act(() => {
        newest?.answer();
      });
      expect((await screen.findAllByRole('heading', { name: 'Shared Campaign' })).length).toBeGreaterThan(1);
      // Room as #457 gave, so a wait above that never passes fails on its own assertion.
    }, 15_000);
  });

  // A failed page left `hasMore` true and loading ended, and the reel asked for
  // the page again at once, for as long as it kept failing; the grid's error
  // was drawn behind the reel, where no one could see it.
  it('tells the reel a page failed, so it stops asking and offers Retry', async () => {
    const firstItem = createShowcaseItem({ id: 'post-1', title: 'Campaign Frame', generationId: 'gen-1' });
    const secondItem = createShowcaseItem({
      id: 'post-2',
      title: 'Second Campaign Frame',
      generationId: 'gen-2',
      mediaUrl: 'https://example.com/second.jpg',
    });
    const thirdItem = createShowcaseItem({
      id: 'post-3',
      title: 'Third Campaign Frame',
      generationId: 'gen-3',
      mediaUrl: 'https://example.com/third.jpg',
    });
    let failing = true;
    const feedFetch = vi.fn(async () => failing
      ? { ok: false, status: 500, json: async () => ({ error: 'Failed' }) }
      : {
        ok: true,
        status: 200,
        json: async () => ({
          items: [thirdItem],
          pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 2 },
        }),
      });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/feed?')) {
        return feedFetch();
      }
      if (url.startsWith('/api/showcase/saved-state')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({ success: true }) };
    }));
    vi.spyOn(window.history, 'pushState');

    render(
      <ShowcaseClient
        initialFeed={createFeed([firstItem, secondItem], { hasMore: true, nextOffset: 2, limit: 2 })}
        initialCategory="all"
        initialSort="recent"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));
    const reel = await screen.findByRole('dialog', { name: 'Explore reel viewer' });
    // One post after the open one: the reel asks for the next page, which fails.
    const notice = await within(reel).findByRole('alert');
    expect(notice).toHaveTextContent('Could not load more posts.');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(feedFetch).toHaveBeenCalledTimes(1);

    failing = false;
    fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(feedFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(within(screen.getByRole('dialog', { name: 'Explore reel viewer' })).queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('keeps the comment count a thread read in the reel when the reel opens on that post again', async () => {
    vi.spyOn(window.history, 'pushState');
    // Back from the reel, sooner than a browser: the URL loses `post` and popstate fires at once (a browser fires it in a later task).
    vi.spyOn(window.history, 'back').mockImplementation(() => {
      window.history.replaceState(null, '', '/showcase');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/posts/post-1/comments')) {
        return {
          ok: true,
          json: async () => ({
            postId: 'post-1',
            postCreatorId: 'creator-1',
            commentCount: 3,
            comments: [],
            pageInfo: { hasMore: false, nextOffset: null, limit: 20, offset: 0 },
          }),
        };
      }
      if (url.startsWith('/api/showcase/saved-state')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({ success: true }) };
    }));

    renderShowcase(createShowcaseItem());

    fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));
    const reel = await screen.findByRole('dialog', { name: 'Explore reel viewer' });
    fireEvent.click(await within(reel).findByRole('button', { name: 'Show comments on Campaign Frame (0)' }));
    expect(await within(reel).findByRole('button', { name: 'Hide comments on Campaign Frame (3)' })).toBeInTheDocument();

    fireEvent.click(within(reel).getByRole('button', { name: 'Explore' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Explore reel viewer' })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));
    const reopened = await screen.findByRole('dialog', { name: 'Explore reel viewer' });
    expect(await within(reopened).findByRole('button', { name: 'Show comments on Campaign Frame (3)' })).toBeInTheDocument();
    // Opens the reel twice and a comment thread once: 5,016 ms at the start of a PR run's web
    // suite on a GitHub runner (#459), about 360 ms here, as on main before it. Room as #457 gave.
  }, 15_000);

  it('closes the reel when Explore is pressed before the render that drew the count has run its effects', async () => {
    // As above, popstate fires inside `back()`. That order is half of the race this test was
    // written for (#521): ShowcaseClient's own popstate listener cleared the post before the
    // stale effect selected it again, so the three updates netted to nothing and React dropped
    // the render. The stale effect now stops at the closing guard (`closingPostIdRef`), so the
    // test holds that guard against this order as well.
    vi.spyOn(window.history, 'back').mockImplementation(() => {
      window.history.replaceState(null, '', '/showcase');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/posts/post-1/comments')) {
        return {
          ok: true,
          json: async () => ({
            postId: 'post-1',
            postCreatorId: 'creator-1',
            commentCount: 3,
            comments: [],
            pageInfo: { hasMore: false, nextOffset: null, limit: 20, offset: 0 },
          }),
        };
      }
      if (url.startsWith('/api/showcase/saved-state')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({ success: true }) };
    }));

    renderShowcase(createShowcaseItem());

    fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));
    const reel = await screen.findByRole('dialog', { name: 'Explore reel viewer' });
    // On main's loaded runner a test can resume after a `findBy` before React has run the
    // passive effects of the render it found: Testing Library resumes through `setTimeout(0)`,
    // React flushes those effects on `setImmediate`, and a millisecond of other work lets the
    // timer win. The render that drew the count then runs its URL effect after Explore, still
    // holding `post=post-1`, which selected the post again before the closing guard
    // (2026-10-13/14, 10-20 and 10-22 on main). A mutation observer takes that slot every time:
    // its callback is a microtask after the commit. The button's name is its aria-label, so a
    // selector finds it cheaply.
    const observer = new MutationObserver(() => {
      if (!reel.querySelector('button[aria-label="Hide comments on Campaign Frame (3)"]')) return;
      observer.disconnect();
      fireEvent.click(within(reel).getByRole('button', { name: 'Explore' }));
    });
    observer.observe(reel, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label'] });
    fireEvent.click(await within(reel).findByRole('button', { name: 'Show comments on Campaign Frame (0)' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Explore reel viewer' })).not.toBeInTheDocument();
    });
    // The same work as the test above, which needed this room on a GitHub runner (#459).
  }, 15_000);

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

    // The viewer's own page brings the cursor, and the sentinel observes again with a
    // `loadMore` that reads it: that effect depends on the page. findByText can return before
    // React has run that commit's effects, as on main's loaded runner, and the newest sentinel
    // observer then still held the first page's offset, so the next page came by offset and
    // the cursor read never did (shown with Testing Library's post-query drain removed). The
    // new tile is observed in the same commit's effects, as #468 found, so wait for it first.
    const observing = (matches: (target: Element) => boolean) => intersectionObservers.filter((observer) => (
      observer.observedTargets.some(matches)
    ));
    await waitFor(() => {
      expect(observing((target) => target.getAttribute('data-showcase-post-id') === 'post-ranked')).not.toHaveLength(0);
    });
    const loadMoreObserver = observing((target) => (
      target.getAttribute('data-showcase-load-more-sentinel') === 'true' && target.isConnected
    )).at(-1);
    expect(loadMoreObserver).toBeDefined();
    act(() => {
      loadMoreObserver?.trigger(true);
    });

    await waitFor(() => {
      expect(feedFetch).toHaveBeenCalledWith(expect.stringContaining('cursor=cursor-1'));
    });

    expect(await screen.findByText('More for you')).toBeInTheDocument();
    expect(feedFetch).toHaveBeenCalledWith(expect.stringContaining('cursor=cursor-1'));
    // About 200 ms here, as long as the comment-count test that took 5,016 ms on a GitHub
    // runner (#459). Room as #457 gave, so a wait above that never passes fails on its own
    // assertion, not on the test's timeout.
  }, 15_000);

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

  // The first page is built for everyone and carries no deliveries. The tiles
  // drawn from it stayed the objects they were when the viewer's own page
  // came, so the most-seen rows of Explore never reported an impression.
  it("reports a drawn tile's impression with the delivery the viewer's own page gave it", async () => {
    resetShowcaseFeedEventQueueForTests();
    const rankedCopy = createShowcaseItem({
      recommendation: { deliveryId: 'delivery-drawn', position: 0, reason: 'Based on your saves', algorithmVersion: 'for-you-rules-v4' },
    });
    const rankedNext = createShowcaseItem({
      id: 'post-ranked-next',
      generationId: 'gen-ranked-next',
      title: 'Ranked Next',
      recommendation: { deliveryId: 'delivery-next', position: 1, reason: 'Fresh creator', algorithmVersion: 'for-you-rules-v4' },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/feed?')) {
        return {
          ok: true,
          json: async () => ({
            items: [rankedCopy, rankedNext],
            feedSessionId: 'session-ranked',
            pageInfo: { hasMore: false, nextOffset: null, nextCursor: null, limit: 12, offset: 0 },
          }),
        };
      }
      return { ok: true, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { success: true }) };
    }));

    render(
      <ShowcaseClient
        initialFeed={createFeed(createShowcaseItem(), { hasMore: true, nextOffset: 12, limit: 12 })}
        initialCategory="all"
        initialSort="for-you"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    expect(await screen.findByText('Ranked Next')).toBeInTheDocument();
    // The drawn tile keeps its place.
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'Campaign Frame',
      'Ranked Next',
    ]);

    // The viewer's own page gives post-1 a delivery, and its tile observes again
    // for it: the impression effect depends on the item. findByText can return
    // before React has run that commit's effects, as on a busy runner, and the
    // observer found then still held the first page's item, whose impression has
    // no delivery and is not sent (main's Quality run 38942335920, 2026-10-16).
    // The new tile is observed in the same commit's effects.
    const observing = (postId: string) => intersectionObservers.filter((observer) => observer.observedTargets.some((target) => (
      target.getAttribute('data-showcase-post-id') === postId
    )));
    await waitFor(() => expect(observing('post-ranked-next')).not.toHaveLength(0));
    const tileObserver = observing('post-1').at(-1);
    vi.useFakeTimers();
    act(() => {
      tileObserver?.trigger(true, { intersectionRatio: 1 });
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      await flushShowcaseFeedEvents();
    });

    const sentEvents = vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input) === '/api/showcase/feed/events')
      .flatMap(([, init]) => JSON.parse(String(init?.body)).events ?? []);
    expect(sentEvents).toContainEqual(expect.objectContaining({
      eventType: 'impression',
      postId: 'post-1',
      deliveryId: 'delivery-drawn',
      feedSessionId: 'session-ranked',
    }));
  });

  // Until the viewer's own For you page comes, the first page has no cursor,
  // and Load More did nothing: for a guest that page waits on a first
  // interaction, and the button was not one.
  it("asks for a guest's own For you page from Load More, then follows its cursor", async () => {
    authState.session = null;
    authState.user = null;
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    }));
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const rankedItem = createShowcaseItem({
      id: 'post-ranked',
      generationId: 'gen-ranked',
      title: 'Ranked for you',
      recommendation: { deliveryId: 'delivery-ranked', position: 0, reason: 'Popular', algorithmVersion: 'for-you-rules-v4' },
    });
    const continuedItem = createShowcaseItem({ id: 'post-continued', generationId: 'gen-continued', title: 'More for you' });
    const feedRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/feed?')) {
        feedRequests.push(url);
        return {
          ok: true,
          json: async () => (url.includes('cursor=')
            ? {
              items: [continuedItem],
              feedSessionId: 'guest-session',
              pageInfo: { hasMore: false, nextOffset: null, nextCursor: null, limit: 12, offset: 12 },
            }
            : {
              items: [rankedItem],
              feedSessionId: 'guest-session',
              pageInfo: { hasMore: true, nextOffset: 12, nextCursor: 'cursor-2', limit: 12, offset: 0 },
            }),
        };
      }
      return { ok: true, json: async () => ({ success: true }) };
    }));

    render(
      <ShowcaseClient
        initialFeed={createFeed(createShowcaseItem({ title: 'Server fallback' }), { hasMore: true, nextOffset: 12, limit: 12 })}
        initialCategory="all"
        initialSort="for-you"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );
    await act(async () => Promise.resolve());
    expect(feedRequests).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Load More' }));

    expect(await screen.findByText('Ranked for you')).toBeInTheDocument();
    expect(feedRequests).toEqual([`/api/showcase/feed?limit=${SHOWCASE_PAGE_SIZE}&category=media`]);
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'Server fallback',
      'Ranked for you',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Load More' }));

    expect(await screen.findByText('More for you')).toBeInTheDocument();
    expect(feedRequests[1]).toBe(`/api/showcase/feed?limit=${SHOWCASE_PAGE_SIZE}&cursor=cursor-2&category=media`);
  });

  it("says so with Retry when the viewer's own For you page cannot be had, and Retry asks again", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const settle = () => act(async () => {
      for (let tick = 0; tick < 20; tick += 1) {
        await Promise.resolve();
      }
    });
    let failing = true;
    const rankedItem = createShowcaseItem({
      id: 'post-ranked',
      generationId: 'gen-ranked',
      title: 'Ranked for you',
      recommendation: { deliveryId: 'delivery-ranked', position: 0, reason: 'Based on your saves', algorithmVersion: 'for-you-rules-v4' },
    });
    const feedFetch = vi.fn(async () => (failing
      ? { ok: false, status: 503, json: async () => ({ error: 'Temporarily unavailable' }) }
      : {
        ok: true,
        status: 200,
        json: async () => ({
          items: [rankedItem],
          feedSessionId: 'session-1',
          pageInfo: { hasMore: true, nextOffset: 12, nextCursor: 'cursor-2', limit: 12, offset: 0 },
        }),
      }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/feed?')) {
        return feedFetch();
      }
      return { ok: true, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { success: true }) };
    }));

    render(
      <ShowcaseClient
        initialFeed={createFeed(createShowcaseItem({ title: 'Server fallback' }), { hasMore: true, nextOffset: 12, limit: 12 })}
        initialCategory="all"
        initialSort="for-you"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    await settle();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await settle();
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    await settle();

    // The first try and its two retries, then the row that says so.
    expect(feedFetch).toHaveBeenCalledTimes(3);
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('Could not load more posts');

    failing = false;
    fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    await settle();

    expect(feedFetch).toHaveBeenCalledTimes(4);
    expect(screen.getByText('Ranked for you')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // A viewer's own page that came without a cursor (no session was kept for
  // it) still says there is more: the next page is asked for by offset.
  it("goes on by offset when the viewer's own For you page came without a cursor", async () => {
    const feedRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/feed?')) {
        feedRequests.push(url);
        return {
          ok: true,
          json: async () => (url.includes('offset=')
            ? {
              items: [createShowcaseItem({ id: 'post-later', generationId: 'gen-later', title: 'Later by offset' })],
              pageInfo: { hasMore: false, nextOffset: null, nextCursor: null, limit: 12, offset: 12 },
            }
            : {
              items: [createShowcaseItem({ id: 'post-own', generationId: 'gen-own', title: 'Own page' })],
              pageInfo: { hasMore: true, nextOffset: 12, nextCursor: null, limit: 12, offset: 0 },
            }),
        };
      }
      return { ok: true, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { success: true }) };
    }));

    render(
      <ShowcaseClient
        initialFeed={createFeed(createShowcaseItem({ title: 'Server fallback' }), { hasMore: true, nextOffset: 12, limit: 12 })}
        initialCategory="all"
        initialSort="for-you"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );
    expect(await screen.findByText('Own page')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load More' }));

    expect(await screen.findByText('Later by offset')).toBeInTheDocument();
    expect(feedRequests).toEqual([
      `/api/showcase/feed?limit=${SHOWCASE_PAGE_SIZE}&category=media`,
      `/api/showcase/feed?limit=${SHOWCASE_PAGE_SIZE}&offset=12&category=media`,
    ]);
  });

  // The app's end of Explore: "You're all caught up." on its For you, the
  // lane named otherwise. The web's lanes stopped with nothing said.
  it.each([
    { sort: 'for-you', filters: {}, message: "You're all caught up." },
    { sort: 'recent', filters: {}, message: "You've reached the end of Recent." },
    { sort: 'for-you', filters: { initialCategory: 'video' }, message: "You've reached the end of Videos." },
    { sort: 'top-saves', filters: { initialUnlock: 'free' }, message: "You've reached the end of Free." },
  ] as const)('ends the $sort lane with "$message" and a Refresh', ({ sort, filters, message }) => {
    authState.session = null;
    authState.user = null;
    render(
      <ShowcaseClient
        initialFeed={createFeed(createShowcaseItem())}
        initialCategory="all"
        initialSort={sort}
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
        {...filters}
      />
    );

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Load More' })).not.toBeInTheDocument();
  });

  it('says nothing about an end while the lane has more', () => {
    authState.session = null;
    authState.user = null;
    render(
      <ShowcaseClient
        initialFeed={createFeed(createShowcaseItem(), { hasMore: true, nextOffset: 12, limit: 12 })}
        initialCategory="all"
        initialSort="recent"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    expect(screen.getByRole('button', { name: 'Load More' })).toBeInTheDocument();
    expect(screen.queryByText(/reached the end|all caught up/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  });

  it('refreshes a lane from its end: drops what was kept of it, asks for page one and opens it at the top', async () => {
    const cacheKey = buildShowcaseClientCacheKey({
      viewerId: 'user-1',
      category: 'all',
      sort: 'recent',
      tool: null,
      unlock: 'all',
      resource: 'all',
    });
    writeShowcaseClientSnapshot(cacheKey, {
      feed: createFeed(createShowcaseItem({ id: 'post-kept', generationId: 'gen-kept', title: 'Kept Frame' })),
      renderedItemCount: 1,
      savedItemIds: [],
    });
    let answerPageOne: (response: unknown) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/feed?')) {
        return new Promise((resolve) => {
          answerPageOne = resolve;
        });
      }
      return { ok: true, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { success: true }) };
    }));

    render(
      <ShowcaseClient
        initialFeed={createFeed(createShowcaseItem({ id: 'post-server', generationId: 'gen-server', title: 'Server Frame' }))}
        initialCategory="all"
        initialSort="recent"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );
    expect(screen.getByText('Kept Frame')).toBeInTheDocument();
    expect(screen.getByText("You've reached the end of Recent.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(readShowcaseClientSnapshot(cacheKey)).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      `/api/showcase/feed?limit=${SHOWCASE_PAGE_SIZE}&category=media&sort=recent`,
      { headers: { Authorization: 'Bearer test-token' } }
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();

    await act(async () => {
      answerPageOne({
        ok: true,
        json: async () => ({
          items: [createShowcaseItem({ id: 'post-fresh', generationId: 'gen-fresh', title: 'Fresh Frame' })],
          pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 0 },
        }),
      });
    });

    expect(await screen.findByText('Fresh Frame')).toBeInTheDocument();
    expect(screen.queryByText('Kept Frame')).not.toBeInTheDocument();
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  // A reload asks for the page afresh. The kept grid came back for ten
  // minutes after its last change, with the new session merged in under it.
  it('draws the server page, not the kept grid, when the browser reloaded Explore', () => {
    const cacheKey = buildShowcaseClientCacheKey({
      viewerId: 'user-1',
      category: 'all',
      sort: 'recent',
      tool: null,
      unlock: 'all',
      resource: 'all',
    });
    writeShowcaseClientSnapshot(cacheKey, {
      feed: createFeed(createShowcaseItem({ id: 'post-kept', generationId: 'gen-kept', title: 'Kept Frame' })),
      renderedItemCount: 1,
      savedItemIds: [],
    }, performance.timeOrigin - 60_000);
    vi.spyOn(performance, 'getEntriesByType').mockImplementation((entryType: string) => (
      entryType === 'navigation'
        ? [{ type: 'reload', name: window.location.href } as unknown as PerformanceEntry]
        : []
    ));

    render(
      <ShowcaseClient
        initialFeed={createFeed(createShowcaseItem({ id: 'post-server', generationId: 'gen-server', title: 'Server Frame' }))}
        initialCategory="all"
        initialSort="recent"
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    expect(screen.getByText('Server Frame')).toBeInTheDocument();
    expect(screen.queryByText('Kept Frame')).not.toBeInTheDocument();
  });

  // The filter bar stays on screen deep in the grid. A lane changed from
  // there opened at the bottom of the new, shorter page.
  it('opens another lane at the top, and keeps the place for a new page of the same lane or a new viewer', () => {
    const lane = (sort: ShowcaseSort, title: string) => (
      <ShowcaseClient
        initialFeed={createFeed(createShowcaseItem({ title }))}
        initialCategory="all"
        initialSort={sort}
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );
    const view = render(lane('recent', 'First page'));

    view.rerender(lane('recent', 'Same lane, new page'));
    authState.session = { access_token: 'other-token', user: { id: 'user-2' } };
    authState.user = { id: 'user-2' };
    view.rerender(lane('recent', 'Same lane, new page'));
    expect(window.scrollTo).not.toHaveBeenCalled();

    view.rerender(lane('top-saves', 'Saved lane'));

    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });
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

  // The server files the report as that delivery's `report` feed event, the
  // one way the ranker hears it.
  it('names the delivery a ranked tile was reported from', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderShowcase(createShowcaseItem({
      recommendation: { deliveryId: '812', position: 0, reason: 'Based on your saves', algorithmVersion: 'for-you-rules-v4' },
    }));

    chooseFromTileMenu('Campaign Frame', /report content/i);

    expect(await screen.findByRole('status')).toHaveTextContent('Content reported and removed from your feed.');
    expect(JSON.parse(String(requestTo('/api/posts/post-1/report')?.[1]?.body))).toEqual({
      reason: 'unsafe_content',
      details: 'Reported from the web Explore grid.',
      deliveryId: '812',
    });
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

  // The next post was picked by index from what was left, so the creator's
  // earlier post going too skipped one: [A1, B, A2*, C, D] landed on D.
  it("moves the reel to the post after the open one when Hide takes that creator's earlier posts too", async () => {
    vi.spyOn(window.history, 'pushState');
    const hiddenCreator = { id: 'creator-a', username: 'creator-a', name: 'Creator A', avatar: null };
    renderShowcase([
      createShowcaseItem({ id: 'post-a1', generationId: 'gen-a1', title: 'A One', creator: hiddenCreator }),
      createShowcaseItem({ id: 'post-b', generationId: 'gen-b', title: 'B Frame', creator: otherCreator }),
      createShowcaseItem({ id: 'post-a2', generationId: 'gen-a2', title: 'A Two', creator: hiddenCreator }),
      createShowcaseItem({ id: 'post-c', generationId: 'gen-c', title: 'C Frame', creator: otherCreator }),
      createShowcaseItem({ id: 'post-d', generationId: 'gen-d', title: 'D Frame', creator: otherCreator }),
    ]);

    fireEvent.click(screen.getByRole('img', { name: 'A Two' }));
    const reel = await screen.findByRole('dialog');
    fireEvent.click(await within(reel).findByRole('button', { name: /more actions for a two/i }));
    fireEvent.click(within(reel).getByRole('menuitem', { name: /hide @creator-a/i }));

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('post')).toBe('post-c');
    });
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /more actions for c frame/i }))
      .toBeInTheDocument();
  });

  it('moves the reel to the post before when Not interested takes the last one', async () => {
    vi.spyOn(window.history, 'pushState');
    renderShowcase([
      createShowcaseItem({ id: 'post-a1', generationId: 'gen-a1', title: 'A One' }),
      createShowcaseItem({ id: 'post-b', generationId: 'gen-b', title: 'B Frame', creator: otherCreator }),
    ]);

    fireEvent.click(screen.getByRole('img', { name: 'B Frame' }));
    const reel = await screen.findByRole('dialog');
    fireEvent.click(await within(reel).findByRole('button', { name: /more actions for b frame/i }));
    fireEvent.click(within(reel).getByRole('menuitem', { name: /not interested/i }));

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('post')).toBe('post-a1');
    });
  });

  it('names the delivery the reel showed when a ranked post is reported from it', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window.history, 'pushState');
    renderShowcase(createShowcaseItem({
      recommendation: { deliveryId: '812', position: 0, reason: 'Based on your saves', algorithmVersion: 'for-you-rules-v4' },
    }));

    fireEvent.click(screen.getByRole('img', { name: 'Campaign Frame' }));
    const reel = await screen.findByRole('dialog');
    fireEvent.click(await within(reel).findByRole('button', { name: /more actions for campaign frame/i }));
    fireEvent.click(within(reel).getByRole('menuitem', { name: /report content/i }));

    expect(await screen.findByText('Content reported and removed from your feed.')).toBeInTheDocument();
    expect(JSON.parse(String(requestTo('/api/posts/post-1/report')?.[1]?.body))).toEqual({
      reason: 'unsafe_content',
      details: 'Reported from the web reel.',
      deliveryId: '812',
    });
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

  // Undo for Not interested and Hide (D7, 2026-10-14): the tile's cell offers
  // it for five seconds; the tile comes back to its cell.
  describe('Undo', () => {
    const thirdCreator = { id: 'creator-3', username: 'third-creator', name: 'Third Creator', avatar: null };
    // Three tiles by three creators: Hide takes one tile.
    const frames = [
      createShowcaseItem({ id: 'post-a', generationId: 'gen-a', title: 'Frame A' }),
      createShowcaseItem({ id: 'post-b', generationId: 'gen-b', title: 'Frame B', creator: otherCreator }),
      createShowcaseItem({ id: 'post-c', generationId: 'gen-c', title: 'Frame C', creator: thirdCreator }),
    ];
    /** The grid's cells in order: each tile by its post, and the row where one left. */
    const gridCells = () => Array.from(
      document.querySelectorAll('[data-showcase-post-id], [role="group"][aria-label$=" hidden"]'),
      (cell) => cell.getAttribute('data-showcase-post-id') ?? 'Hidden · Undo',
    );
    const undoRequests = () => vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input) === '/api/showcase/feed/feedback/undo');
    function answer({ storeHide = Promise.resolve(), removed = true }: { storeHide?: Promise<void>; removed?: boolean } = {}) {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/showcase/feed/events') {
          await storeHide;
          return { ok: true, json: async () => ({ success: true }) };
        }
        if (url === '/api/showcase/feed/feedback/undo') {
          return { ok: true, json: async () => ({ ok: true, removed }) };
        }
        return { ok: true, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { success: true }) };
      }));
    }

    it("shows Hidden · Undo in the tile's cell for five seconds, then lets the removal stand", async () => {
      answer();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      renderShowcase(frames);
      expect(gridCells()).toEqual(['post-a', 'post-b', 'post-c']);

      chooseFromTileMenu('Frame B', /not interested/i);

      expect(gridCells()).toEqual(['post-a', 'Hidden · Undo', 'post-c']);
      expect(screen.queryByText('Frame B')).not.toBeInTheDocument();
      await act(async () => undefined);
      expect(screen.getByRole('status')).toHaveTextContent(/show you fewer posts like that/i);

      act(() => vi.advanceTimersByTime(FEED_REMOVAL_UNDO_MS - 1));
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));

      expect(gridCells()).toEqual(['post-a', 'post-c']);
      expect(undoRequests()).toEqual([]);
    });

    it('puts the tile back in its cell, takes the preference back once the hide is stored, and forgets it for the visit', async () => {
      let storeHide: () => void = () => undefined;
      answer({ storeHide: new Promise<void>((resolve) => { storeHide = resolve; }) });
      // What the tab learned of this viewer's own Not interested.
      rememberViewerExclusionsForVisit('user-1', { blockedCreatorIds: [], hiddenCreatorIds: [], hiddenPostIds: ['post-b'] });
      renderShowcase(frames);

      chooseFromTileMenu('Frame B', /not interested/i);
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

      expect(gridCells()).toEqual(['post-a', 'post-b', 'post-c']);
      expect(getFeedPreferencesHiddenThisVisit('user-1').postIds.has('post-b')).toBe(false);
      // The hide is still on its way: a delete now could land first.
      await act(async () => undefined);
      expect(undoRequests()).toEqual([]);

      await act(async () => storeHide());

      await waitFor(() => expect(undoRequests()).toHaveLength(1));
      const [, init] = undoRequests()[0];
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer test-token' }));
      expect(JSON.parse(String(init?.body))).toEqual({ feedbackType: 'not_interested', postId: 'post-b' });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('takes back the word that the post was hidden along with the post', async () => {
      answer();
      renderShowcase(frames);

      chooseFromTileMenu('Frame A', /not interested/i);
      expect(await screen.findByRole('status')).toHaveTextContent(/show you fewer posts like that/i);
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      await waitFor(() => expect(undoRequests()).toHaveLength(1));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it("keeps a guest's Undo on the page and sends nothing", async () => {
      authState.session = null;
      authState.user = null;
      answer();
      renderShowcase(frames);

      chooseFromTileMenu('Frame A', /not interested/i);
      expect(gridCells()).toEqual(['Hidden · Undo', 'post-b', 'post-c']);
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await act(async () => undefined);

      expect(gridCells()).toEqual(['post-a', 'post-b', 'post-c']);
      expect(undoRequests()).toEqual([]);
    });

    it("keeps the tile and says so when the server kept the preference", async () => {
      answer({ removed: false });
      renderShowcase(frames);

      chooseFromTileMenu('Frame C', /hide @/i);
      expect(gridCells()).toEqual(['post-a', 'post-b', 'Hidden · Undo']);
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t undo that. It stays hidden on your next visit.');
      expect(gridCells()).toEqual(['post-a', 'post-b', 'post-c']);
    });
  });

  // "New posts" (D2, 2026-10-14): on a return to the tab five minutes or more
  // after For you came, the newest-post probe is asked, and only the pill's
  // tap asks for a page.
  describe('New posts', () => {
    const OPENED_AT = Date.parse('2026-03-28T12:00:00.000Z');
    let visibility: DocumentVisibilityState = 'visible';
    const setVisibility = (next: DocumentVisibilityState) => {
      visibility = next;
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    };
    const comeBackAfter = async (minutes: number) => {
      setVisibility('hidden');
      vi.setSystemTime(OPENED_AT + minutes * 60_000);
      setVisibility('visible');
      await act(async () => undefined);
    };
    const laneRequests = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith('/api/showcase/feed?'));
    const probeRequests = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith('/api/showcase/feed/newest'));
    const renderLane = (sort: ShowcaseSort) => render(
      <ShowcaseClient
        initialFeed={createFeed(createShowcaseItem())}
        initialCategory="all"
        initialSort={sort}
        initialTool={null}
        initialUnlock="all"
        initialResource="all"
        sourceToolOptions={SOURCE_TOOL_OPTIONS}
      />
    );

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(OPENED_AT);
      visibility = 'visible';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/showcase/feed/newest')) {
          return { ok: true, json: async () => ({ newestPostId: 'post-new', newestPublishedAt: '2026-03-29T08:00:00.000Z' }) };
        }
        if (url.startsWith('/api/showcase/feed?')) {
          return {
            ok: true,
            json: async () => createFeed(laneRequests().length > 1
              ? [createShowcaseItem({ id: 'post-new', generationId: 'gen-new', title: 'Newest Frame' }), createShowcaseItem()]
              : createShowcaseItem()),
          };
        }
        return { ok: true, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { success: true }) };
      }));
    });

    afterEach(() => {
      delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
      Reflect.deleteProperty(window, 'scrollY');
    });

    it('shows on a return to For you five minutes after it came, asks for no page, and its tap refreshes from the top', async () => {
      renderLane('for-you');
      // The viewer's own For you page, as every signed-in visit asks for it.
      await waitFor(() => expect(laneRequests()).toHaveLength(1));
      await act(async () => undefined);

      await comeBackAfter(4);
      expect(probeRequests()).toEqual([]);

      await comeBackAfter(10);
      const pill = await screen.findByRole('button', { name: 'New posts' });
      expect(probeRequests()).toHaveLength(1);
      const [probeUrl, probeInit] = probeRequests()[0];
      expect(String(probeUrl)).toBe('/api/showcase/feed/newest?category=media');
      expect(probeInit?.headers).toBeUndefined();
      expect(laneRequests()).toHaveLength(1);

      Object.defineProperty(window, 'scrollY', { configurable: true, value: 900 });
      fireEvent.click(pill);

      expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
      expect(screen.queryByRole('button', { name: 'New posts' })).not.toBeInTheDocument();
      expect(await screen.findByText('Newest Frame')).toBeInTheDocument();
      expect(laneRequests()).toHaveLength(2);
      expect(laneRequests()[1][1]).toEqual({ headers: { Authorization: 'Bearer test-token' } });
    });

    it('never asks about Recent', async () => {
      renderLane('recent');
      await act(async () => undefined);

      await comeBackAfter(30);

      expect(probeRequests()).toEqual([]);
      expect(screen.queryByRole('button', { name: 'New posts' })).not.toBeInTheDocument();
    });
  });
});
