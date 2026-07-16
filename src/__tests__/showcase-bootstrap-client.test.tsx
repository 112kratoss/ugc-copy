import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseBootstrapClient, {
  type ShowcaseBootstrapClientProps,
} from '@/app/showcase/ShowcaseBootstrapClient';
import type { ShowcaseFeedItem } from '@/lib/showcase';

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
  return {
    initialFeed: {
      items: [createItem(), createItem({ id: 'post-deferred', title: 'Deferred campaign' })],
      pageInfo: {
        hasMore: true,
        nextOffset: 2,
        limit: 2,
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

  it('keeps the full client unloaded while SSR-compatible links and the exact poster stay usable', async () => {
    render(<ShowcaseBootstrapClient {...createProps()} />);

    await act(async () => Promise.resolve());

    expect(fullClientModuleLoaded).not.toHaveBeenCalled();
    expect(screen.queryByTestId('full-showcase-client')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Feed' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Showcase filters' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Images' })).toHaveAttribute(
      'href',
      '/showcase?category=image'
    );
    expect(screen.getByRole('link', { name: 'Recent' })).toHaveAttribute(
      'href',
      '/showcase?sort=recent'
    );
    expect(screen.getByRole('img', { name: 'Priority campaign' })).toHaveAttribute(
      'src',
      'data:image/webp;base64,UklGRg=='
    );
    expect(screen.getByRole('img', { name: 'Priority campaign' }).parentElement)
      .toHaveStyle({ aspectRatio: '4 / 5' });
    expect(screen.queryByText('Deferred campaign')).not.toBeInTheDocument();
  });

  it('imports the full client on card activation and opens the selected post query', async () => {
    const props = createProps();
    render(<ShowcaseBootstrapClient {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Priority campaign in viewer' }));

    await waitFor(() => {
      expect(screen.getByTestId('full-showcase-client')).toBeInTheDocument();
    });
    expect(new URLSearchParams(window.location.search).get('post')).toBe('post-priority');
    expect(fullClientModuleLoaded).toHaveBeenCalledTimes(1);
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
});
