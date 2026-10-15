import type { AnchorHTMLAttributes, ComponentProps, HTMLAttributes, ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseReelViewer from '@/app/showcase/ShowcaseReelViewer';
import {
  flushShowcaseFeedEvents,
  resetShowcaseFeedEventQueueForTests,
} from '@/app/showcase/ShowcaseFeedInteraction';
import FeedbackViewport from '@/components/FeedbackViewport';
import { requestConfirmation, resetFeedbackState } from '@/components/feedback-state';
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

const { mockPush, mockUpdateCredits, mockVerifyCheckout, mockGetSession, authState } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUpdateCredits: vi.fn(),
  mockVerifyCheckout: vi.fn(),
  mockGetSession: vi.fn(),
  authState: {
    session: null as { access_token: string } | null,
    credits: null as number | null,
    marketplaceSpendableCredits: null as number | null,
    user: null as { id: string } | null,
  },
}));

vi.mock('@/lib/razorpay-checkout-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/razorpay-checkout-client')>()),
  verifyRazorpayCheckoutUntilSettled: mockVerifyCheckout,
}));

// The browser session a checkout reads its bearer from after the sheet.
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: authState.session,
    credits: authState.credits,
    marketplaceSpendableCredits: authState.marketplaceSpendableCredits,
    user: authState.user,
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

vi.mock('@/components/PublicShareButton', () => ({
  default: ({ label, className }: { label?: string; className?: string }) => (
    <button type="button" className={className}>
      {label ?? 'Share'}
    </button>
  ),
}));

// Stands in for the thread: shows what the reel hands it, posts a comment the
// way the real one reports it (a new count), and has a field to type in.
vi.mock('@/components/PostComments', () => ({
  default: ({
    postId,
    commentCount,
    deliveryId,
    onCommentCountChange,
  }: {
    postId: string;
    commentCount: number;
    deliveryId?: string | null;
    onCommentCountChange?: (commentCount: number) => void;
  }) => (
    <div data-testid="post-comments" data-post-id={postId} data-delivery-id={deliveryId ?? ''}>
      <span>Thread of {commentCount}</span>
      <textarea aria-label="Write a comment" />
      <button type="button" onClick={() => onCommentCountChange?.(commentCount + 1)}>Post a comment</button>
    </div>
  ),
}));

type ReelProps = ComponentProps<typeof ShowcaseReelViewer>;

const ranked = (deliveryId: string, position = 0): ShowcaseFeedItem['recommendation'] => ({
  deliveryId,
  position,
  reason: 'Inspired by your saves',
  algorithmVersion: 'feed-v4',
});

/** The events the reel queued, as the server receives them. */
function sentFeedEvents(fetchMock: { mock: { calls: unknown[][] } }) {
  return fetchMock.mock.calls
    .filter(([input]) => String(input) === '/api/showcase/feed/events')
    .flatMap(([, request]) => {
      const body = JSON.parse(String((request as RequestInit | undefined)?.body)) as {
        events?: Array<Record<string, unknown>>;
      };
      return body.events ?? [];
    });
}

/** The funnel events the page sends (`trackProductEvent`), as a test can hear them. */
function listenForProductEvents() {
  const heard: Array<{ eventName: string; parameters: Record<string, unknown> }> = [];
  const listener = (event: Event) => heard.push((event as CustomEvent).detail);
  window.addEventListener('magicbooklet:product-event', listener);
  return { heard, stop: () => window.removeEventListener('magicbooklet:product-event', listener) };
}

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

function reelProps(overrides: Partial<ReelProps> = {}): ReelProps {
  return {
    isOpen: true,
    items: [createShowcaseItem()],
    selectedItemId: 'post-1',
    savedItemIds: new Set(),
    savingItemIds: new Set(),
    accessToken: null,
    hasMoreItems: false,
    isLoadingMoreItems: false,
    onLoadMoreItems: vi.fn(),
    onClose: vi.fn(),
    onSelectItemId: vi.fn(),
    onToggleSave: vi.fn(),
    onRemix: vi.fn(),
    buildDetailPath: (id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`,
    ...overrides,
  };
}

/** Answers the recipe's access check (no access unless given), and whatever else is listed. */
function stubRequests(answers: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const answer = answers[url];
    if (answer) return answer(init);
    if (url.endsWith('/resource-bundle')) {
      return new Response(JSON.stringify({ bundle: { viewerCanAccess: false, viewerIsOwner: false, resources: null } }));
    }
    return new Response(JSON.stringify({ success: true }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ShowcaseReelViewer pagination', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockUpdateCredits.mockClear();
    mockVerifyCheckout.mockReset();
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token-fresh' } } });
    authState.session = null;
    authState.credits = null;
    authState.marketplaceSpendableCredits = null;
    authState.user = null;
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
    resetShowcaseFeedEventQueueForTests();
    resetFeedbackState();
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
      screen.getByRole('button', { name: /show comments on campaign frame/i }),
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

  // "Report content?" is asked from the reel's own menu and drawn above the
  // reel. Its Escape answered "no" and went on to close the reel under it, and
  // the arrows changed the post the question was about. The dialog hears a key
  // first (it listens on the document, the reel on the window), so by the time
  // its Escape reaches the reel the question is already closed.
  it('leaves the keyboard to a confirmation that is open above it', async () => {
    const onClose = vi.fn();
    const onSelectItemId = vi.fn();
    render(
      <>
        <FeedbackViewport />
        <ShowcaseReelViewer
          isOpen
          items={[
            createShowcaseItem({ id: 'post-1', title: 'First Frame' }),
            createShowcaseItem({ id: 'post-2', title: 'Second Frame' }),
          ]}
          selectedItemId="post-1"
          savedItemIds={new Set()}
          savingItemIds={new Set()}
          accessToken={null}
          hasMoreItems={false}
          isLoadingMoreItems={false}
          onLoadMoreItems={vi.fn()}
          onClose={onClose}
          onSelectItemId={onSelectItemId}
          onToggleSave={vi.fn()}
          onRemix={vi.fn()}
          buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
        />
      </>
    );
    let answer: Promise<boolean> = Promise.resolve(true);
    act(() => {
      answer = requestConfirmation({ title: 'Report content?', message: 'A safety review.', confirmLabel: 'Report content' });
    });
    const question = await screen.findByRole('alertdialog');

    // Keys go to where the focus is, and from there up to the document and the window.
    fireEvent.keyDown(question, { key: 'ArrowDown' });
    expect(onSelectItemId).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    fireEvent.keyDown(question, { key: 'Escape' });
    await expect(answer).resolves.toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    // With the question answered the reel has its keys back.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(onSelectItemId).toHaveBeenCalledWith('post-2');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Up and Down step through the open menu's rows. They used to turn the reel
  // to another post as well, under the menu.
  it('does not change post while the arrows step through its open menu', () => {
    const onSelectItemId = vi.fn();
    render(
      <ShowcaseReelViewer
        isOpen
        items={[
          createShowcaseItem({ id: 'post-1', title: 'First Frame' }),
          createShowcaseItem({ id: 'post-2', title: 'Second Frame' }),
        ]}
        selectedItemId="post-1"
        savedItemIds={new Set()}
        savingItemIds={new Set()}
        accessToken={null}
        hasMoreItems={false}
        isLoadingMoreItems={false}
        onLoadMoreItems={vi.fn()}
        onClose={vi.fn()}
        onSelectItemId={onSelectItemId}
        onToggleSave={vi.fn()}
        onRemix={vi.fn()}
        onFeedback={vi.fn()}
        onReportContent={vi.fn()}
        buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for first frame/i }));
    const rows = screen.getAllByRole('menuitem');
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });

    expect(document.activeElement).toBe(rows[1]);
    expect(onSelectItemId).not.toHaveBeenCalled();
  });

  // A creator's page and the viewer's saved posts are not feeds. Their reel is
  // given the safety rows alone, and had no ⋯ at all: the menu was drawn only
  // for a reel that was also given the feed rows.
  describe('away from a feed', () => {
    const renderReelWithoutFeedRows = (handlers: {
      onReportContent?: (item: ShowcaseFeedItem) => void;
      onReportUser?: (item: ShowcaseFeedItem) => void;
      onBlockUser?: (item: ShowcaseFeedItem) => void;
      originLabel?: string;
    }) => render(
      <ShowcaseReelViewer
        isOpen
        items={[createShowcaseItem()]}
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
        {...handlers}
        buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
      />
    );

    it('offers the safety rows alone, each about the post that is open', () => {
      const onReportContent = vi.fn();
      const onReportUser = vi.fn();
      const onBlockUser = vi.fn();
      renderReelWithoutFeedRows({ onReportContent, onReportUser, onBlockUser });

      const trigger = screen.getByRole('button', { name: /more actions for campaign frame/i });
      fireEvent.click(trigger);
      const rows = screen.getAllByRole('menuitem').map((row) => row.querySelector('.font-semibold')?.textContent);
      expect(rows).toEqual(['Report content', 'Report user', 'Block user']);
      expect(screen.queryByRole('separator')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('menuitem', { name: /report content/i }));
      expect(onReportContent).toHaveBeenCalledWith(expect.objectContaining({ id: 'post-1' }));
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('menuitem', { name: /report user/i }));
      expect(onReportUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'post-1' }));
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('menuitem', { name: /block user/i }));
      expect(onBlockUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'post-1' }));
    });

    it("has no ⋯ on the viewer's own post: no row applies to it", () => {
      authState.user = { id: 'creator-1' };
      renderReelWithoutFeedRows({ onReportContent: vi.fn(), onReportUser: vi.fn(), onBlockUser: vi.fn() });

      expect(screen.queryByRole('button', { name: /more actions for/i })).not.toBeInTheDocument();
    });

    it('has no ⋯ when it is given nothing to offer', () => {
      renderReelWithoutFeedRows({});

      expect(screen.queryByRole('button', { name: /more actions for/i })).not.toBeInTheDocument();
    });

    // The button that closes the reel says where it goes back to. It said
    // "Explore" on a creator's page and on the profile, which it does not go to.
    it('names the page it was opened from on the button that closes it', () => {
      const { unmount } = renderReelWithoutFeedRows({ originLabel: 'Creator' });

      expect(screen.getByRole('dialog', { name: 'Creator reel viewer' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Creator' })).toBeInTheDocument();
      expect(screen.getByText('Creator reel')).toBeInTheDocument();
      expect(screen.queryByText(/explore/i)).not.toBeInTheDocument();
      unmount();

      // Explore's own reel is unchanged.
      renderReelWithoutFeedRows({});
      expect(screen.getByRole('dialog', { name: 'Explore reel viewer' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Explore' })).toBeInTheDocument();
      expect(screen.getByText('Explore reel')).toBeInTheDocument();
    });
  });

  // jsdom has no layers, so this reads the two class lists. The ⋯ menu hangs
  // from the reel's bar over the body below it. With both at one level the
  // body, which comes later in the page, was drawn over the menu: measured in
  // a browser on 2026-10-10, no row of it could be seen or pressed.
  it('keeps its bar a level above its body, so the menu that hangs from the bar is not drawn under the details', () => {
    const { container } = render(
      <ShowcaseReelViewer
        isOpen
        items={[createShowcaseItem()]}
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
        onFeedback={vi.fn()}
        buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
      />
    );
    const level = (element: Element | null | undefined) => Number(element?.className.match(/(?:^|\s)z-(\d+)(?:\s|$)/)?.[1]);
    const bar = container.querySelector('header');
    const body = bar?.nextElementSibling;

    expect(bar?.querySelector('[aria-haspopup="menu"]')).not.toBeNull();
    expect(level(body)).toBeGreaterThan(0);
    expect(level(bar)).toBeGreaterThan(level(body));
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

      // Drain the event queue. dwell and quick_skip are emitted as the reel
      // closes, so this has to come after unmount or they are never queued.
      await act(async () => {
        vi.advanceTimersByTime(2_000);
        await Promise.resolve();
      });

      // Feed events are queued and flushed together, so one request carries
      // several events rather than one request carrying one.
      const eventBodies = fetchMock.mock.calls
        .filter(([input]) => String(input) === '/api/showcase/feed/events')
        .flatMap(([, request]) => {
          const body = JSON.parse(String(request?.body)) as { events?: Array<Record<string, unknown>> };
          return body.events ?? [];
        });
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

      // Drain the event queue. dwell and quick_skip are emitted as the reel
      // closes, so this has to come after unmount or they are never queued.
      await act(async () => {
        vi.advanceTimersByTime(2_000);
        await Promise.resolve();
      });

      // Feed events are queued and flushed together, so one request carries
      // several events rather than one request carrying one.
      const eventBodies = fetchMock.mock.calls
        .filter(([input]) => String(input) === '/api/showcase/feed/events')
        .flatMap(([, request]) => {
          const body = JSON.parse(String(request?.body)) as { events?: Array<Record<string, unknown>> };
          return body.events ?? [];
        });
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
    expect(screen.getByRole('button', { name: /use [\d,]+ credits/i })).toBeInTheDocument();
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

  // A recipe the reader has unlocked opens in the reel: its prompt (once), its
  // notes, its references, and a reference image larger on a tap.
  it("shows an unlocked recipe's prompt, notes and references, and opens a reference image larger", async () => {
    authState.session = { access_token: 'token-1' };
    stubRequests({
      '/api/posts/post-1/resource-bundle': () => new Response(JSON.stringify({
        bundle: {
          viewerCanAccess: true,
          viewerIsOwner: false,
          resources: {
            promptText: 'unlocked recipe prompt',
            notesMarkdown: 'unlocked recipe notes',
            workflowShareUrl: null,
            attachments: [],
            allowRemix: true,
            items: [
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
            ],
          },
        },
      })),
      '/api/posts/post-1/resource-bundle/file-url': () => new Response(JSON.stringify({
        files: [{
          storagePath: 'generated_images/user-1/reference.png',
          url: 'https://signed.example.com/reference.png',
        }],
      })),
    });

    renderPaidReel();

    expect(await screen.findByText('unlocked recipe prompt')).toBeInTheDocument();
    expect(screen.getAllByText('unlocked recipe prompt')).toHaveLength(1);
    expect(screen.getByText('unlocked recipe notes')).toBeInTheDocument();
    expect(screen.getByText(/remix access is included/i)).toBeInTheDocument();
    expect(screen.getByText('@alisa')).toBeInTheDocument();

    const referencePreviewButton = await screen.findByRole('button', { name: /open preview for @alisa/i });
    expect(referencePreviewButton.closest('div.w-\\[112px\\]')).not.toBeNull();

    fireEvent.click(referencePreviewButton);

    expect(screen.getByRole('dialog', { name: /reference image preview/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close reference preview/i })).toBeInTheDocument();
  });

  // As the post page's panel does: the previews one render draws leave as one
  // request, and Open shows the file instead of saving it.
  it("signs the unlocked recipe's previews in one request and opens a file inline", async () => {
    authState.session = { access_token: 'token-1' };
    const reference = (storagePath: string, contentType: string) => ({
      type: 'source_file',
      role: 'style_reference',
      sectionId: null,
      title: storagePath.split('/').pop(),
      description: null,
      textContent: null,
      externalUrl: null,
      storagePath,
      contentType,
      sizeBytes: null,
      workflowSnapshot: null,
      sortOrder: 1,
      isPrimary: false,
      remixUse: 'reference_only',
    });
    const fetchMock = stubRequests({
      '/api/posts/post-1/resource-bundle': () => new Response(JSON.stringify({
        bundle: {
          viewerCanAccess: true,
          viewerIsOwner: false,
          resources: {
            promptText: 'unlocked recipe prompt',
            notesMarkdown: null,
            workflowShareUrl: null,
            attachments: [{ kind: 'file', label: 'Guide', storagePath: 'user-1/resources/guide.pdf', contentType: 'application/pdf' }],
            allowRemix: false,
            items: [
              reference('generated_images/user-1/frame.png', 'image/png'),
              reference('generated_videos/user-1/motion.mp4', 'video/mp4'),
            ],
          },
        },
      })),
      '/api/posts/post-1/resource-bundle/file-url': (init) => {
        const { storagePaths } = JSON.parse(String(init?.body)) as { storagePaths: string[] };
        return new Response(JSON.stringify({
          files: storagePaths.map((storagePath) => ({ storagePath, url: `https://signed.example.com/${storagePath}` })),
        }));
      },
    });
    const fileUrlBodies = () => fetchMock.mock.calls
      .filter(([input]) => String(input) === '/api/posts/post-1/resource-bundle/file-url')
      .map(([, init]) => JSON.parse(String(init?.body)));
    const tab = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
    const open = vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);

    try {
      renderPaidReel();

      expect(await screen.findByText('unlocked recipe prompt')).toBeInTheDocument();
      await waitFor(() => {
        expect(document.querySelector('img[src="https://signed.example.com/generated_images/user-1/frame.png"]')).not.toBeNull();
      });
      expect(document.querySelector('video')).toHaveAttribute('src', 'https://signed.example.com/generated_videos/user-1/motion.mp4');
      expect(fileUrlBodies()).toEqual([{
        storagePaths: ['generated_images/user-1/frame.png', 'generated_videos/user-1/motion.mp4'],
        disposition: 'inline',
      }]);

      fireEvent.click(screen.getByRole('button', { name: 'Open Guide' }));
      await waitFor(() => {
        expect(tab.location.replace).toHaveBeenCalledWith('https://signed.example.com/user-1/resources/guide.pdf');
      });
      expect(fileUrlBodies()[1]).toEqual({ storagePaths: ['user-1/resources/guide.pdf'], disposition: 'inline' });
    } finally {
      open.mockRestore();
    }
  });

  it('restores a paid purchase on entry without starting another checkout', async () => {
    authState.session = { access_token: 'token-1' };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      bundle: { viewerCanAccess: true, resources: {
        promptText: 'Previously purchased prompt', notesMarkdown: null,
        workflowShareUrl: null, attachments: [], allowRemix: false,
      } },
    })));
    vi.stubGlobal('fetch', fetchMock);
    renderPaidReel();
    expect(await screen.findByText('Previously purchased prompt')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay with/i })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle', expect.objectContaining({
      headers: { Authorization: 'Bearer token-1' },
    }));
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

  it('unlocks with credits once the reader says yes, and shows a compact success state', async () => {
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

    render(<FeedbackViewport />);
    renderPaidReel();
    fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: /use [\d,]+ credits/i }));

    // The spend cannot be undone, so it is asked first, as the post page asks.
    const question = await screen.findByRole('alertdialog', { name: 'Unlock this recipe?' });
    expect(question).toHaveTextContent('900 credits will come off your balance right away.');
    expect(fetchMock).not.toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/unlock-with-credits', expect.anything());
    fireEvent.click(within(question).getByRole('button', { name: 'Use 900 credits' }));

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

  describe('comments in the reel', () => {
    it('opens the thread from a count on the rail, credited to the delivery that showed the post', () => {
      const onCommentCountChange = vi.fn();
      render(<ShowcaseReelViewer {...reelProps({
        items: [createShowcaseItem({ commentCount: 2, recommendation: ranked('delivery-7') })],
        onCommentCountChange,
      })} />);

      expect(screen.queryByTestId('post-comments')).not.toBeInTheDocument();
      const toggle = screen.getByRole('button', { name: 'Show comments on Campaign Frame (2)' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveTextContent('2');

      fireEvent.click(toggle);

      const thread = screen.getByTestId('post-comments');
      expect(thread).toHaveAttribute('data-post-id', 'post-1');
      expect(thread).toHaveAttribute('data-delivery-id', 'delivery-7');
      expect(screen.getByRole('button', { name: 'Hide comments on Campaign Frame (2)' }))
        .toHaveAttribute('aria-expanded', 'true');

      // A comment posted in the thread moves the count on the rail, and the host hears it.
      fireEvent.click(within(thread).getByRole('button', { name: 'Post a comment' }));
      expect(screen.getByRole('button', { name: 'Hide comments on Campaign Frame (3)' })).toHaveTextContent('3');
      expect(onCommentCountChange).toHaveBeenCalledWith('post-1', 3);

      fireEvent.click(screen.getByRole('button', { name: /hide comments on campaign frame/i }));
      expect(screen.queryByTestId('post-comments')).not.toBeInTheDocument();
    });

    it('shortens a large count as the feed card does', () => {
      render(<ShowcaseReelViewer {...reelProps({ items: [createShowcaseItem({ commentCount: 1234 })] })} />);

      expect(screen.getByRole('button', { name: /show comments on campaign frame/i })).toHaveTextContent('1.2K');
    });

    it('takes no comments on an unlisted post, as the server takes none', () => {
      render(<ShowcaseReelViewer {...reelProps({ items: [createShowcaseItem({ visibility: 'unlisted' })] })} />);

      expect(screen.queryByRole('button', { name: /comments on campaign frame/i })).not.toBeInTheDocument();
    });

    it('closes the thread when the reel moves on', () => {
      const props = reelProps({
        items: [
          createShowcaseItem({ id: 'post-1', title: 'First Frame' }),
          createShowcaseItem({ id: 'post-2', title: 'Second Frame' }),
        ],
      });
      const { rerender } = render(<ShowcaseReelViewer {...props} />);
      fireEvent.click(screen.getByRole('button', { name: /show comments on first frame/i }));
      expect(screen.getByTestId('post-comments')).toBeInTheDocument();

      fireEvent.keyDown(document.body, { key: 'ArrowDown' });
      expect(props.onSelectItemId).toHaveBeenCalledWith('post-2');
      rerender(<ShowcaseReelViewer {...props} selectedItemId="post-2" />);
      expect(screen.queryByTestId('post-comments')).not.toBeInTheDocument();

      rerender(<ShowcaseReelViewer {...props} selectedItemId="post-1" />);
      expect(screen.queryByTestId('post-comments')).not.toBeInTheDocument();
    });

    // The arrows move the caret and Escape keeps the draft. Both reached the
    // reel, which would turn to another post or close under the writer.
    it('leaves the keys typed in the comment box to the box', () => {
      const props = reelProps({
        items: [
          createShowcaseItem({ id: 'post-1', title: 'First Frame' }),
          createShowcaseItem({ id: 'post-2', title: 'Second Frame' }),
        ],
      });
      render(<ShowcaseReelViewer {...props} />);
      fireEvent.click(screen.getByRole('button', { name: /show comments on first frame/i }));
      const field = screen.getByRole('textbox', { name: 'Write a comment' });

      fireEvent.keyDown(field, { key: 'ArrowDown' });
      fireEvent.keyDown(field, { key: 'ArrowLeft' });
      fireEvent.keyDown(field, { key: 'Escape' });

      expect(props.onSelectItemId).not.toHaveBeenCalled();
      expect(props.onClose).not.toHaveBeenCalled();
    });

    it('scrolls the details under a finger instead of turning the post', () => {
      const props = reelProps({
        items: [
          createShowcaseItem({ id: 'post-1', title: 'First Frame' }),
          createShowcaseItem({ id: 'post-2', title: 'Second Frame' }),
        ],
      });
      const { container } = render(<ShowcaseReelViewer {...props} />);
      const details = container.querySelector('[data-reel-scroll-region="details"]') as HTMLElement;
      const media = container.querySelector('section') as HTMLElement;

      fireEvent.touchStart(details, { touches: [{ clientX: 100, clientY: 400 }] });
      fireEvent.touchEnd(details, { changedTouches: [{ clientX: 100, clientY: 200 }] });
      expect(props.onSelectItemId).not.toHaveBeenCalled();

      // The same swipe over the media turns the post.
      fireEvent.touchStart(media, { touches: [{ clientX: 100, clientY: 400 }] });
      fireEvent.touchEnd(media, { changedTouches: [{ clientX: 100, clientY: 200 }] });
      expect(props.onSelectItemId).toHaveBeenCalledWith('post-2');
    });
  });

  describe('Follow in the reel', () => {
    const followAnswers = (
      following: boolean,
      answerFollow: () => Response = () => new Response(JSON.stringify({ following: !following })),
    ) => ({
      '/api/profile/follow?followingId=creator-1': () => new Response(JSON.stringify({ following })),
      '/api/profile/follow': answerFollow,
    });

    it('asks whom the viewer follows, then follows the creator for the post and the delivery that showed it', async () => {
      authState.session = { access_token: 'token-1' };
      authState.user = { id: 'viewer-1' };
      const fetchMock = stubRequests(followAnswers(false));
      render(<ShowcaseReelViewer {...reelProps({
        items: [createShowcaseItem({ recommendation: ranked('delivery-9') })],
      })} />);

      const follow = await screen.findByRole('button', { name: 'Follow Creator Name' });
      expect(follow).toHaveAttribute('aria-pressed', 'false');
      expect(fetchMock).toHaveBeenCalledWith('/api/profile/follow?followingId=creator-1', {
        headers: { Authorization: 'Bearer token-1' },
      });

      fireEvent.click(follow);

      expect(await screen.findByRole('button', { name: 'Following Creator Name' })).toHaveAttribute('aria-pressed', 'true');
      const sent = fetchMock.mock.calls.find(([input, init]) => (
        String(input) === '/api/profile/follow' && init?.method === 'POST'
      ));
      expect(sent?.[1]?.headers).toEqual({ Authorization: 'Bearer token-1', 'Content-Type': 'application/json' });
      expect(JSON.parse(String(sent?.[1]?.body))).toEqual({
        followingId: 'creator-1',
        following: true,
        postId: 'post-1',
        deliveryId: 'delivery-9',
      });
    });

    it('unfollows a creator the viewer follows', async () => {
      authState.session = { access_token: 'token-1' };
      authState.user = { id: 'viewer-1' };
      const fetchMock = stubRequests(followAnswers(true));
      render(<ShowcaseReelViewer {...reelProps()} />);

      fireEvent.click(await screen.findByRole('button', { name: 'Following Creator Name' }));

      expect(await screen.findByRole('button', { name: 'Follow Creator Name' })).toHaveAttribute('aria-pressed', 'false');
      const sent = fetchMock.mock.calls.find(([input, init]) => (
        String(input) === '/api/profile/follow' && init?.method === 'POST'
      ));
      expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({ followingId: 'creator-1', following: false, postId: 'post-1' });
    });

    it('puts the button back and says so when the follow fails', async () => {
      authState.session = { access_token: 'token-1' };
      authState.user = { id: 'viewer-1' };
      stubRequests(followAnswers(false, () => new Response(JSON.stringify({ error: 'Failed' }), { status: 500 })));
      render(<ShowcaseReelViewer {...reelProps()} />);

      fireEvent.click(await screen.findByRole('button', { name: 'Follow Creator Name' }));

      expect(await screen.findByText('Could not update follow. Please try again.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Follow Creator Name' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('sends a signed-out viewer to sign in and back to the post', () => {
      window.history.replaceState(null, '', '/showcase?post=post-1');
      try {
        const fetchMock = stubRequests();
        render(<ShowcaseReelViewer {...reelProps()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Follow Creator Name' }));

        expect(mockPush).toHaveBeenCalledWith(`/login?returnUrl=${encodeURIComponent('/showcase?post=post-1')}`);
        expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/profile/follow'))).toBe(false);
      } finally {
        window.history.replaceState(null, '', '/');
      }
    });

    it("has no Follow on the viewer's own post, and asks nothing", () => {
      authState.session = { access_token: 'token-1' };
      authState.user = { id: 'creator-1' };
      const fetchMock = stubRequests();
      render(<ShowcaseReelViewer {...reelProps()} />);

      expect(screen.queryByRole('button', { name: /^follow/i })).not.toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/profile/follow'))).toBe(false);
    });
  });

  describe('Remix behind a recipe unlock', () => {
    const lockedRemix = (
      asset: NonNullable<ShowcaseFeedItem['asset']>,
      overrides: Partial<ShowcaseFeedItem> = {},
    ) => createShowcaseItem({
      canRemix: false,
      remixCapability: 'unlock_required',
      remixTarget: 'image',
      asset: { ...asset, allowRemix: true },
      ...overrides,
    });
    const accessAnswer = () => new Response(JSON.stringify({
      bundle: {
        viewerCanAccess: true,
        viewerIsOwner: false,
        resources: { promptText: 'recipe prompt', notesMarkdown: null, workflowShareUrl: null, attachments: [], allowRemix: true },
      },
    }));

    it('offers Remix on a paid recipe that includes it, and opens the checkout first', () => {
      authState.session = { access_token: 'token-1' };
      authState.credits = 1200;
      stubRequests();
      const onRemix = vi.fn();
      render(<ShowcaseReelViewer {...reelProps({ items: [lockedRemix(paidAsset)], onRemix })} />);

      fireEvent.click(screen.getByRole('button', { name: 'Remix: unlock the recipe for Campaign Frame first' }));

      expect(onRemix).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /pay with cash/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Use 900 credits' })).toBeInTheDocument();
    });

    it('gets a free recipe that includes remix on the first tap, and remixes on the next', async () => {
      authState.session = { access_token: 'token-1' };
      let unlocked = false;
      const fetchMock = stubRequests({
        '/api/posts/post-1/resource-bundle/unlock-free': () => {
          unlocked = true;
          return new Response(JSON.stringify({ success: true }));
        },
        '/api/posts/post-1/resource-bundle': () => unlocked
          ? accessAnswer()
          : new Response(JSON.stringify({ bundle: { viewerCanAccess: false, viewerIsOwner: false, resources: null } })),
      });
      const onRemix = vi.fn();
      render(<ShowcaseReelViewer {...reelProps({ items: [lockedRemix(freeAsset)], onRemix })} />);

      fireEvent.click(screen.getByRole('button', { name: /remix: unlock the recipe/i }));

      expect(await screen.findByText(/added to your recipes/i)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/unlock-free', expect.objectContaining({
        method: 'POST',
      }));
      expect(onRemix).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Remix' }));
      expect(onRemix).toHaveBeenCalledWith('post-1');
    });

    it('remixes at once for a reader who already has the recipe', async () => {
      authState.session = { access_token: 'token-1' };
      stubRequests({ '/api/posts/post-1/resource-bundle': accessAnswer });
      const onRemix = vi.fn();
      render(<ShowcaseReelViewer {...reelProps({ items: [lockedRemix(paidAsset)], onRemix })} />);

      fireEvent.click(await screen.findByRole('button', { name: 'Remix' }));

      expect(onRemix).toHaveBeenCalledWith('post-1');
    });

    it('offers no Remix when the recipe leaves it out, or when the remix opens elsewhere', () => {
      stubRequests();
      const { unmount } = render(<ShowcaseReelViewer {...reelProps({
        items: [createShowcaseItem({ canRemix: false, remixCapability: 'unlock_required', asset: paidAsset })],
      })} />);
      expect(screen.queryByRole('button', { name: /remix/i })).not.toBeInTheDocument();
      unmount();

      render(<ShowcaseReelViewer {...reelProps({ items: [lockedRemix(paidAsset, { remixTarget: 'workflow' })] })} />);
      expect(screen.queryByRole('button', { name: /remix/i })).not.toBeInTheDocument();
    });
  });

  describe("the reel's own unlock", () => {
    it('names both ways to pay for a recipe that can be bought with cash', () => {
      stubRequests();
      renderPaidReel();

      expect(screen.getAllByRole('button', { name: 'Unlock for $9.00 · 900 credits' }).length).toBeGreaterThan(0);
    });

    it('offers credits alone below the cash minimum, where the server refuses cash', () => {
      authState.session = { access_token: 'token-1' };
      authState.credits = 1200;
      stubRequests();
      render(<ShowcaseReelViewer {...reelProps({
        items: [createShowcaseItem({
          asset: {
            ...paidAsset,
            priceUsdCents: 90,
            priceQuote: { currency: 'USD', amountSubunits: 90, formatted: '$0.90', note: null },
          },
        })],
      })} />);

      // Priced in credits alone: no cash figure the checkout would refuse.
      expect(screen.queryByRole('button', { name: /\$0\.90/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: /unlock for 90 credits/i })[0]);

      expect(screen.queryByRole('button', { name: /pay with cash/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Use 90 credits' })).toBeInTheDocument();
      expect(screen.queryByTestId('showcase-reel-razorpay-checkout')).not.toBeInTheDocument();
    });

    it('spends nothing when the reader says no', async () => {
      authState.session = { access_token: 'token-1' };
      authState.credits = 1200;
      const fetchMock = stubRequests();
      render(<FeedbackViewport />);
      renderPaidReel();

      fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
      fireEvent.click(screen.getByRole('button', { name: 'Use 900 credits' }));
      const question = await screen.findByRole('alertdialog', { name: 'Unlock this recipe?' });
      fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(fetchMock).not.toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/unlock-with-credits', expect.anything());
    });

    // The post page's panel reports these; a recipe bought in the reel never
    // reached the funnel.
    it('reports a credit unlock to the funnel as the post page does', async () => {
      authState.session = { access_token: 'token-1' };
      authState.credits = 1200;
      stubRequests({
        '/api/posts/post-1/resource-bundle/unlock-with-credits': () => new Response(JSON.stringify({ success: true, credits: 300 })),
      });
      // No viewport is mounted, so the question falls back to the browser's own.
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const funnel = listenForProductEvents();
      try {
        renderPaidReel();
        fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
        fireEvent.click(screen.getByRole('button', { name: 'Use 900 credits' }));

        await waitFor(() => {
          expect(funnel.heard.map(({ eventName }) => eventName)).toEqual(['recipe_unlock_started', 'recipe_unlock_succeeded']);
        });
        expect(funnel.heard[1].parameters).toEqual({ method: 'credits', post_id: 'post-1' });
        expect(confirm).toHaveBeenCalledWith(expect.stringContaining('900 credits will come off your balance right away.'));
      } finally {
        funnel.stop();
        confirm.mockRestore();
      }
    });

    it('reports a free unlock that failed to the funnel', async () => {
      authState.session = { access_token: 'token-1' };
      stubRequests({
        '/api/posts/post-1/resource-bundle/unlock-free': () => new Response(JSON.stringify({ error: 'Unavailable' }), { status: 500 }),
      });
      const funnel = listenForProductEvents();
      try {
        renderFreeReel();
        fireEvent.click(screen.getAllByRole('button', { name: /get free recipe/i })[0]);

        await waitFor(() => {
          expect(funnel.heard.map(({ eventName }) => eventName)).toEqual(['recipe_unlock_started', 'recipe_unlock_failed']);
        });
        expect(funnel.heard[0].parameters).toEqual({ method: 'free', post_id: 'post-1' });
      } finally {
        funnel.stop();
      }
    });

    // A new account holds only welcome credits: the total covers the price, the
    // unlock would refuse it, and the reel used to offer the spend anyway.
    it('judges the shortfall on the spendable credits alone, says why, and offers Buy credits', () => {
      authState.session = { access_token: 'token-1' };
      authState.credits = 1200;
      authState.marketplaceSpendableCredits = 0;
      stubRequests();
      renderPaidReel();

      fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);

      expect(screen.getByText('0 credits available')).toBeInTheDocument();
      expect(screen.getByText("Welcome and referral credits can't be spent on recipes.")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Use 900 credits' })).toBeDisabled();
      expect(screen.getByRole('link', { name: 'Buy credits' })).toHaveAttribute('href', '/pricing');
    });

    it('prints the spendable balance alone when all of it can buy recipes', () => {
      authState.session = { access_token: 'token-1' };
      authState.credits = 1200;
      authState.marketplaceSpendableCredits = 1200;
      stubRequests();
      renderPaidReel();

      fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);

      expect(screen.getByText('1,200 credits available')).toBeInTheDocument();
      expect(screen.queryByText("Welcome and referral credits can't be spent on recipes.")).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Use 900 credits' })).toBeEnabled();
      expect(screen.queryByRole('link', { name: 'Buy credits' })).not.toBeInTheDocument();
    });

    it('claims no shortfall while the spendable figure is unknown', () => {
      authState.session = { access_token: 'token-1' };
      authState.credits = 120;
      stubRequests();
      renderPaidReel();

      fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);

      expect(screen.getByRole('button', { name: 'Use 900 credits' })).toBeEnabled();
      expect(screen.queryByRole('link', { name: 'Buy credits' })).not.toBeInTheDocument();
      expect(screen.queryByText(/credits available/)).not.toBeInTheDocument();
    });

    it("offers Buy credits once the unlock refuses for credits, and takes the server's balance", async () => {
      authState.session = { access_token: 'token-1' };
      authState.credits = 1200;
      stubRequests({
        '/api/posts/post-1/resource-bundle/unlock-with-credits': () => new Response(JSON.stringify({
          error: 'Insufficient credits. This unlock costs 900 credits.',
          code: 'INSUFFICIENT_CREDITS',
          creditCost: 900,
          remainingCredits: 1200,
          marketplaceSpendableCredits: 0,
        }), { status: 402 }),
      });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      try {
        renderPaidReel();
        fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
        expect(screen.queryByRole('link', { name: 'Buy credits' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Use 900 credits' }));

        expect(await screen.findByText('Insufficient credits. This unlock costs 900 credits.')).toBeInTheDocument();
        expect(mockUpdateCredits).toHaveBeenCalledWith(1200, { marketplaceSpendableCredits: 0 });
        expect(screen.getByRole('link', { name: 'Buy credits' })).toHaveAttribute('href', '/pricing');
      } finally {
        confirm.mockRestore();
      }
    });

    it('hands the spendable figure the unlock answered to the balance with the new total', async () => {
      authState.session = { access_token: 'token-1' };
      authState.credits = 1500;
      authState.marketplaceSpendableCredits = 1200;
      stubRequests({
        '/api/posts/post-1/resource-bundle/unlock-with-credits': () => new Response(JSON.stringify({
          success: true,
          credits: 600,
          marketplaceSpendableCredits: 300,
        })),
      });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      try {
        renderPaidReel();
        fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
        fireEvent.click(screen.getByRole('button', { name: 'Use 900 credits' }));

        await waitFor(() => {
          expect(mockUpdateCredits).toHaveBeenCalledWith(600, { marketplaceSpendableCredits: 300 });
        });
      } finally {
        confirm.mockRestore();
      }
    });

    describe('after the sheet takes a cash payment', () => {
      const payment = {
        razorpay_payment_id: 'pay-1',
        razorpay_order_id: 'order-1',
        razorpay_signature: 'signature-1',
      };
      const PAYMENT_RECEIVED = "Payment received. Your recipe opens here once it's confirmed.";
      const INTENT_KEY = 'magicbooklet:razorpay-checkout:post-resource:post-1';
      const lockedRecipe = () => new Response(JSON.stringify({
        bundle: { viewerCanAccess: false, viewerIsOwner: false, resources: null },
      }));
      const openRecipe = () => new Response(JSON.stringify({
        bundle: {
          viewerCanAccess: true,
          viewerIsOwner: false,
          resources: {
            promptText: 'paid prompt',
            notesMarkdown: null,
            workflowShareUrl: null,
            attachments: [],
            allowRemix: false,
          },
        },
      }));

      /** The sheet takes the payment as soon as it opens. */
      function stubSheetThatPays() {
        vi.stubGlobal('Razorpay', class {
          constructor(private readonly options: { handler: (response: typeof payment) => Promise<void> }) {}
          open() { void this.options.handler(payment); }
          on() {}
        });
      }

      /** The reel's own access check on entry reads locked; later reads wait for `recipeOpens`. */
      function stubCashCheckout(
        recipeOpens: Promise<void> | null,
        otherAnswers: Record<string, () => Response> = {},
      ) {
        let recipeReads = 0;
        return stubRequests({
          ...otherAnswers,
          '/api/posts/post-1/resource-bundle/order': () => new Response(JSON.stringify({
            orderId: 'order-1',
            amount: 90000,
            currency: 'USD',
          })),
          '/api/posts/post-1/resource-bundle': async () => {
            recipeReads += 1;
            if (recipeReads === 1 || !recipeOpens) return lockedRecipe();
            await recipeOpens;
            return openRecipe();
          },
        });
      }

      function payWithCash() {
        renderPaidReel();
        fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
        fireEvent.click(screen.getByRole('button', { name: /pay with cash/i }));
      }

      it('verifies with the session as it is after the sheet, and reads the settled recipe with it too', async () => {
        authState.session = { access_token: 'token-at-click' };
        authState.credits = 1200;
        const fetchMock = stubCashCheckout(Promise.resolve());
        mockVerifyCheckout.mockResolvedValueOnce({ state: 'settled', body: { success: true } });
        stubSheetThatPays();

        payWithCash();

        expect(await screen.findByText('Unlocked')).toBeInTheDocument();
        const verifyArguments = mockVerifyCheckout.mock.calls[0][0] as { body: unknown; token: () => Promise<string> };
        expect(verifyArguments.body).toEqual(payment);
        await expect(verifyArguments.token()).resolves.toBe('token-fresh');
        expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle', {
          headers: { Authorization: 'Bearer token-fresh' },
        });
        expect(window.sessionStorage.getItem(INTENT_KEY)).toBeNull();
      });

      it('a payment still capturing: drops the intent key, says the payment is in, holds the buttons, and opens the recipe from a re-read', async () => {
        authState.session = { access_token: 'token-at-click' };
        authState.credits = 5000;
        authState.marketplaceSpendableCredits = 5000;
        let letRecipeOpen: () => void = () => undefined;
        const fetchMock = stubCashCheckout(new Promise<void>((resolve) => {
          letRecipeOpen = resolve;
        }));
        let intentKeyDuringVerify: string | null = null;
        mockVerifyCheckout.mockImplementationOnce(async () => {
          intentKeyDuringVerify = window.sessionStorage.getItem(INTENT_KEY);
          return { state: 'pending', body: { code: 'PAYMENT_PENDING' } };
        });
        stubSheetThatPays();
        const funnel = listenForProductEvents();
        try {
          payWithCash();

          expect(await screen.findByText(PAYMENT_RECEIVED)).toBeInTheDocument();
          expect(intentKeyDuringVerify).toEqual(expect.any(String));
          expect(window.sessionStorage.getItem(INTENT_KEY)).toBeNull();
          expect(screen.getByRole('button', { name: /pay with cash/i })).toBeDisabled();
          expect(screen.getByRole('button', { name: 'Use 900 credits' })).toBeDisabled();
          await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle', {
              headers: { Authorization: 'Bearer token-fresh' },
            });
          });

          letRecipeOpen();

          expect(await screen.findByText('Unlocked')).toBeInTheDocument();
          expect(screen.queryByText(PAYMENT_RECEIVED)).not.toBeInTheDocument();
          expect(funnel.heard.map(({ eventName }) => eventName)).toEqual([
            'recipe_checkout_started',
            'recipe_checkout_succeeded',
          ]);
        } finally {
          funnel.stop();
        }
      });

      it('a verify that fails after the sheet took the money never shows the failure or invites another payment', async () => {
        authState.session = { access_token: 'token-at-click' };
        authState.credits = 1200;
        const fetchMock = stubCashCheckout(null);
        mockVerifyCheckout.mockRejectedValueOnce(new Error('Unauthorized'));
        stubSheetThatPays();
        const funnel = listenForProductEvents();
        try {
          payWithCash();

          expect(await screen.findByText(PAYMENT_RECEIVED)).toBeInTheDocument();
          expect(screen.queryByText('Unauthorized')).not.toBeInTheDocument();
          expect(screen.queryByText(/try again/i)).not.toBeInTheDocument();
          expect(window.sessionStorage.getItem(INTENT_KEY)).toBeNull();
          expect(screen.getByRole('button', { name: /pay with cash/i })).toBeDisabled();
          expect(screen.getByRole('button', { name: 'Use 900 credits' })).toBeDisabled();
          await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle', {
              headers: { Authorization: 'Bearer token-fresh' },
            });
          });
          expect(screen.getByText(PAYMENT_RECEIVED)).toBeInTheDocument();
          expect(funnel.heard.map(({ eventName }) => eventName)).toEqual(['recipe_checkout_started']);
        } finally {
          funnel.stop();
        }
      });

      it('opens a paid recipe on its own post only, even when the re-read lands while the reader is elsewhere', async () => {
        authState.session = { access_token: 'token-at-click' };
        authState.credits = 1200;
        let letRecipeOpen: () => void = () => undefined;
        const fetchMock = stubCashCheckout(new Promise<void>((resolve) => {
          letRecipeOpen = resolve;
        }), {
          // The reader already owns the second post's recipe.
          '/api/posts/post-2/resource-bundle': () => new Response(JSON.stringify({
            bundle: {
              viewerCanAccess: true,
              viewerIsOwner: false,
              resources: {
                promptText: 'second prompt',
                notesMarkdown: null,
                workflowShareUrl: null,
                attachments: [],
                allowRemix: false,
              },
            },
          })),
        });
        const secondRecipeReads = () => fetchMock.mock.calls
          .filter(([input]) => String(input) === '/api/posts/post-2/resource-bundle').length;
        mockVerifyCheckout.mockResolvedValueOnce({ state: 'pending', body: { code: 'PAYMENT_PENDING' } });
        stubSheetThatPays();
        const items = [
          createShowcaseItem({ id: 'post-1', title: 'Paid Frame', asset: paidAsset }),
          createShowcaseItem({
            id: 'post-2',
            title: 'Second Frame',
            asset: { ...paidAsset, id: 'bundle-2', postId: 'post-2', title: 'Second pack' },
          }),
        ];
        const funnel = listenForProductEvents();
        try {
          const { rerender } = render(<ShowcaseReelViewer {...reelProps({ items, selectedItemId: 'post-1' })} />);
          fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
          fireEvent.click(screen.getByRole('button', { name: /pay with cash/i }));
          expect(await screen.findByText(PAYMENT_RECEIVED)).toBeInTheDocument();

          rerender(<ShowcaseReelViewer {...reelProps({ items, selectedItemId: 'post-2' })} />);
          expect(await screen.findByText(/second prompt/)).toBeInTheDocument();
          letRecipeOpen();
          await waitFor(() => {
            expect(funnel.heard.map(({ eventName }) => eventName)).toContain('recipe_checkout_succeeded');
          });
          await new Promise((resolve) => setTimeout(resolve, 0));

          // The post on screen keeps its own recipe: nothing replaced it, so nothing read it again.
          expect(screen.getByText(/second prompt/)).toBeInTheDocument();
          expect(screen.queryByText(/paid prompt/)).not.toBeInTheDocument();
          expect(secondRecipeReads()).toBe(1);

          rerender(<ShowcaseReelViewer {...reelProps({ items, selectedItemId: 'post-1' })} />);
          expect(await screen.findByText('Unlocked')).toBeInTheDocument();
          expect(screen.queryByText(PAYMENT_RECEIVED)).not.toBeInTheDocument();
        } finally {
          funnel.stop();
        }
      });

      it("holds only the bought post's buy buttons while its payment is awaited", async () => {
        authState.session = { access_token: 'token-at-click' };
        authState.credits = 5000;
        authState.marketplaceSpendableCredits = 5000;
        stubCashCheckout(null);
        mockVerifyCheckout.mockResolvedValueOnce({ state: 'pending', body: { code: 'PAYMENT_PENDING' } });
        stubSheetThatPays();
        const items = [
          createShowcaseItem({ id: 'post-1', title: 'Paid Frame', asset: paidAsset }),
          createShowcaseItem({
            id: 'post-2',
            title: 'Second Frame',
            asset: { ...paidAsset, id: 'bundle-2', postId: 'post-2', title: 'Second pack' },
          }),
        ];

        const { rerender } = render(<ShowcaseReelViewer {...reelProps({ items, selectedItemId: 'post-1' })} />);
        fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
        fireEvent.click(screen.getByRole('button', { name: /pay with cash/i }));
        expect(await screen.findByText(PAYMENT_RECEIVED)).toBeInTheDocument();

        // Another recipe is another purchase.
        rerender(<ShowcaseReelViewer {...reelProps({ items, selectedItemId: 'post-2' })} />);
        fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
        expect(screen.getByRole('button', { name: /pay with cash/i })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Use 900 credits' })).toBeEnabled();
        expect(screen.queryByText(PAYMENT_RECEIVED)).not.toBeInTheDocument();

        // Back on the bought post, its payment is still the one being waited on.
        rerender(<ShowcaseReelViewer {...reelProps({ items, selectedItemId: 'post-1' })} />);
        fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
        expect(screen.getByText(PAYMENT_RECEIVED)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /pay with cash/i })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Use 900 credits' })).toBeDisabled();
      });

      it("starts no wait for a verify that answers after the reel's page has gone", async () => {
        authState.session = { access_token: 'token-at-click' };
        authState.credits = 1200;
        const fetchMock = stubCashCheckout(null);
        let failVerify: (reason: Error) => void = () => undefined;
        mockVerifyCheckout.mockImplementationOnce(() => new Promise((_resolve, reject) => {
          failVerify = reject;
        }));
        stubSheetThatPays();

        const { unmount } = renderPaidReel();
        fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
        fireEvent.click(screen.getByRole('button', { name: /pay with cash/i }));
        await waitFor(() => expect(mockVerifyCheckout).toHaveBeenCalledTimes(1));
        unmount();
        failVerify(new Error('Failed to fetch'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockGetSession).not.toHaveBeenCalled();
        // Only the reel's own access check on entry read the recipe.
        expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/posts/post-1/resource-bundle')).toHaveLength(1);
      });
    });

    it('reports a cash checkout to the funnel', async () => {
      authState.session = { access_token: 'token-1' };
      authState.credits = 1200;
      stubRequests({
        '/api/posts/post-1/resource-bundle/order': () => new Response(JSON.stringify({ error: 'Failed to start checkout.' }), { status: 500 }),
      });
      const funnel = listenForProductEvents();
      try {
        renderPaidReel();
        fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
        fireEvent.click(screen.getByRole('button', { name: /pay with cash/i }));

        await waitFor(() => {
          expect(funnel.heard.map(({ eventName }) => eventName)).toEqual(['recipe_checkout_started', 'recipe_checkout_failed']);
        });
        expect(funnel.heard[0].parameters).toEqual({ method: 'razorpay', post_id: 'post-1' });
      } finally {
        funnel.stop();
      }
    });
  });

  // A failed page left `hasMoreItems` true and loading ended, so the reel asked
  // again at once, and again, for as long as the request kept failing.
  describe('a page that fails to load', () => {
    it('stops asking on its own, says so, and asks again on Retry', () => {
      const onLoadMoreItems = vi.fn();
      const props = reelProps({
        items: [
          createShowcaseItem({ id: 'post-1', title: 'First Frame' }),
          createShowcaseItem({ id: 'post-2', title: 'Second Frame' }),
          createShowcaseItem({ id: 'post-3', title: 'Third Frame' }),
        ],
        hasMoreItems: true,
        onLoadMoreItems,
      });
      const { rerender } = render(<ShowcaseReelViewer {...props} />);
      // Three posts left: the reel asks for the next page.
      expect(onLoadMoreItems).toHaveBeenCalledTimes(1);

      // The host's request runs, then fails.
      rerender(<ShowcaseReelViewer {...props} isLoadingMoreItems />);
      rerender(<ShowcaseReelViewer {...props} loadMoreError="Could not load more posts." />);
      expect(onLoadMoreItems).toHaveBeenCalledTimes(1);

      const notice = screen.getByRole('alert');
      expect(notice).toHaveTextContent('Could not load more posts.');
      fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
      expect(onLoadMoreItems).toHaveBeenCalledTimes(2);
    });
  });

  describe('feed events from the reel', () => {
    const twoRanked = [
      createShowcaseItem({ id: 'post-1', title: 'First Frame', recommendation: ranked('delivery-1', 0) }),
      createShowcaseItem({ id: 'post-2', title: 'Second Frame', recommendation: ranked('delivery-2', 1) }),
    ];
    const advance = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
        await Promise.resolve();
      });
    };
    const drain = async () => {
      await act(async () => {
        await flushShowcaseFeedEvents();
      });
    };

    it('sends open for the post it opened on alone, and one impression per delivery', async () => {
      vi.useFakeTimers();
      const fetchMock = stubRequests();
      try {
        const props = reelProps({ items: twoRanked, accessToken: 'token-1', feedSessionId: 'session-1' });
        const { rerender, unmount } = render(<ShowcaseReelViewer {...props} />);
        await advance(1200);
        rerender(<ShowcaseReelViewer {...props} selectedItemId="post-2" />);
        await advance(1200);
        rerender(<ShowcaseReelViewer {...props} selectedItemId="post-1" />);
        await advance(1200);
        unmount();
        await drain();

        expect(sentFeedEvents(fetchMock).map(({ eventType, postId }) => `${eventType}:${postId}`)).toEqual([
          'open:post-1',
          'impression:post-1',
          'dwell:post-1',
          'impression:post-2',
          'dwell:post-2',
          'dwell:post-1',
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps timing the post on screen through a token refresh, a new session id and an earlier post leaving', async () => {
      vi.useFakeTimers();
      const fetchMock = stubRequests();
      try {
        const earlier = createShowcaseItem({ id: 'post-0', title: 'Earlier Frame', recommendation: ranked('delivery-0', 0) });
        const props = reelProps({
          items: [earlier, ...twoRanked],
          accessToken: 'token-1',
          feedSessionId: 'session-1',
        });
        const { rerender, unmount } = render(<ShowcaseReelViewer {...props} />);
        await advance(400);
        rerender(<ShowcaseReelViewer {...props} items={twoRanked} accessToken="token-2" feedSessionId="session-2" />);
        await advance(900);
        unmount();
        await drain();

        const events = sentFeedEvents(fetchMock);
        expect(events.map(({ eventType, postId }) => `${eventType}:${postId}`)).toEqual([
          'open:post-1',
          'impression:post-1',
          'dwell:post-1',
        ]);
        expect(events[2]).toMatchObject({ durationMs: 1300, feedSessionId: 'session-2' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('files nothing for a post flicked past in under 250 ms', async () => {
      vi.useFakeTimers();
      const fetchMock = stubRequests();
      try {
        const props = reelProps({ items: twoRanked, accessToken: 'token-1', feedSessionId: 'session-1' });
        const { rerender, unmount } = render(<ShowcaseReelViewer {...props} />);
        await advance(1200);
        rerender(<ShowcaseReelViewer {...props} selectedItemId="post-2" />);
        await advance(100);
        unmount();
        await drain();

        expect(sentFeedEvents(fetchMock).map(({ eventType, postId }) => `${eventType}:${postId}`)).toEqual([
          'open:post-1',
          'impression:post-1',
          'dwell:post-1',
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports the recipe opened once per delivery, however often it is opened', async () => {
      authState.session = { access_token: 'token-1' };
      authState.credits = 1200;
      const fetchMock = stubRequests();
      render(<ShowcaseReelViewer {...reelProps({
        items: [createShowcaseItem({ asset: paidAsset, recommendation: ranked('delivery-5', 3) })],
        accessToken: 'token-1',
        feedSessionId: 'session-1',
      })} />);

      const railButton = screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0];
      fireEvent.click(railButton);
      fireEvent.click(railButton);
      await drain();

      expect(sentFeedEvents(fetchMock).filter(({ eventType }) => eventType === 'resource_open')).toEqual([
        expect.objectContaining({
          postId: 'post-1',
          deliveryId: 'delivery-5',
          sourceSurface: 'showcase-reel',
          feedSessionId: 'session-1',
        }),
      ]);
    });
  });

  describe('the details panel', () => {
    const details = (container: HTMLElement) => container.querySelector('[data-reel-scroll-region="details"]') as HTMLElement;
    const prompt = 'A creator-style product shot by a bright window.';

    it('prints the body and the prompt once each', () => {
      const { container } = render(<ShowcaseReelViewer {...reelProps({
        items: [createShowcaseItem({ body: 'A caption from the creator.' })],
      })} />);

      expect(within(details(container)).getAllByText('A caption from the creator.')).toHaveLength(1);
      expect(within(details(container)).getAllByText(prompt)).toHaveLength(1);
    });

    it('prints the prompt once when the post has no body', () => {
      const { container } = render(<ShowcaseReelViewer {...reelProps()} />);

      expect(within(details(container)).getAllByText(prompt)).toHaveLength(1);
    });

    it('copies the prompt it shows', async () => {
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      try {
        render(<ShowcaseReelViewer {...reelProps()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Copy the prompt' }));

        expect(writeText).toHaveBeenCalledWith(prompt);
        expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
      } finally {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    });
  });

  // A `?post=` link to a post outside the loaded pages opened nothing while
  // it was read, and nothing at all when the post was gone.
  describe('a linked post that is not in the list', () => {
    const missing = (overrides: Partial<ReelProps>) => reelProps({ selectedItemId: 'post-gone', ...overrides });

    it('opens on the read while it runs', () => {
      render(<ShowcaseReelViewer {...missing({ selectedItemStatus: 'loading' })} />);

      expect(screen.getByRole('dialog', { name: 'Explore reel viewer' })).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Loading post');
    });

    it("says a deleted or hidden post isn't available, and goes back to where it came from", () => {
      const props = missing({ selectedItemStatus: 'unavailable', originLabel: 'Creator' });
      render(<ShowcaseReelViewer {...props} />);

      expect(screen.getByRole('heading', { name: /this post isn.t available/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Back to Creator' }));
      expect(props.onClose).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(props.onClose).toHaveBeenCalledTimes(2);
    });

    it('offers Try again when the read failed', () => {
      const onRetrySelectedItem = vi.fn();
      render(<ShowcaseReelViewer {...missing({ selectedItemStatus: 'failed', onRetrySelectedItem })} />);

      expect(screen.getByRole('heading', { name: /couldn.t load this post/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(onRetrySelectedItem).toHaveBeenCalledTimes(1);
    });

    it('draws nothing for a post it was told nothing about', () => {
      const { container } = render(<ShowcaseReelViewer {...missing({})} />);

      expect(container).toBeEmptyDOMElement();
    });
  });
});
