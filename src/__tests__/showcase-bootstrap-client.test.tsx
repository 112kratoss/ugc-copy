import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseBootstrapClient, {
  type ShowcaseBootstrapClientProps,
} from '@/app/showcase/ShowcaseBootstrapClient';
import { SHOWCASE_INITIAL_RENDER_COUNT, type ShowcaseFeedItem } from '@/lib/showcase';
import {
  buildShowcaseClientCacheKey,
  clearShowcaseClientCacheForTests,
  writeShowcaseClientSnapshot,
} from '@/lib/showcase-client-cache';

const authState = vi.hoisted(() => ({
  session: null as { access_token: string } | null,
  user: null as { id: string } | null,
  isLoading: false,
}));
const fullClientModuleLoaded = vi.hoisted(() => vi.fn());
const fullClientProps = vi.hoisted(() => vi.fn());

vi.mock('@/app/components/AuthProvider', () => ({
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
  });

  it('paints a full grid prefix with SSR-compatible links before the full client loads', async () => {
    render(<ShowcaseBootstrapClient {...createProps()} />);

    await act(async () => Promise.resolve());

    expect(fullClientModuleLoaded).not.toHaveBeenCalled();
    expect(screen.queryByTestId('full-showcase-client')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Showcase' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Showcase filters' })).toBeInTheDocument();
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

  it('hands off during idle time without manufacturing anonymous personalization demand', async () => {
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

      expect(screen.getByTestId('full-showcase-client')).toBeInTheDocument();
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

      fireEvent.click(screen.getByRole('button', { name: 'Open Priority campaign in viewer' }));

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

  it('does not replace the bootstrap while keyboard focus is inside it', async () => {
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
      expect(screen.getByTestId('full-showcase-client')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('imports the full client on card activation and opens the selected post query', async () => {
    const props = createProps();
    render(<ShowcaseBootstrapClient {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Priority campaign in viewer' }));

    await waitFor(() => {
      expect(screen.getByTestId('full-showcase-client')).toBeInTheDocument();
    });
    expect(new URLSearchParams(window.location.search).get('post')).toBe('post-priority');
    expect(fullClientProps).toHaveBeenLastCalledWith(expect.objectContaining({
      initialFeed: props.initialFeed,
      initialPriorityPoster: props.initialPriorityPoster,
    }));
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
});
