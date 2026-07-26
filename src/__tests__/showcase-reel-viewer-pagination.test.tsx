import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseReelViewer from '@/app/showcase/ShowcaseReelViewer';
import type { ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/showcase';

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

vi.mock('next/script', () => ({
  default: ({ id }: { id?: string }) => <script data-testid={id ?? 'next-script'} />,
}));

const { mockPush, mockUpdateCredits, authState } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUpdateCredits: vi.fn(),
  authState: {
    session: null as { access_token: string } | null,
    credits: null as number | null,
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: authState.session,
    credits: authState.credits,
    updateCredits: mockUpdateCredits,
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

vi.mock('@/app/components/PublicShareButton', () => ({
  default: ({ label, className }: { label?: string; className?: string }) => (
    <button type="button" className={className}>
      {label ?? 'Share'}
    </button>
  ),
}));

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

function createVideoMedia(overrides: Partial<ShowcaseMediaItem> = {}): ShowcaseMediaItem {
  return {
    id: 'video-1',
    url: 'https://example.com/clip.mp4',
    previewUrl: 'https://example.com/clip-preview.webp',
    mediaKind: 'video',
    contentType: 'video/mp4',
    originalName: 'clip.mp4',
    width: 1280,
    height: 720,
    durationSeconds: 8,
    sortOrder: 0,
    ...overrides,
  };
}

function getMediaLoadingOverlay(container: HTMLElement) {
  return container.querySelector('[data-showcase-media-state="loading"]');
}

function createVideoReel(mediaItems: ShowcaseMediaItem[]) {
  return (
    <ShowcaseReelViewer
      isOpen
      items={[
        createShowcaseItem({
          mediaUrl: mediaItems[0]?.url ?? null,
          mediaKind: 'video',
          category: 'video',
          mediaItems,
        }),
      ]}
      selectedItemId="post-1"
      savedItemIds={new Set()}
      savingItemIds={new Set()}
      accessToken={null}
      hasMoreItems={false}
      isLoadingMoreItems={false}
      onLoadMoreItems={vi.fn()}
      onClose={vi.fn()}
      onSelectItemId={vi.fn()}
      onMediaIndexChange={vi.fn()}
      onToggleSave={vi.fn()}
      onRemix={vi.fn()}
      buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
    />
  );
}

function renderVideoReel(mediaItems: ShowcaseMediaItem[]) {
  return render(createVideoReel(mediaItems));
}

const paidAsset: NonNullable<ShowcaseFeedItem['asset']> = {
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
  previewText: 'Unlock the prompt and notes.',
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
};

const freeAsset: NonNullable<ShowcaseFeedItem['asset']> = {
  ...paidAsset,
  id: 'bundle-free-1',
  title: 'Free prompt pack',
  accessMode: 'free',
  priceUsdCents: 0,
  priceQuote: {
    currency: 'USD',
    amountSubunits: 0,
    formatted: 'Free',
    note: null,
  },
  previewText: 'Get the reusable prompt and notes free.',
};

function renderPaidReel() {
  return render(
    <ShowcaseReelViewer
      isOpen
      items={[
        createShowcaseItem({
          id: 'post-1',
          title: 'Paid Frame',
          asset: paidAsset,
        }),
      ]}
      selectedItemId="post-1"
      savedItemIds={new Set()}
      savingItemIds={new Set()}
      accessToken={null}
      hasMoreItems={false}
      isLoadingMoreItems={false}
      onLoadMoreItems={vi.fn()}
      onClose={vi.fn()}
      onSelectItemId={vi.fn()}
      onToggleSave={vi.fn()}
      onRemix={vi.fn()}
      buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
    />
  );
}

function renderFreeReel() {
  return render(
    <ShowcaseReelViewer
      isOpen
      items={[
        createShowcaseItem({
          id: 'post-1',
          title: 'Free Frame',
          asset: freeAsset,
        }),
      ]}
      selectedItemId="post-1"
      savedItemIds={new Set()}
      savingItemIds={new Set()}
      accessToken={null}
      hasMoreItems={false}
      isLoadingMoreItems={false}
      onLoadMoreItems={vi.fn()}
      onClose={vi.fn()}
      onSelectItemId={vi.fn()}
      onToggleSave={vi.fn()}
      onRemix={vi.fn()}
      buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
    />
  );
}

describe('ShowcaseReelViewer pagination', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockUpdateCredits.mockClear();
    authState.session = null;
    authState.credits = null;
    vi.unstubAllGlobals();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280);
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720);
  });

  it('keeps reel navigation and action controls at stable fixed sizes', () => {
    render(
      <ShowcaseReelViewer
        isOpen
        items={[createShowcaseItem({
          canRemix: true,
          mediaItems: [
            {
              id: 'image-1',
              url: 'https://example.com/image-1.jpg',
              mediaKind: 'image',
              contentType: 'image/jpeg',
              originalName: 'image-1.jpg',
              width: 1080,
              height: 1350,
              durationSeconds: null,
              sortOrder: 0,
            },
            {
              id: 'image-2',
              url: 'https://example.com/image-2.jpg',
              mediaKind: 'image',
              contentType: 'image/jpeg',
              originalName: 'image-2.jpg',
              width: 1080,
              height: 1350,
              durationSeconds: null,
              sortOrder: 1,
            },
          ],
        })]}
        selectedItemId="post-1"
        savedItemIds={new Set()}
        savingItemIds={new Set()}
        accessToken={null}
        hasMoreItems={false}
        isLoadingMoreItems={false}
        onLoadMoreItems={vi.fn()}
        onClose={vi.fn()}
        onSelectItemId={vi.fn()}
        onToggleSave={vi.fn()}
        onRemix={vi.fn()}
        buildDetailPath={(id) => `/showcase/${id}`}
      />
    );

    const reelActions = [
      screen.getByRole('button', { name: 'Save Campaign Frame' }),
      screen.getByRole('button', { name: 'Share' }),
      screen.getByRole('button', { name: 'Remix' }),
    ];

    for (const action of reelActions) {
      expect(action).toHaveClass('h-14', 'w-16', 'max-w-16', 'flex-none', 'lg:h-[70px]', 'lg:w-[70px]');
      expect(action).not.toHaveClass('flex-1');
    }

    const postNavigation = screen.getByRole('group', { name: 'Browse posts' });
    const previousPost = screen.getByRole('button', { name: 'Previous post' });
    const nextPost = screen.getByRole('button', { name: 'Next post' });

    expect(previousPost).toHaveClass('h-12', 'w-12', 'shrink-0');
    expect(nextPost).toHaveClass('h-12', 'w-12', 'shrink-0');
    expect(postNavigation.closest('aside')).not.toBeNull();
    expect(postNavigation).toContainElement(previousPost);
    expect(postNavigation).toContainElement(nextPost);
    expect(postNavigation).not.toContainElement(screen.getByRole('button', { name: 'Previous media' }));
    expect(postNavigation).not.toContainElement(screen.getByRole('button', { name: 'Next media' }));
  });

  it('requests another page when next is pressed at the last loaded reel item', async () => {
    const loadMoreItems = vi.fn(async () => undefined);

    render(
      <ShowcaseReelViewer
        isOpen
        items={[
          createShowcaseItem({ id: 'post-1', title: 'First Frame' }),
          createShowcaseItem({ id: 'post-2', title: 'Last Loaded Frame' }),
        ]}
        selectedItemId="post-2"
        savedItemIds={new Set()}
        savingItemIds={new Set()}
        accessToken={null}
        hasMoreItems
        isLoadingMoreItems={false}
        onLoadMoreItems={loadMoreItems}
        onClose={vi.fn()}
        onSelectItemId={vi.fn()}
        onToggleSave={vi.fn()}
        onRemix={vi.fn()}
        buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
      />
    );

    fireEvent.keyDown(window, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(loadMoreItems).toHaveBeenCalledTimes(1);
    });
  });

  it('records reel open, qualified impression, and dwell events with delivery context', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ success: true }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const rankedItem = createShowcaseItem({
      recommendation: {
        deliveryId: 'delivery-1',
        position: 4,
        reason: 'Inspired by your saves',
        algorithmVersion: 'feed-v1',
      },
    });

    try {
      const { unmount } = render(
        <ShowcaseReelViewer
          isOpen
          items={[rankedItem]}
          selectedItemId="post-1"
          savedItemIds={new Set()}
          savingItemIds={new Set()}
          accessToken="token-1"
          feedSessionId="session-1"
          hasMoreItems={false}
          isLoadingMoreItems={false}
          onLoadMoreItems={vi.fn()}
          onClose={vi.fn()}
          onSelectItemId={vi.fn()}
          onToggleSave={vi.fn()}
          onRemix={vi.fn()}
          buildDetailPath={(id) => `/showcase/${id}`}
        />
      );

      await act(async () => {
        vi.advanceTimersByTime(0);
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(1250);
        await Promise.resolve();
      });
      unmount();

      const eventBodies = fetchMock.mock.calls
        .filter(([input]) => String(input) === '/api/showcase/feed/events')
        .map(([, request]) => JSON.parse(String(request?.body)) as Record<string, unknown>);
      expect(eventBodies.map((body) => body.eventType)).toEqual(['open', 'impression', 'dwell']);
      expect(eventBodies).toEqual(expect.arrayContaining([
        expect.objectContaining({
          feedSessionId: 'session-1',
          deliveryId: 'delivery-1',
          position: 4,
          sourceSurface: 'showcase-reel',
        }),
        expect.objectContaining({
          eventType: 'dwell',
          durationMs: 1250,
        }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a quick skip instead of dwell when a reel closes before qualification', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ success: true }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const rankedItem = createShowcaseItem({
      recommendation: {
        deliveryId: 'delivery-1',
        position: 4,
        reason: 'Inspired by your saves',
        algorithmVersion: 'feed-v1',
      },
    });

    try {
      const { unmount } = render(
        <ShowcaseReelViewer
          isOpen
          items={[rankedItem]}
          selectedItemId="post-1"
          savedItemIds={new Set()}
          savingItemIds={new Set()}
          accessToken={null}
          feedSessionId="session-1"
          hasMoreItems={false}
          isLoadingMoreItems={false}
          onLoadMoreItems={vi.fn()}
          onClose={vi.fn()}
          onSelectItemId={vi.fn()}
          onToggleSave={vi.fn()}
          onRemix={vi.fn()}
          buildDetailPath={(id) => `/showcase/${id}`}
        />
      );

      await act(async () => {
        vi.advanceTimersByTime(0);
        await Promise.resolve();
        vi.advanceTimersByTime(400);
      });
      unmount();

      const eventBodies = fetchMock.mock.calls
        .filter(([input]) => String(input) === '/api/showcase/feed/events')
        .map(([, request]) => JSON.parse(String(request?.body)) as Record<string, unknown>);
      expect(eventBodies.map((body) => body.eventType)).toEqual(['open', 'quick_skip']);
      expect(eventBodies).toContainEqual(expect.objectContaining({
        eventType: 'quick_skip',
        durationMs: 400,
        sourceSurface: 'showcase-reel',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves horizontally through media without changing the selected post', () => {
    const selectItem = vi.fn();
    const changeMedia = vi.fn();

    render(
      <ShowcaseReelViewer
        isOpen
        items={[
          createShowcaseItem({
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
          }),
        ]}
        selectedItemId="post-1"
        savedItemIds={new Set()}
        savingItemIds={new Set()}
        accessToken={null}
        hasMoreItems={false}
        isLoadingMoreItems={false}
        onLoadMoreItems={vi.fn()}
        onClose={vi.fn()}
        onSelectItemId={selectItem}
        onMediaIndexChange={changeMedia}
        onToggleSave={vi.fn()}
        onRemix={vi.fn()}
        buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next media' }));

    expect(changeMedia).toHaveBeenCalledWith(1);
    expect(selectItem).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: 'Campaign Frame' })).toHaveAttribute('src', 'https://example.com/second.jpg');
  });

  it('syncs the visible slide when browser history changes the media index', async () => {
    const item = createShowcaseItem({
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
          url: 'https://example.com/history-slide.jpg',
          mediaKind: 'image',
          contentType: 'image/jpeg',
          originalName: 'history-slide.jpg',
          width: 1200,
          height: 800,
          durationSeconds: null,
          sortOrder: 1,
        },
      ],
    });
    const commonProps = {
      isOpen: true,
      items: [item],
      selectedItemId: 'post-1',
      savedItemIds: new Set<string>(),
      savingItemIds: new Set<string>(),
      accessToken: null,
      hasMoreItems: false,
      isLoadingMoreItems: false,
      onLoadMoreItems: vi.fn(),
      onClose: vi.fn(),
      onSelectItemId: vi.fn(),
      onToggleSave: vi.fn(),
      onRemix: vi.fn(),
      buildDetailPath: (id: string, section?: string) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`,
    };

    const { rerender } = render(
      <ShowcaseReelViewer
        {...commonProps}
        initialMediaIndex={0}
      />
    );
    expect(screen.getByRole('img', { name: 'Campaign Frame' })).toHaveAttribute('src', 'https://example.com/cover.jpg');

    rerender(
      <ShowcaseReelViewer
        {...commonProps}
        initialMediaIndex={1}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Campaign Frame' })).toHaveAttribute('src', 'https://example.com/history-slide.jpg');
    });
  });

  it('removes the reel loading overlay when video playback proves the media is ready', async () => {
    const { container } = renderVideoReel([createVideoMedia()]);

    expect(getMediaLoadingOverlay(container)).not.toBeNull();
    fireEvent.playing(container.querySelector('video')!);

    await waitFor(() => {
      expect(getMediaLoadingOverlay(container)).toBeNull();
    });
  });

  it('clears the blocking overlay on error and restores it while retrying the video', async () => {
    const { container } = renderVideoReel([createVideoMedia()]);
    const video = container.querySelector('video');

    expect(getMediaLoadingOverlay(container)).not.toBeNull();
    fireEvent.error(video!);

    await waitFor(() => {
      expect(getMediaLoadingOverlay(container)).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry video' }));

    await waitFor(() => {
      expect(getMediaLoadingOverlay(container)).not.toBeNull();
    });
    fireEvent.canPlay(container.querySelector('video')!);
    await waitFor(() => {
      expect(getMediaLoadingOverlay(container)).toBeNull();
    });
  });

  it('keeps reel loading state aligned with sorted media ids across slide changes', async () => {
    const { container } = renderVideoReel([
      createVideoMedia({
        id: 'video-2',
        url: 'https://example.com/second.mp4',
        sortOrder: 1,
      }),
      createVideoMedia({
        id: 'video-1',
        url: 'https://example.com/first.mp4',
        sortOrder: 0,
      }),
    ]);

    expect(container.querySelector('video')).toHaveAttribute('src', 'https://example.com/first.mp4');
    expect(getMediaLoadingOverlay(container)).not.toBeNull();
    fireEvent.loadedData(container.querySelector('video')!);
    await waitFor(() => {
      expect(getMediaLoadingOverlay(container)).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next media' }));
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://example.com/second.mp4');
    expect(getMediaLoadingOverlay(container)).not.toBeNull();
    fireEvent.playing(container.querySelector('video')!);

    await waitFor(() => {
      expect(getMediaLoadingOverlay(container)).toBeNull();
    });
  });

  it('restores reel loading when the same media id receives a refreshed source URL', async () => {
    const initialItem = createVideoMedia({ url: 'https://example.com/initial.mp4' });
    const refreshedItem = createVideoMedia({ url: 'https://example.com/refreshed.mp4' });
    const { container, rerender } = renderVideoReel([initialItem]);

    fireEvent.canPlay(container.querySelector('video')!);
    await waitFor(() => {
      expect(getMediaLoadingOverlay(container)).toBeNull();
    });

    rerender(createVideoReel([refreshedItem]));

    expect(container.querySelector('video')).toHaveAttribute('src', refreshedItem.url);
    expect(getMediaLoadingOverlay(container)).not.toBeNull();
    fireEvent.playing(container.querySelector('video')!);
    await waitFor(() => {
      expect(getMediaLoadingOverlay(container)).toBeNull();
    });
  });

  it('opens a compact cash or token choice inside the reel viewer', () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1200;

    renderPaidReel();

    const unlockButtons = screen.getAllByRole('button', { name: /unlock for \$9\.00/i });
    fireEvent.click(unlockButtons[0]);

    expect(screen.getByRole('button', { name: /pay with cash/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pay with tokens/i })).toBeInTheDocument();
    expect(screen.queryByText(/buyer trust/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/included after unlock/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/digital recipes are final sale/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /unlock for \$9\.00/i })).not.toBeInTheDocument();
  });

  it('gets a free recipe in one click without opening checkout', async () => {
    authState.session = { access_token: 'token-1' };
    let hasAddedRecipe = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/unlock-free')) {
        hasAddedRecipe = true;
        return new Response(JSON.stringify({ success: true }));
      }

      if (url.endsWith('/resource-bundle')) {
        return new Response(JSON.stringify({
          bundle: {
            viewerCanAccess: hasAddedRecipe,
            viewerIsOwner: false,
            resources: hasAddedRecipe ? {
              promptText: 'free revealed prompt',
              notesMarkdown: null,
              workflowShareUrl: null,
              attachments: [],
              allowRemix: false,
            } : null,
          },
        }));
      }

      return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderFreeReel();
    fireEvent.click(screen.getAllByRole('button', { name: /get free recipe/i })[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/unlock-free', expect.objectContaining({
        method: 'POST',
      }));
    });
    expect(screen.queryByRole('button', { name: /pay with cash/i })).not.toBeInTheDocument();
    expect(await screen.findByText(/added to your recipes/i)).toBeInTheDocument();
  });

  it('shows public generation recipes inline without purchase', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/resource-bundle')) {
        return new Response(JSON.stringify({
          bundle: {
            viewerCanAccess: true,
            viewerIsOwner: false,
            resources: {
              promptText: 'public recipe prompt',
              notesMarkdown: 'public recipe notes',
              workflowShareUrl: null,
              attachments: [],
              allowRemix: true,
              items: [
                {
                  type: 'prompt',
                  role: 'primary',
                  sectionId: null,
                  title: 'Prompt',
                  description: null,
                  textContent: 'public recipe prompt',
                  externalUrl: null,
                  storagePath: null,
                  contentType: null,
                  sizeBytes: null,
                  workflowSnapshot: null,
                  sortOrder: 0,
                  isPrimary: true,
                  remixUse: 'none',
                },
                {
                  type: 'reference_image',
                  role: 'style_reference',
                  sectionId: null,
                  title: '@alisa',
                  description: null,
                  textContent: null,
                  externalUrl: null,
                  storagePath: 'generated_images/user-1/reference.png',
                  contentType: 'image/png',
                  sizeBytes: null,
                  workflowSnapshot: null,
                  sortOrder: 1,
                  isPrimary: false,
                  remixUse: 'reference_only',
                },
                {
                  type: 'note',
                  role: 'other',
                  sectionId: null,
                  title: 'Notes',
                  description: null,
                  textContent: 'public recipe notes',
                  externalUrl: null,
                  storagePath: null,
                  contentType: null,
                  sizeBytes: null,
                  workflowSnapshot: null,
                  sortOrder: 2,
                  isPrimary: false,
                  remixUse: 'none',
                },
              ],
            },
          },
        }));
      }

      if (url.endsWith('/file-url')) {
        return new Response(JSON.stringify({
          success: true,
          signedUrl: 'https://signed.example.com/reference.png',
        }));
      }

      return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ShowcaseReelViewer
        isOpen
        items={[
          createShowcaseItem({
            id: 'post-1',
            title: 'Public Recipe Frame',
            prompt: 'public recipe prompt',
            asset: {
              ...paidAsset,
              id: 'generation-recipe:post-1',
              title: 'Creation recipe',
              accessMode: 'free',
              priceUsdCents: 0,
              priceQuote: {
                currency: 'USD',
                amountSubunits: 0,
                formatted: '$0.00',
                note: null,
              },
              resourceKinds: ['prompt', 'files', 'notes', 'remix'],
              itemCounts: {
                prompt: 1,
                reference_image: 1,
                note: 1,
                remix_access: 1,
              },
              lockedPreview: {
                resourceKinds: ['prompt', 'files', 'notes', 'remix'],
                attachmentPreviews: [],
                itemCounts: {
                  prompt: 1,
                  reference_image: 1,
                  note: 1,
                  remix_access: 1,
                },
                itemPreviews: [
                  {
                    type: 'prompt',
                    title: 'Prompt',
                    role: 'primary',
                    sectionId: null,
                    remixUse: 'none',
                  },
                  {
                    type: 'reference_image',
                    title: '@alisa',
                    role: 'style_reference',
                    sectionId: null,
                    contentType: 'image/png',
                    remixUse: 'reference_only',
                  },
                  {
                    type: 'note',
                    title: 'Notes',
                    role: 'other',
                    sectionId: null,
                    remixUse: 'none',
                  },
                  {
                    type: 'remix_access',
                    title: 'Remix access',
                    role: 'other',
                    sectionId: null,
                    remixUse: 'direct_remix',
                  },
                ],
                sectionCount: 0,
                sectionPreviews: [],
                hasPrompt: true,
                hasNotes: true,
                hasWorkflow: false,
                hasRemix: true,
                updatedAt: '2026-04-02T10:00:00.000Z',
              },
            },
            canRemix: true,
          }),
        ]}
        selectedItemId="post-1"
        savedItemIds={new Set()}
        savingItemIds={new Set()}
        accessToken={null}
        hasMoreItems={false}
        isLoadingMoreItems={false}
        onLoadMoreItems={vi.fn()}
        onClose={vi.fn()}
        onSelectItemId={vi.fn()}
        onToggleSave={vi.fn()}
        onRemix={vi.fn()}
        buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
      />
    );

    expect(screen.getAllByText(/creation recipe includes 1 prompt, 1 reference image, 1 note, 1 remix access/i).length).toBeGreaterThan(0);
    expect(await screen.findByText(/public recipe prompt/i)).toBeInTheDocument();
    expect(screen.getAllByText(/public recipe prompt/i)).toHaveLength(1);
    expect(screen.getByText(/public recipe notes/i)).toBeInTheDocument();
    expect(screen.getByText(/remix access is included/i)).toBeInTheDocument();
    expect(screen.getByText('@alisa')).toBeInTheDocument();

    const referencePreviewButton = await screen.findByRole('button', { name: /open preview for @alisa/i });
    expect(referencePreviewButton.className).toContain('w-[112px]');

    fireEvent.click(referencePreviewButton);

    expect(screen.getByRole('dialog', { name: /reference image preview/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close reference preview/i })).toBeInTheDocument();
  });

  it('starts the existing cash checkout from the compact reel choice', async () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1200;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/order')) {
        return new Response(JSON.stringify({ success: true, alreadyPurchased: true }));
      }

      if (url.endsWith('/resource-bundle')) {
        return new Response(JSON.stringify({
          bundle: {
            viewerCanAccess: true,
            viewerIsOwner: false,
            resources: {
              promptText: 'revealed prompt',
              notesMarkdown: null,
              workflowShareUrl: null,
              attachments: [],
              allowRemix: false,
            },
          },
        }));
      }

      return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPaidReel();
    fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: /pay with cash/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/order', expect.objectContaining({
        method: 'POST',
      }));
    });
  });

  it('unlocks with tokens and shows a compact success state', async () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1200;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/unlock-with-credits')) {
        return new Response(JSON.stringify({ success: true, credits: 300 }));
      }

      if (url.endsWith('/resource-bundle')) {
        return new Response(JSON.stringify({
          bundle: {
            viewerCanAccess: true,
            viewerIsOwner: false,
            resources: {
              promptText: 'revealed prompt',
              notesMarkdown: 'revealed notes',
              workflowShareUrl: null,
              attachments: [],
              allowRemix: false,
            },
          },
        }));
      }

      return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPaidReel();
    fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: /pay with tokens/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/unlock-with-credits', expect.objectContaining({
        method: 'POST',
      }));
    });
    expect(mockUpdateCredits).toHaveBeenCalledWith(300);
    expect(await screen.findByText('Unlocked')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /view recipe details/i }));
    expect(screen.getByText(/revealed prompt/i)).toBeInTheDocument();
    expect(screen.getByText(/revealed notes/i)).toBeInTheDocument();
  });
});
