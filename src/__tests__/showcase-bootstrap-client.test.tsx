import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseBootstrapClient, {
  type ShowcaseBootstrapClientProps,
} from '@/app/showcase/ShowcaseBootstrapClient';
import {
  EXPLORE_ACTIVE_FILTER_PILL_CLASS,
  EXPLORE_ACTIVE_FILTER_ROW_CLASS,
} from '@/app/showcase/explore-active-filters';
import { createReelEntryState } from '@/lib/reel-history-entry';
import { SHOWCASE_INITIAL_RENDER_COUNT, type ShowcaseFeedItem } from '@/lib/showcase';
import {
  buildShowcaseClientCacheKey,
  clearShowcaseClientCacheForTests,
  rememberViewerExclusionsForVisit,
  takeBlockedCreatorOffClientFeeds,
  writeShowcaseClientSnapshot,
} from '@/lib/showcase-client-cache';

const authState = vi.hoisted(() => ({
  session: null as { access_token: string } | null,
  user: null as { id: string } | null,
  isLoading: false,
}));
const fullClientModuleLoaded = vi.hoisted(() => vi.fn());
const fullClientProps = vi.hoisted(() => vi.fn());

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => authState,
}));

vi.mock('@/app/showcase/ShowcaseClient', () => {
  fullClientModuleLoaded();
  return {
    default: (props: ShowcaseBootstrapClientProps) => {
      fullClientProps(props);
      return <div data-testid="full-showcase-client">Full showcase</div>;
    },
  };
});

function createItem(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-priority',
    mediaUrl: 'https://example.com/priority.mp4',
    mediaKind: 'video',
    mediaItems: [{
      id: 'media-priority',
      url: 'https://example.com/priority.mp4',
      previewUrl: 'https://example.com/priority.webp',
      mediaKind: 'video',
      contentType: 'video/mp4',
      originalName: 'priority.mp4',
      width: 1080,
      height: 1350,
      durationSeconds: 8,
      sortOrder: 0,
    }],
    model: 'veo',
    title: 'Priority campaign',
    prompt: 'A creator holds the product by a bright window.',
    body: '',
    category: 'video',
    postFormat: 'media',
    saveCount: 7,
    remixCount: 3,
    commentCount: 0,
    createdAt: '2026-07-16T10:00:00.000Z',
    creator: {
      id: 'creator-1',
      username: 'creator-one',
      name: 'Creator One',
      avatar: null,
    },
    sourceKind: 'magicbooklet',
    sourceTool: 'magicbooklet',
    generationId: 'generation-1',
    asset: null,
    canRemix: true,
    ...overrides,
  };
}

function createProps(): ShowcaseBootstrapClientProps {
  // One more item than the shell paints, so the prefix boundary is testable.
  const trailingItems = Array.from({ length: SHOWCASE_INITIAL_RENDER_COUNT }, (_, index) => createItem({
    id: `post-trailing-${index + 1}`,
    title: `Trailing campaign ${index + 1}`,
  }));

  return {
    initialFeed: {
      items: [createItem(), ...trailingItems],
      pageInfo: {
        hasMore: true,
        nextOffset: 12,
        limit: 12,
        offset: 0,
      },
    },
    initialCategory: 'all',
    initialSort: 'for-you',
    initialTool: null,
    initialUnlock: 'all',
    initialResource: 'all',
    sourceToolOptions: [],
    initialPriorityPoster: {
      postId: 'post-priority',
      mediaId: 'media-priority',
      dataUrl: 'data:image/webp;base64,UklGRg==',
    },
  };
}

describe('ShowcaseBootstrapClient', () => {
  beforeEach(() => {
    clearShowcaseClientCacheForTests();
    window.history.replaceState(null, '', '/showcase');
    authState.session = null;
    authState.user = null;
    authState.isLoading = false;
    fullClientModuleLoaded.mockClear();
    fullClientProps.mockClear();
    vi.stubGlobal('IntersectionObserver', vi.fn(function IntersectionObserverMock() {
      return {
        root: null,
        rootMargin: '160px 0px',
        thresholds: [0],
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
        takeRecords: vi.fn(() => []),
      } satisfies IntersectionObserver;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // The history spies, so a count in one test never includes another's calls.
    vi.restoreAllMocks();
  });

  it('paints a full grid prefix with SSR-compatible links before the full client loads', async () => {
    render(<ShowcaseBootstrapClient {...createProps()} />);

    await act(async () => Promise.resolve());

    expect(fullClientModuleLoaded).not.toHaveBeenCalled();
    expect(screen.queryByTestId('full-showcase-client')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Explore' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Explore filters' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Images' })).toHaveAttribute(
      'href',
      '/showcase?category=image'
    );
    expect(screen.getByRole('link', { name: 'Recent' })).toHaveAttribute(
      'href',
      '/showcase?sort=recent'
    );

    const priorityImage = screen.getByRole('img', { name: 'Priority campaign' });
    expect(priorityImage).toHaveAttribute('src', 'data:image/webp;base64,UklGRg==');
    expect(priorityImage).toHaveAttribute('loading', 'eager');
    expect(priorityImage).toHaveAttribute('fetchpriority', 'high');
    expect(priorityImage.parentElement).toHaveStyle({ aspectRatio: '4 / 5' });

    // The shell fills the grid, but only the priority card attaches media.
    const cards = document.querySelectorAll('[data-showcase-bootstrap-card="true"]');
    expect(cards).toHaveLength(SHOWCASE_INITIAL_RENDER_COUNT);
    expect(screen.queryByRole('img', { name: 'Trailing campaign 1' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(1);

    // Items past the prefix wait for the interactive client.
    expect(screen.queryByText(`Trailing campaign ${SHOWCASE_INITIAL_RENDER_COUNT}`)).not.toBeInTheDocument();
  });

  // Drawn by the full page alone, the row moved the grid down as it took over: under a visitor's
  // first scroll, or just after a signed-in reader's load (web sweep, 2026-11-17; measured by
  // tests/e2e/explore-filter-row-steady.spec.ts).
  it("draws the lane's active filters in the full page's row, each a link to the lane without it", async () => {
    render(
      <ShowcaseBootstrapClient
        {...createProps()}
        initialSort="recent"
        initialTool="kling"
        initialUnlock="with-unlock"
        initialResource="prompt"
        sourceToolOptions={[{ slug: 'veo', label: 'Veo' }, { slug: 'kling', label: 'Kling' }]}
      />
    );

    const row = document.querySelector<HTMLElement>('[data-explore-active-filters]');
    expect(row).not.toBeNull();
    // In the filter bar, under its controls, as the full page draws it.
    expect(row!.parentElement).toBe(screen.getByRole('navigation', { name: 'Explore filters' }));
    expect(row!.className).toBe(EXPLORE_ACTIVE_FILTER_ROW_CLASS);
    const pills = within(row!).getAllByRole('link');
    expect(pills.map((pill) => [pill.textContent, pill.getAttribute('href')])).toEqual([
      ['Kling', '/showcase?sort=recent&unlock=with-unlock&resource=prompt'],
      ['Recipes', '/showcase?sort=recent&tool=kling&resource=prompt'],
      ['Prompts', '/showcase?sort=recent&tool=kling&unlock=with-unlock'],
    ]);
    for (const pill of pills) {
      expect(pill.className).toBe(EXPLORE_ACTIVE_FILTER_PILL_CLASS);
      expect(pill.querySelector('svg.lucide-x')).not.toBeNull();
    }
    // The kind and sort links keep the lane's filters.
    expect(screen.getByRole('link', { name: 'Images' })).toHaveAttribute(
      'href',
      '/showcase?category=image&sort=recent&tool=kling&unlock=with-unlock&resource=prompt'
    );

    // A press on one is its own page load, as on the shell's other filter links: it does not wake the full page.
    fireEvent.pointerDown(pills[0], { button: 0 });
    // The shell marks itself busy in the same task a hand-over starts, before the full page's
    // module is asked for, so this fails at once where a hand-over began.
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    await act(async () => Promise.resolve());
    expect(fullClientModuleLoaded).not.toHaveBeenCalled();
  });

  it('draws no row of active filters on a lane without one', () => {
    const { unmount } = render(<ShowcaseBootstrapClient {...createProps()} initialCategory="video" initialSort="recent" />);
    expect(document.querySelector('[data-explore-active-filters]')).toBeNull();
    unmount();

    // `tool=` and `tool=all` filter by no tool.
    render(<ShowcaseBootstrapClient {...createProps()} initialTool="" />);
    expect(document.querySelector('[data-explore-active-filters]')).toBeNull();
  });

  // From 640px the header's eyebrow shows. Its line box takes its height from its first item, and
  // the shell's 8px dot drew it 3px taller than the full page's icon: the grid moved up by 3px as
  // the full page took over, on every lane.
  it("leads the header's eyebrow with the full page's icon", () => {
    render(<ShowcaseBootstrapClient {...createProps()} />);

    const eyebrow = screen.getByText('Creator community');
    expect(eyebrow.firstElementChild).toHaveClass('lucide-trending-up', 'h-3.5', 'w-3.5');
  });

  it('keeps the stable bootstrap through idle time without loading the heavy client', async () => {
    vi.useFakeTimers();
    const demandListener = vi.fn();
    window.addEventListener('showcase:demand', demandListener);
    try {
      render(<ShowcaseBootstrapClient {...createProps()} />);

      expect(screen.queryByTestId('full-showcase-client')).not.toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(1_200);
        await Promise.resolve();
      });
      await act(async () => Promise.resolve());

      expect(screen.queryByTestId('full-showcase-client')).not.toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'Priority campaign' })).toBeInTheDocument();
      expect(fullClientModuleLoaded).not.toHaveBeenCalled();
      expect(demandListener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('showcase:demand', demandListener);
      vi.useRealTimers();
    }
  });

  it('relays genuine card demand after the interactive client mounts', async () => {
    const demandListener = vi.fn();
    window.addEventListener('showcase:demand', demandListener);
    try {
      render(<ShowcaseBootstrapClient {...createProps()} />);

      fireEvent.click(screen.getByRole('link', { name: 'Open Priority campaign in viewer' }));

      expect(await screen.findByTestId('full-showcase-client')).toBeInTheDocument();
      await waitFor(() => expect(demandListener).toHaveBeenCalledTimes(1));
    } finally {
      window.removeEventListener('showcase:demand', demandListener);
    }
  });

  it('filters feed-only text posts before taking the handoff prefix', () => {
    const props = createProps();
    props.initialFeed.items.unshift(createItem({
      id: 'text-only-post',
      title: 'Creator note',
      category: 'text',
      postFormat: 'text',
      mediaUrl: null,
      mediaKind: null,
      mediaItems: [],
    }));

    render(<ShowcaseBootstrapClient {...props} />);

    expect(screen.queryByText('Creator note')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-showcase-bootstrap-card="true"]'))
      .toHaveLength(SHOWCASE_INITIAL_RENDER_COUNT);
    expect(screen.getByText(`Trailing campaign ${SHOWCASE_INITIAL_RENDER_COUNT - 1}`))
      .toBeInTheDocument();
    expect(screen.queryByText(`Trailing campaign ${SHOWCASE_INITIAL_RENDER_COUNT}`))
      .not.toBeInTheDocument();
  });

  // A viewer who blocks a creator on that creator's page is sent here. For
  // the moment before the full grid takes over, this shell draws the first
  // page, which the server builds for everyone.
  it('does not draw a creator who was blocked on another page a moment ago', () => {
    const props = createProps();
    // Past the prefix the shell paints, until the blocked creator's posts are out of the way.
    props.initialFeed.items.push(createItem({
      id: 'post-someone-else',
      title: 'Someone else',
      creator: { id: 'creator-2', username: 'creator-two', name: 'Creator Two', avatar: null },
    }));
    takeBlockedCreatorOffClientFeeds('creator-1');
    authState.user = { id: 'viewer-1' };

    render(<ShowcaseBootstrapClient {...props} />);

    expect(screen.getByText('Someone else')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-showcase-bootstrap-card="true"]')).toHaveLength(1);
    expect(screen.queryByText('Priority campaign')).not.toBeInTheDocument();
    expect(screen.queryByText(/Trailing campaign/)).not.toBeInTheDocument();
  });

  // Signing out, or in as someone else, does not reload the page.
  it("draws the whole first page for anyone but the viewer whose blocks the tab remembers", () => {
    const props = createProps();
    rememberViewerExclusionsForVisit('viewer-1', { blockedCreatorIds: ['creator-1'], hiddenCreatorIds: [], hiddenPostIds: [] });

    const signedOut = render(<ShowcaseBootstrapClient {...props} />);
    expect(screen.getByText('Priority campaign')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-showcase-bootstrap-card="true"]')).toHaveLength(SHOWCASE_INITIAL_RENDER_COUNT);
    signedOut.unmount();

    authState.user = { id: 'viewer-2' };
    render(<ShowcaseBootstrapClient {...props} />);
    expect(screen.getByText('Priority campaign')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-showcase-bootstrap-card="true"]')).toHaveLength(SHOWCASE_INITIAL_RENDER_COUNT);
  });

  // The grid asks the server what the viewer's own feed leaves out and the tab
  // keeps the answer. Hide and Not interested are For you's, as on the server.
  it('does not draw what the viewer hid, on For you, once the tab has been told', () => {
    const props = createProps();
    props.initialFeed.items.push(createItem({
      id: 'post-someone-else',
      title: 'Someone else',
      creator: { id: 'creator-2', username: 'creator-two', name: 'Creator Two', avatar: null },
    }));
    rememberViewerExclusionsForVisit('viewer-1', { blockedCreatorIds: [], hiddenCreatorIds: ['creator-1'], hiddenPostIds: [] });
    authState.user = { id: 'viewer-1' };

    const forYou = render(<ShowcaseBootstrapClient {...props} />);
    expect(screen.getByText('Someone else')).toBeInTheDocument();
    expect(screen.queryByText('Priority campaign')).not.toBeInTheDocument();
    forYou.unmount();

    render(<ShowcaseBootstrapClient {...props} initialSort="recent" />);
    expect(screen.getByText('Priority campaign')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-showcase-bootstrap-card="true"]')).toHaveLength(SHOWCASE_INITIAL_RENDER_COUNT);
  });

  it('prioritizes the first usable media instead of the first placeholder tile', () => {
    const props = createProps();
    props.initialFeed.items.unshift(createItem({
      id: 'pending-media-post',
      title: 'Pending media',
      category: 'image',
      postFormat: 'media',
      mediaUrl: null,
      mediaKind: null,
      mediaItems: [],
    }));

    render(<ShowcaseBootstrapClient {...props} />);

    const priorityImage = screen.getByRole('img', { name: 'Priority campaign' });
    expect(priorityImage).toHaveAttribute('loading', 'eager');
    expect(priorityImage).toHaveAttribute('fetchpriority', 'high');
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('does not replace the bootstrap merely because keyboard focus later leaves it', async () => {
    vi.useFakeTimers();
    try {
      render(<ShowcaseBootstrapClient {...createProps()} />);
      const imagesLink = screen.getByRole('link', { name: 'Images' });
      imagesLink.focus();

      await act(async () => {
        vi.advanceTimersByTime(1_200);
        await Promise.resolve();
      });

      expect(imagesLink).toHaveFocus();
      expect(screen.queryByTestId('full-showcase-client')).not.toBeInTheDocument();

      imagesLink.blur();
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });
      await act(async () => Promise.resolve());
      expect(screen.queryByTestId('full-showcase-client')).not.toBeInTheDocument();
      expect(fullClientModuleLoaded).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('imports the full client on card activation and opens the selected post query', async () => {
    const props = createProps();
    const pushState = vi.spyOn(window.history, 'pushState');
    render(<ShowcaseBootstrapClient {...props} />);

    fireEvent.click(screen.getByRole('link', { name: 'Open Priority campaign in viewer' }));

    await waitFor(() => {
      expect(screen.getByTestId('full-showcase-client')).toBeInTheDocument();
    });
    expect(new URLSearchParams(window.location.search).get('post')).toBe('post-priority');
    expect(pushState).toHaveBeenCalledTimes(1);
    // Marked as the reel's own entry, which the full client reads when it mounts on it
    // and when the browser's Back or Forward reaches it again (`reel-history-entry.ts`).
    expect(pushState).toHaveBeenCalledWith(createReelEntryState('post'), '', '/showcase?post=post-priority');
    expect(window.history.state).toEqual(createReelEntryState('post'));
    expect(fullClientProps).toHaveBeenLastCalledWith(expect.objectContaining({
      initialFeed: props.initialFeed,
      initialPriorityPoster: props.initialPriorityPoster,
    }));
  });

  it('pushes nothing for a shared link, whose entry stays unmarked', async () => {
    window.history.replaceState(null, '', '/showcase?post=post-shared');
    const pushState = vi.spyOn(window.history, 'pushState');

    render(<ShowcaseBootstrapClient {...createProps()} />);

    expect(await screen.findByTestId('full-showcase-client')).toBeInTheDocument();
    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.state).toBeNull();
  });

  // Its entry sits over the shared post's, not Explore's: marked as the reel's
  // own, the reel's close would go Back into the shared post's reel. Unmarked, it
  // closes onto Explore by replacing, as before, and Back reopens the shared post.
  it('leaves unmarked the entry a tap pushes over a shared link\'s', async () => {
    window.history.replaceState(null, '', '/showcase?post=post-shared');
    const pushState = vi.spyOn(window.history, 'pushState');
    render(<ShowcaseBootstrapClient {...createProps()} />);

    // Before the import the mount started for the shared post can settle.
    fireEvent.click(screen.getByRole('link', { name: 'Open Priority campaign in viewer' }));

    expect(await screen.findByTestId('full-showcase-client')).toBeInTheDocument();
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(pushState).toHaveBeenCalledWith(null, '', '/showcase?post=post-priority');
    expect(window.history.state).toBeNull();
  });

  // The cards stay until the full client comes, so a second tap can land first.
  it('points the entry its first tap pushed at a second card tapped before the full client comes', async () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    render(<ShowcaseBootstrapClient {...createProps()} />);

    // Both taps before the import's promise can settle (that takes a later microtask).
    fireEvent.click(screen.getByRole('link', { name: 'Open Priority campaign in viewer' }));
    fireEvent.click(screen.getByRole('link', { name: 'Open Trailing campaign 1 in viewer' }));

    expect(await screen.findByTestId('full-showcase-client')).toBeInTheDocument();
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(pushState).toHaveBeenCalledWith(createReelEntryState('post'), '', '/showcase?post=post-priority');
    // Still the reel's own entry.
    expect(replaceState).toHaveBeenCalledWith(createReelEntryState('post'), '', '/showcase?post=post-trailing-1');
    expect(new URLSearchParams(window.location.search).get('post')).toBe('post-trailing-1');
    expect(window.history.state).toEqual(createReelEntryState('post'));
  });

  it('pushes again for a tap after the reader went Back off the entry the first tap pushed', async () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    render(<ShowcaseBootstrapClient {...createProps()} />);

    fireEvent.click(screen.getByRole('link', { name: 'Open Priority campaign in viewer' }));
    // Back, sooner than a browser: the address is Explore's own entry again.
    window.history.replaceState(null, '', '/showcase');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    fireEvent.click(screen.getByRole('link', { name: 'Open Trailing campaign 1 in viewer' }));

    expect(await screen.findByTestId('full-showcase-client')).toBeInTheDocument();
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(pushState).toHaveBeenLastCalledWith(createReelEntryState('post'), '', '/showcase?post=post-trailing-1');
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.history.state).toEqual(createReelEntryState('post'));
  });

  it('activates the full experience immediately for an authenticated viewer', async () => {
    authState.session = { access_token: 'signed-in-token' };
    authState.user = { id: 'user-1' };

    render(<ShowcaseBootstrapClient {...createProps()} />);

    expect(await screen.findByTestId('full-showcase-client')).toBeInTheDocument();
  });

  it('restores the full experience immediately when an anonymous viewer returns', async () => {
    const props = createProps();
    const cacheKey = buildShowcaseClientCacheKey({
      viewerId: null,
      category: props.initialCategory,
      sort: props.initialSort,
      tool: props.initialTool,
      unlock: props.initialUnlock,
      resource: props.initialResource,
    });
    writeShowcaseClientSnapshot(cacheKey, {
      feed: props.initialFeed,
      renderedItemCount: 2,
      savedItemIds: [],
    });

    render(<ShowcaseBootstrapClient {...props} />);

    expect(await screen.findByTestId('full-showcase-client')).toBeInTheDocument();
  });
  // The reason the cards are anchors at all. They used to be <button onClick>,
  // so the server-rendered page carried zero hrefs to /showcase/[id] — a
  // crawler could see every card and follow none of them, which is why no
  // creation was ever indexed while creator links (plain anchors) were. Keep
  // the href canonical and query-free: it is the URL the sitemap submits.
  it('renders each card as a crawlable link to the canonical detail URL', () => {
    const props = createProps();
    render(<ShowcaseBootstrapClient {...props} />);

    const link = screen.getByRole('link', { name: 'Open Priority campaign in viewer' });

    expect(link).toHaveAttribute('href', '/showcase/post-priority');
  });

  // A modified click is the browser's to handle — open in a new tab has to keep
  // working, which it cannot if the handler swallows every click.
  it('leaves modified clicks to the browser instead of activating in page', () => {
    render(<ShowcaseBootstrapClient {...createProps()} />);

    const link = screen.getByRole('link', { name: 'Open Priority campaign in viewer' });
    fireEvent.click(link, { metaKey: true });

    expect(screen.queryByTestId('full-showcase-client')).not.toBeInTheDocument();
  });
});
