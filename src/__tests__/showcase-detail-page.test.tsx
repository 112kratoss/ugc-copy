import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseDetailPage, { generateMetadata } from '@/app/showcase/[id]/page';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import { coverNsfwContent } from '@/lib/nsfw-content';
import { getServerAuthState } from '@/lib/supabase-server';

const mockHeaders = vi.fn(async () => new Headers());
const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
const mockRedirect = vi.fn((target: string) => {
  throw new Error(`NEXT_REDIRECT:${target}`);
});
const getPostReferenceForShowcaseIdMock = vi.fn<(id?: string) => Promise<Record<string, unknown> | null>>();
const getPublicPostDetailMock = vi.fn<(id?: string) => Promise<Record<string, unknown> | null>>();
const recordPostShareEventMock = vi.fn(async (_payload: unknown) => {
  void _payload;
});
const postResourceBundlePanelPropsMock = vi.hoisted(() => vi.fn());
// One router for every render, so a test can read what a click asked of it.
const routerMock = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
// The browser's session, which the page's client rows read (`useAuth`), apart
// from the one the server rendered with.
const clientAuth = vi.hoisted(() => ({
  current: { session: null, user: null } as {
    session: { access_token: string } | null;
    user: { id: string } | null;
  },
}));
const isUserRelationshipBlockedMock = vi.hoisted(() => vi.fn<(input: unknown) => Promise<boolean>>());
const logBackendErrorMock = vi.hoisted(() => vi.fn());

vi.mock('next/headers', () => ({
  headers: () => mockHeaders(),
}));

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
  redirect: (target: string) => mockRedirect(target),
  // The back affordance is a client component that pops history when the viewer
  // arrived from inside the app.
  useRouter: () => routerMock,
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => clientAuth.current,
}));

vi.mock('@/lib/moderation-service', () => ({
  isUserRelationshipBlocked: (input: unknown) => isUserRelationshipBlockedMock(input),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ service: true }),
}));

vi.mock('@/lib/backend-logger', () => ({
  logBackendError: (...args: unknown[]) => logBackendErrorMock(...args),
}));

// The page defers its share-visit write with `after`, which throws outside a
// real request scope. Run the work immediately so the assertions below still
// observe it.
vi.mock('next/server', () => ({
  after: (work: unknown) => {
    if (typeof work === 'function') void (work as () => unknown)();
  },
}));

vi.mock('@/lib/public-posts', () => ({
  getPostReferenceForShowcaseId: (id: string) => getPostReferenceForShowcaseIdMock(id),
  getPublicPostDetail: (id: string) => getPublicPostDetailMock(id),
  getPublicPostMetaDescription: (detail: { description?: string; body?: string; prompt?: string; title: string }) =>
    detail.description || detail.body || detail.prompt || detail.title,
}));

vi.mock('@/lib/post-share-events', () => ({
  recordPostShareEvent: (payload: unknown) => recordPostShareEventMock(payload),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: vi.fn(async () => ({
    session: null,
    credits: null,
  })),
}));

vi.mock('@/app/showcase/[id]/ShowcaseDetailActions', () => ({
  default: ({ postId, viewerIsOwner }: { postId: string; viewerIsOwner: boolean }) => (
    <div data-testid="showcase-detail-actions" data-owner-tools={String(viewerIsOwner)}>{postId}</div>
  ),
}));

vi.mock('@/app/showcase/[id]/PostResourceBundlePanel', () => ({
  default: (props: { postId: string }) => {
    postResourceBundlePanelPropsMock(props);
    return <div data-testid="post-resource-bundle-panel">{props.postId}</div>;
  },
}));

vi.mock('@/components/PostComments', () => ({
  default: () => <div data-testid="post-comments-component">Comments</div>,
}));

vi.mock('@/app/showcase/[id]/ShowcaseDetailEngagementRow', () => ({
  default: ({ postId, canRemix }: { postId: string; canRemix: boolean }) => (
    <div data-testid="showcase-detail-engagement-row">{`${postId}:${canRemix}`}</div>
  ),
}));

/**
 * The network as the page's client parts meet it: the mature-content
 * preference (off), a reveal that answers with `revealedDetail`, and a plain
 * success for a report or a block.
 */
function stubPageFetch(revealedDetail: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    if (url === '/api/content-preferences') {
      return reply({ showMature: init?.method === 'POST' });
    }
    if (url === '/api/posts/post-1/reveal') {
      return reply({ success: true, detail: revealedDetail, expiresInSeconds: 600 });
    }
    return reply({ success: true });
  }));
}

function requestTo(path: string) {
  return vi.mocked(fetch).mock.calls.find(([input]) => String(input) === path);
}

describe('Showcase detail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFeedbackState();
    clientAuth.current = { session: null, user: null };
    isUserRelationshipBlockedMock.mockReset().mockResolvedValue(false);
    stubPageFetch();
    // The reference lookup runs only after a missed post read now, so a test's
    // Once answer can go unread; a reset keeps it from reaching the next test.
    getPostReferenceForShowcaseIdMock.mockReset();
    getPublicPostDetailMock.mockReset();
    getPostReferenceForShowcaseIdMock.mockResolvedValue({
      id: 'post-1',
      generation_id: 'gen-1',
      visibility: 'public',
      category: 'image',
      prompt: 'Prompt',
      source_kind: 'magicbooklet',
    });
    getPublicPostDetailMock.mockResolvedValue({
      id: 'post-1',
      generationId: 'gen-1',
      visibility: 'public',
      mediaUrl: 'https://cdn.example.com/showcase/gen-1.jpg',
      mediaKind: 'image',
      model: 'nano-banana-2',
      title: 'Shared creation',
      description: 'A polished showcase description.',
      prompt: 'A creator holds the product by a bright window.',
      body: '',
      category: 'image',
      postFormat: 'media',
      saveCount: 12,
      remixCount: 3,
      shareCount: 7,
      shareVisitCount: 18,
      createdAt: '2026-03-28T10:00:00.000Z',
      sourceKind: 'magicbooklet',
      sourceTool: null,
      creator: {
        id: 'user-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
      resourceBundle: null,
      canRemix: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders a public post and records a share visit attributed to its origin surface', async () => {
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
      searchParams: Promise.resolve({ s: 'showcase-reel' }),
    }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(screen.getByText('A polished showcase description.')).toBeInTheDocument();
    expect(screen.getByText('A creator holds the product by a bright window.')).toBeInTheDocument();
    expect(screen.getByTestId('showcase-detail-actions')).toHaveTextContent('post-1');
    // The marker names where the share came from. The landing page cannot infer
    // that, and before it existed every visit was filed as 'detail-page'.
    expect(recordPostShareEventMock).toHaveBeenCalledWith({
      postId: 'post-1',
      eventType: 'share_visit',
      sourceSurface: 'showcase-reel',
    });
    expect(screen.getByTestId('canonical-post-comments')).toBeInTheDocument();
    // No bundle on this post — the rail offers no recipe pointer.
    expect(screen.queryByTestId('recipe-jump-link')).not.toBeInTheDocument();
  });

  it('does not count an unmarked visit, which is a bookmark or a search result', async () => {
    // This is the behaviour change: a bare URL used to be counted as a share
    // visit, so bookmarks, Google traffic and pasted links all inflated the
    // number. Only a link the product actually handed out carries the marker.
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
    }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(recordPostShareEventMock).not.toHaveBeenCalled();
  });

  it('files an unrecognised marker under the landing surface rather than dropping it', async () => {
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
      searchParams: Promise.resolve({ s: 'some-future-surface' }),
    }));

    expect(recordPostShareEventMock).toHaveBeenCalledWith({
      postId: 'post-1',
      eventType: 'share_visit',
      sourceSurface: 'detail-page',
    });
  });

  it('does not count an in-app open as a share visit', async () => {
    // Every in-app link carries `from` and no marker. Both guards hold: even a
    // marker copied into an internal link cannot turn one into a share visit.
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
      searchParams: Promise.resolve({ from: 'community', returnTo: '/feed', s: 'showcase-reel' }),
    }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(recordPostShareEventMock).not.toHaveBeenCalled();
  });

  // The page's own report row, by who is looking. A creator was offered a
  // report on their own post here until 2026-10-10: the feed card's menu and
  // the app's leave the row out, and the server refuses the report.
  function signInAs(userId: string) {
    vi.mocked(getServerAuthState).mockResolvedValueOnce({
      session: { user: { id: userId }, access_token: 'server-token' },
      credits: null,
    } as unknown as Awaited<ReturnType<typeof getServerAuthState>>);
    // The browser has refreshed its session since the server rendered.
    clientAuth.current = { session: { access_token: 'live-token' }, user: { id: userId } };
  }

  it('offers the report row to a signed-out visitor', async () => {
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

    expect(screen.getByRole('button', { name: /report post or recipe/i })).toBeInTheDocument();
  });

  it('offers the report row on a post with no creator account, which is no one\'s own', async () => {
    const detail = await getPublicPostDetailMock('post-1');
    getPublicPostDetailMock.mockResolvedValueOnce({
      ...detail,
      creator: { id: null, username: null, name: 'Magicbooklet', avatar: null },
    });
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

    expect(screen.getByRole('button', { name: /report post or recipe/i })).toBeInTheDocument();
  });

  it('offers the report row to another account', async () => {
    signInAs('user-2');
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

    expect(screen.getByRole('button', { name: /report post or recipe/i })).toBeInTheDocument();
  });

  it("leaves the report row out on the creator's own post", async () => {
    signInAs('user-1');
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /report post or recipe/i })).not.toBeInTheDocument();
  });

  // A block either way hides the post, as the app's by-id read does: a shared
  // link used to show it, with a thread that then failed to load.
  describe('across a block', () => {
    it('answers not-found to a viewer on either side of a block', async () => {
      signInAs('user-2');
      isUserRelationshipBlockedMock.mockResolvedValueOnce(true);

      await expect(ShowcaseDetailPage({
        params: Promise.resolve({ id: 'post-1' }),
        searchParams: Promise.resolve({ s: 'showcase-reel' }),
      })).rejects.toThrow('NEXT_NOT_FOUND');

      // One question covers both directions: whom the viewer blocked, and who blocked them.
      expect(isUserRelationshipBlockedMock).toHaveBeenCalledWith({
        adminSupabase: { service: true },
        firstUserId: 'user-2',
        secondUserId: 'user-1',
      });
      // A post the viewer may not see is not a share visit either.
      expect(recordPostShareEventMock).not.toHaveBeenCalled();
    });

    it('treats a block it could not check as a block', async () => {
      signInAs('user-2');
      isUserRelationshipBlockedMock.mockRejectedValueOnce(new Error('connection reset'));

      await expect(ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }))
        .rejects.toThrow('NEXT_NOT_FOUND');
      expect(logBackendErrorMock).toHaveBeenCalledWith(
        'failed_to_verify_block_state_for_post_page',
        { error: expect.any(Error) },
      );
    });

    it('shows the post when there is no block between them', async () => {
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
      expect(isUserRelationshipBlockedMock).toHaveBeenCalledTimes(1);
    });

    it('asks nothing for a signed-out visitor or for the creator on their own post', async () => {
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));
      signInAs('user-1');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      expect(isUserRelationshipBlockedMock).not.toHaveBeenCalled();
    });
  });

  describe('the report form', () => {
    function openReportForm() {
      fireEvent.click(screen.getByRole('button', { name: /report post or recipe/i }));
      return screen.getByRole('combobox', { name: 'Report reason' });
    }

    function reasonLabels() {
      return within(screen.getByRole('combobox', { name: 'Report reason' }))
        .getAllByRole('option')
        .map((option) => option.textContent);
    }

    // A preselected "Misleading recipe" filed every report left on the default
    // under it, on posts with no recipe at all.
    it('starts with no reason chosen and keeps Submit off until one is', async () => {
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      const reason = openReportForm();
      expect(reason).toHaveValue('');
      expect(screen.getByRole('button', { name: /submit report/i })).toBeDisabled();

      fireEvent.change(reason, { target: { value: 'spam' } });
      expect(screen.getByRole('button', { name: /submit report/i })).toBeEnabled();
    });

    it('leaves the recipe reasons out on a post without a recipe', async () => {
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      openReportForm();
      expect(reasonLabels()).toEqual(['Choose a reason', 'Spam', 'Stolen content', 'Unsafe content', 'Other']);
    });

    it('offers them on a post with a recipe, and names the recipe in the report', async () => {
      signInAs('user-2');
      const detail = await getPublicPostDetailMock('post-1');
      getPublicPostDetailMock.mockResolvedValueOnce({
        ...detail,
        resourceBundle: {
          id: 'bundle-1',
          accessMode: 'paid',
          priceQuote: { formatted: '$9.00', note: null },
          resourceKinds: ['prompt'],
          lockedPreview: null,
          viewerCanAccess: false,
          viewerIsOwner: false,
          salesCount: 0,
          resources: null,
          title: 'Recipe',
          summary: '',
          previewText: '',
          priceUsdCents: 900,
          status: 'published',
        },
      });
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      const reason = openReportForm();
      expect(reasonLabels()).toEqual([
        'Choose a reason',
        'Spam',
        'Stolen content',
        'Misleading recipe',
        'Unsafe content',
        'Payment issue',
        'Other',
      ]);
      fireEvent.change(reason, { target: { value: 'misleading_unlock' } });
      fireEvent.click(screen.getByRole('button', { name: /submit report/i }));

      expect(await screen.findByText('Report submitted for review.')).toBeInTheDocument();
      expect(JSON.parse(String(requestTo('/api/posts/post-1/report')?.[1]?.body))).toEqual({
        reason: 'misleading_unlock',
        details: '',
        bundleId: 'bundle-1',
      });
    });

    // The token the page was rendered with expires; a report sent with it
    // after that failed as "Unauthorized".
    it("sends the report with the browser's live session, not the one the page was rendered with", async () => {
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      fireEvent.change(openReportForm(), { target: { value: 'spam' } });
      fireEvent.click(screen.getByRole('button', { name: /submit report/i }));

      expect(await screen.findByText('Report submitted for review.')).toBeInTheDocument();
      const [, init] = requestTo('/api/posts/post-1/report') ?? [];
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer live-token' });
      expect(JSON.parse(String(init?.body))).toEqual({ reason: 'spam', details: '', bundleId: null });
      // The form closes and starts over for the next report.
      expect(screen.queryByRole('combobox', { name: 'Report reason' })).not.toBeInTheDocument();
      expect(openReportForm()).toHaveValue('');
    });

    it('sends a signed-out visitor to sign in and back to the post', async () => {
      window.history.pushState({}, '', '/showcase/post-1');
      try {
        render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

        fireEvent.change(openReportForm(), { target: { value: 'spam' } });
        fireEvent.click(screen.getByRole('button', { name: /submit report/i }));

        expect(routerMock.push).toHaveBeenCalledWith(`/login?returnUrl=${encodeURIComponent('/showcase/post-1')}`);
        expect(requestTo('/api/posts/post-1/report')).toBeUndefined();
      } finally {
        window.history.pushState({}, '', '/');
      }
    });
  });

  // The page shared links land on was the one web surface where the person
  // behind a post could not be reported or blocked.
  describe('Report user and Block user', () => {
    it('offers both to a signed-in viewer who is not the creator', async () => {
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      const rail = screen.getByTestId('canonical-post-actions');
      expect(within(rail).getByRole('button', { name: 'Report user' })).toBeInTheDocument();
      expect(within(rail).getByRole('button', { name: 'Block user' })).toBeInTheDocument();
    });

    it("leaves them out for a signed-out visitor and on the creator's own post", async () => {
      const { unmount } = render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));
      expect(screen.queryByRole('button', { name: 'Report user' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Block user' })).not.toBeInTheDocument();
      unmount();

      signInAs('user-1');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));
      expect(screen.queryByRole('button', { name: 'Report user' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Block user' })).not.toBeInTheDocument();
    });

    it('reports the creator after a confirmation, as a feed card files a creator, and stays on the post', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      fireEvent.click(screen.getByRole('button', { name: 'Report user' }));

      await waitFor(() => {
        expect(readFeedbackSnapshot().toasts.map((toast) => toast.message))
          .toContain('Creator reported. Our moderation team will take a look.');
      });
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Report this creator?'));
      const [, init] = requestTo('/api/moderation/reports') ?? [];
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer live-token' });
      expect(JSON.parse(String(init?.body))).toEqual({
        targetType: 'user',
        targetId: 'user-1',
        reason: 'harassment',
        sourceSurface: 'showcase',
        details: 'Reported from a post page on the web.',
      });
      expect(routerMock.refresh).not.toHaveBeenCalled();
    });

    it('blocks the creator after a confirmation, then draws the page again for the server to hide', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Block this creator?'));
      expect(requestTo('/api/moderation/blocks/user-1')?.[1]).toMatchObject({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer live-token' }),
      });
      expect(readFeedbackSnapshot().toasts.map((toast) => toast.message))
        .toContain('Creator Name is blocked. Their posts are gone from your feed.');
    });

    it('sends nothing and stays on the post when the block is declined', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Block user' })).toBeEnabled());
      expect(requestTo('/api/moderation/blocks/user-1')).toBeUndefined();
      expect(routerMock.refresh).not.toHaveBeenCalled();
    });
  });

  // The gate takes the place of the content, not of the page: the posts most
  // likely to be reported had no Report, Block or byline on screen.
  describe('an NSFW post the server has not revealed', () => {
    async function serveCoveredPost() {
      const detail = await getPublicPostDetailMock('post-1') as Record<string, unknown>;
      getPublicPostDetailMock.mockResolvedValueOnce(coverNsfwContent(detail));
      return detail;
    }

    it('keeps the byline, the rail and the engagement row, and hides the content and the thread', async () => {
      signInAs('user-2');
      await serveCoveredPost();
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      const head = screen.getByTestId('canonical-post-head');
      expect(head).toHaveTextContent('@creator-name');
      // The cover's type and title are placeholders; the gate holds the one heading.
      expect(head).not.toHaveTextContent('Tip / note');
      expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent))
        .toEqual(['Mature content']);
      const media = screen.getByTestId('canonical-post-media');
      expect(within(media).getByRole('button', { name: 'Reveal post' })).toBeInTheDocument();
      expect(within(media).getByTestId('showcase-detail-engagement-row')).toBeInTheDocument();

      const rail = screen.getByTestId('canonical-post-actions');
      expect(within(rail).getByRole('button', { name: /report post or recipe/i })).toBeInTheDocument();
      expect(within(rail).getByRole('button', { name: 'Report user' })).toBeInTheDocument();
      expect(within(rail).getByRole('button', { name: 'Block user' })).toBeInTheDocument();
      expect(within(rail).getByTestId('showcase-detail-actions')).toBeInTheDocument();

      expect(screen.queryByTestId('canonical-post-comments')).not.toBeInTheDocument();
    });

    it('keeps Owner tools for the creator on their own post', async () => {
      signInAs('user-1');
      await serveCoveredPost();
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      expect(screen.getByRole('button', { name: 'Reveal post' })).toBeInTheDocument();
      expect(screen.getByTestId('showcase-detail-actions')).toHaveAttribute('data-owner-tools', 'true');
    });

    it('shows the media and the writing in place once revealed, with the thread under them', async () => {
      signInAs('user-2');
      const detail = await serveCoveredPost();
      stubPageFetch({
        ...detail,
        isNsfw: true,
        nsfwRevealed: true,
        body: 'Behind the curtain.',
        mediaItems: [{
          id: 'media-1',
          url: 'https://cdn.example.com/showcase/gen-1.jpg',
          mediaKind: 'image',
          contentType: 'image/jpeg',
          originalName: null,
          width: 800,
          height: 1000,
          durationSeconds: null,
          sortOrder: 0,
        }],
      });
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

      fireEvent.click(screen.getByRole('checkbox', { name: /18 or older/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Reveal post' }));

      const media = screen.getByTestId('canonical-post-media');
      expect(await within(media).findByRole('heading', { level: 1, name: 'Shared creation' })).toBeInTheDocument();
      expect(within(media).getByText('Behind the curtain.')).toBeInTheDocument();
      expect(within(media).getByRole('img', { name: 'Shared creation' })).toBeInTheDocument();
      expect(within(media).getByTestId('post-comments-component')).toBeInTheDocument();
      // The page around the post is the one it had before.
      expect(screen.getByTestId('canonical-post-head')).toHaveTextContent('@creator-name');
      expect(screen.getByRole('button', { name: /report post or recipe/i })).toBeInTheDocument();

      fireEvent.click(within(media).getByRole('button', { name: 'Hide this post' }));
      expect(within(media).queryByTestId('post-comments-component')).not.toBeInTheDocument();
    });
  });

  it('does not mount public-only comments on an unlisted detail page', async () => {
    const detail = await getPublicPostDetailMock('post-1');
    getPublicPostDetailMock.mockResolvedValueOnce({
      ...detail,
      visibility: 'unlisted',
    });

    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
    }));

    expect(screen.queryByTestId('canonical-post-comments')).not.toBeInTheDocument();
    expect(screen.queryByTestId('post-comments-component')).not.toBeInTheDocument();
  });

  it('keeps media posts in the media frame and preserves public notes', async () => {
    getPublicPostDetailMock.mockResolvedValueOnce({
      id: 'post-1',
      generationId: 'gen-1',
      visibility: 'public',
      mediaUrl: 'https://cdn.example.com/showcase/gen-1.jpg',
      mediaKind: 'image',
      model: 'nano-banana-2',
      title: 'Shared creation',
      description: 'A polished showcase description.',
      prompt: '',
      body: 'Behind-the-scenes context for this frame.',
      category: 'image',
      postFormat: 'mixed',
      saveCount: 12,
      remixCount: 3,
      shareCount: 7,
      shareVisitCount: 18,
      createdAt: '2026-03-28T10:00:00.000Z',
      sourceKind: 'magicbooklet',
      sourceTool: null,
      creator: {
        id: 'user-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
      resourceBundle: null,
      canRemix: true,
    });

    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
    }));

    expect(screen.getByTestId('media-detail-frame')).toBeInTheDocument();
    // The note reads in the document under the media, not in a side panel.
    expect(screen.queryByTestId('post-body-panel')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('media-detail-document')).getByText('Behind-the-scenes context for this frame.')
    ).toBeInTheDocument();
  });

  it('reads as one document: byline, title, media, then engagement', async () => {
    const { container } = render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
    }));

    const head = screen.getByTestId('canonical-post-head');
    const media = screen.getByTestId('canonical-post-media');
    const actions = screen.getByTestId('canonical-post-actions');
    const heading = screen.getByRole('heading', { level: 1, name: 'Shared creation' });
    const frame = screen.getByTestId('media-detail-frame');
    const engagement = screen.getByTestId('showcase-detail-engagement-row');
    const mediaViewport = container.querySelector('[data-showcase-media-viewport]');

    // No identity side card. The masthead is its own grid row, which is what
    // lets the rail start level with the media instead of the byline.
    expect(screen.queryByTestId('canonical-post-identity')).not.toBeInTheDocument();
    expect(head).toContainElement(heading);
    expect(head).toHaveTextContent('@creator-name');
    expect(media).toContainElement(frame);
    expect(head.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(frame.compareDocumentPosition(engagement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(media.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mediaViewport).toHaveClass(
      'canonical-post-media-viewport',
      'w-full',
    );
    expect(media).toHaveClass('canonical-post-media', 'min-w-0');
    expect(actions).toHaveClass('canonical-post-actions', 'min-w-0');
    expect(screen.getByRole('button', { name: 'Open media full screen' })).toBeInTheDocument();
  });

  it('uses the source return context for the detail back link', async () => {
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
      searchParams: Promise.resolve({
        from: 'unlocks',
        returnTo: '/marketplace?access=paid&resource=workflow',
      }),
    }));

    expect(screen.getByRole('link', { name: /back to marketplace/i })).toHaveAttribute(
      'href',
      '/marketplace?access=paid&resource=workflow'
    );
  });

  it('gives a shared video link the post\'s own poster frame', async () => {
    // Video and motion posts used to fall through to the site-wide OG image, so
    // the flagship output produced the least appealing card in every chat app.
    const detail = await getPublicPostDetailMock('post-1');
    getPublicPostDetailMock.mockResolvedValue({
      ...detail,
      mediaKind: 'video',
      mediaUrl: 'https://cdn.example.com/showcase/gen-1.mp4',
      mediaItems: [{
        previewUrl: 'https://cdn.example.com/showcase/gen-1.preview.webp',
        previewStatus: 'ready',
        width: 1080,
        height: 1920,
      }],
    });

    const metadata = await generateMetadata({ params: Promise.resolve({ id: 'post-1' }) });
    const images = Array.isArray(metadata.openGraph?.images)
      ? metadata.openGraph?.images
      : [metadata.openGraph?.images];

    expect(images[0]).toMatchObject({
      url: 'https://cdn.example.com/showcase/gen-1.preview.webp',
      // Real dimensions, not the 1200x630 default: post media is usually
      // portrait, and a wrong ratio makes crawlers letterbox the card.
      width: 1080,
      height: 1920,
    });
  });

  it('falls back to the site card while a poster is still rendering', async () => {
    // Posters are generated asynchronously, so a freshly published video has a
    // storage path before it has an image. Serving it would be a broken card.
    const detail = await getPublicPostDetailMock('post-1');
    getPublicPostDetailMock.mockResolvedValue({
      ...detail,
      mediaKind: 'video',
      mediaUrl: 'https://cdn.example.com/showcase/gen-1.mp4',
      mediaItems: [{
        previewUrl: 'https://cdn.example.com/showcase/gen-1.preview.webp',
        previewStatus: 'pending',
        width: 1080,
        height: 1920,
      }],
    });

    const metadata = await generateMetadata({ params: Promise.resolve({ id: 'post-1' }) });
    const images = Array.isArray(metadata.openGraph?.images)
      ? metadata.openGraph?.images
      : [metadata.openGraph?.images];

    expect(images[0]).toMatchObject({ url: '/opengraph-image.png', width: 1200, height: 630 });
  });

  it('falls back to the site card for legacy posts that carry no media items', async () => {
    const detail = await getPublicPostDetailMock('post-1');
    getPublicPostDetailMock.mockResolvedValue({
      ...detail,
      mediaKind: 'video',
      mediaUrl: 'https://cdn.example.com/showcase/gen-1.mp4',
    });

    const metadata = await generateMetadata({ params: Promise.resolve({ id: 'post-1' }) });
    const images = Array.isArray(metadata.openGraph?.images)
      ? metadata.openGraph?.images
      : [metadata.openGraph?.images];

    expect(images[0]).toMatchObject({ url: '/opengraph-image.png' });
  });

  it('generates canonical metadata for the public detail page', async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ id: 'post-1' }),
    });

    const images = Array.isArray(metadata.openGraph?.images)
      ? metadata.openGraph?.images
      : metadata.openGraph?.images
        ? [metadata.openGraph.images]
        : [];

    expect(metadata.alternates?.canonical).toBe('/showcase/post-1');
    expect(images[0]).toMatchObject({
      url: 'https://cdn.example.com/showcase/gen-1.jpg',
    });
  });

  it('opens a post with one read of its row and no legacy reference lookup', async () => {
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
    }));

    expect(screen.getByRole('heading', { level: 1, name: 'Shared creation' })).toBeInTheDocument();
    expect(getPublicPostDetailMock).toHaveBeenCalledTimes(1);
    expect(getPublicPostDetailMock).toHaveBeenCalledWith('post-1');
    expect(getPostReferenceForShowcaseIdMock).not.toHaveBeenCalled();
  });

  it('redirects legacy generation ids to their post ids', async () => {
    // No post has the generation's id, so the post read misses first.
    getPublicPostDetailMock.mockResolvedValueOnce(null);
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce({
      id: 'post-1',
      generation_id: 'gen-1',
      visibility: 'public',
      category: 'image',
      prompt: 'Prompt',
      source_kind: 'magicbooklet',
    });

    await expect(ShowcaseDetailPage({
      params: Promise.resolve({ id: 'gen-1' }),
    })).rejects.toThrow('NEXT_REDIRECT:/showcase/post-1');
    expect(getPublicPostDetailMock).toHaveBeenCalledWith('gen-1');
    expect(getPostReferenceForShowcaseIdMock).toHaveBeenCalledWith('gen-1');
  });

  it('returns notFound for private or missing posts', async () => {
    getPublicPostDetailMock.mockResolvedValueOnce(null);
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce(null);

    await expect(ShowcaseDetailPage({
      params: Promise.resolve({ id: 'missing' }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('answers not-found, not a redirect to itself, for a post whose row exists but cannot be shown', async () => {
    // A media post with no readable media is one: the reference still finds
    // its row under the same id.
    getPublicPostDetailMock.mockResolvedValueOnce(null);
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce({
      id: 'post-1',
      generation_id: 'gen-1',
      visibility: 'public',
      category: 'image',
      prompt: 'Prompt',
      source_kind: 'magicbooklet',
    });

    await expect(ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('builds metadata from the post read alone, and names a legacy id a redirect', async () => {
    await generateMetadata({ params: Promise.resolve({ id: 'post-1' }) });
    expect(getPostReferenceForShowcaseIdMock).not.toHaveBeenCalled();

    getPublicPostDetailMock.mockResolvedValueOnce(null);
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce({
      id: 'post-1',
      generation_id: 'gen-1',
      visibility: 'public',
      category: 'image',
      prompt: 'Prompt',
      source_kind: 'magicbooklet',
    });
    await expect(generateMetadata({ params: Promise.resolve({ id: 'gen-1' }) })).resolves.toMatchObject({
      title: 'Creation Redirect',
      robots: { index: false, follow: true },
    });

    getPublicPostDetailMock.mockResolvedValueOnce(null);
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce(null);
    await expect(generateMetadata({ params: Promise.resolve({ id: 'missing' }) })).resolves.toEqual({
      title: 'Creation Not Found',
    });
  });

  it('labels a motion post a motion creation, as its feed card does', async () => {
    const detail = await getPublicPostDetailMock('post-1');
    getPublicPostDetailMock.mockReset().mockResolvedValue({
      ...detail,
      mediaKind: 'video',
      category: 'video',
      creationMode: 'motion',
    });

    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
    }));

    const head = screen.getByTestId('canonical-post-head');
    expect(head).toHaveTextContent('Motion creation');
    expect(head).not.toHaveTextContent('Video creation');
  });

  it('renders text-only posts without a media url', async () => {
    getPublicPostDetailMock.mockResolvedValueOnce({
      id: 'post-text',
      generationId: null,
      visibility: 'public',
      mediaUrl: null,
      mediaKind: null,
      model: 'manual',
      title: 'Three hooks that keep working',
      description: '',
      prompt: 'Keep it tight.',
      body: 'Open with tension.\nMake the first line earn attention.',
      category: 'text',
      postFormat: 'text',
      saveCount: 5,
      remixCount: 0,
      shareCount: 2,
      shareVisitCount: 11,
      createdAt: '2026-03-28T10:00:00.000Z',
      sourceKind: 'manual',
      sourceTool: null,
      creator: {
        id: 'user-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
      resourceBundle: null,
      canRemix: false,
    });

    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-text' }),
    }));

    expect(screen.getByTestId('text-detail-note')).toHaveTextContent('Open with tension.');
    expect(screen.getAllByText(/open with tension/i)).toHaveLength(1);
    expect(screen.queryByTestId('media-detail-frame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('post-body-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('showcase-detail-actions')).toHaveTextContent('post-text');

    // The writing is the page: one document column carrying its own byline,
    // with no identity card printing the title a second time.
    expect(screen.queryByTestId('canonical-post-identity')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Three hooks that keep working' })).toBeInTheDocument();
    expect(screen.getAllByText('Three hooks that keep working')).toHaveLength(1);
    // Attribution sits in the masthead row; the note keeps the writing.
    expect(screen.getByTestId('canonical-post-head')).toHaveTextContent('@creator-name');
    expect(screen.getByTestId('canonical-post-head')).toHaveTextContent('Tip / note');

    // The chip bar is media furniture; a written note carries its own byline.
    expect(screen.queryByText(/shared post/i)).not.toBeInTheDocument();

    // Reddit reading order: the conversation flows in the document column,
    // directly under the writing, not in a full-width block below the rail.
    expect(
      within(screen.getByTestId('canonical-post-media')).getByTestId('canonical-post-comments')
    ).toBeInTheDocument();
  });

  it('pitches a text post recipe once, in the document column', async () => {
    getPublicPostDetailMock.mockResolvedValueOnce({
      id: 'post-text',
      generationId: null,
      visibility: 'public',
      mediaUrl: null,
      mediaKind: null,
      model: 'manual',
      title: 'Prompt tip',
      description: '',
      prompt: '',
      body: 'Use fewer modifiers.',
      category: 'text',
      postFormat: 'text',
      saveCount: 0,
      remixCount: 0,
      shareCount: 0,
      shareVisitCount: 0,
      createdAt: '2026-03-28T10:00:00.000Z',
      sourceKind: 'manual',
      sourceTool: null,
      creator: {
        id: 'user-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
      resourceBundle: {
        id: 'bundle-1',
        accessMode: 'free',
        priceQuote: {
          formatted: '$0.00',
          note: null,
        },
        resourceKinds: ['prompt'],
        lockedPreview: {
          resourceKinds: ['prompt'],
          attachmentPreviews: [],
          itemCounts: { prompt: 1 },
          itemPreviews: [{
            type: 'prompt',
            title: 'Prompt',
            role: 'primary',
            remixUse: 'none',
          }],
          hasPrompt: true,
          hasNotes: false,
          hasWorkflow: false,
          hasRemix: false,
          updatedAt: '2026-03-28T10:00:00.000Z',
        },
        viewerCanAccess: false,
        viewerIsOwner: false,
        salesCount: 0,
        resources: null,
        title: 'Prompt tip',
        summary: '',
        previewText: '',
        priceUsdCents: 0,
        status: 'published',
      },
      canRemix: false,
    });

    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-text' }),
    }));

    // A text post pitches the recipe exactly once — in the document column,
    // after the conversation. The rail keeps a one-line pointer to it (not a
    // second pitch), so the recipe stays reachable under a long thread.
    expect(screen.queryByTestId('unlock-summary-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('recipe-jump-link')).toHaveAttribute('href', '#recipe');
    expect(screen.getByTestId('recipe-jump-link')).toHaveTextContent('Free recipe');
    expect(
      within(screen.getByTestId('canonical-post-media')).getByTestId('canonical-post-recipe')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('canonical-post-comments').compareDocumentPosition(
        screen.getByTestId('canonical-post-recipe')
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  // One price wherever a locked recipe is pitched: both ways to pay when it can
  // be bought with cash, credits alone when it is credits-only (a cash figure
  // there named a price no checkout takes).
  it.each([
    { priceUsdCents: 900, formatted: '₹750.00', label: '₹750.00 · 900 credits' },
    { priceUsdCents: 50, formatted: '$0.50', label: '50 credits' },
  ])('prices a locked $priceUsdCents-credit recipe as "$label" in the rail and the bottom bar', async ({
    priceUsdCents,
    formatted,
    label,
  }) => {
    const detail = await getPublicPostDetailMock('post-1');
    getPublicPostDetailMock.mockResolvedValueOnce({
      ...detail,
      resourceBundle: {
        id: 'bundle-1',
        accessMode: 'paid',
        priceQuote: { formatted, note: null },
        resourceKinds: ['prompt'],
        lockedPreview: null,
        viewerCanAccess: false,
        viewerIsOwner: false,
        salesCount: 0,
        resources: null,
        title: 'Recipe',
        summary: '',
        previewText: '',
        priceUsdCents,
        status: 'published',
      },
    });

    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

    expect(screen.getByTestId('recipe-jump-link')).toHaveTextContent(`${label}Unlock`);
    expect(screen.getByText(`Unlock recipe for ${label}`)).toBeInTheDocument();
  });

  it('forwards purchase-time proof media when the buyer opens an older revision', async () => {
    const purchasedMediaItems = [
      { id: 'old-media-1', mediaKey: 'old-output-1', url: 'https://cdn.example.com/old-1.jpg', mediaKind: 'image', contentType: 'image/jpeg', originalName: 'old-1.jpg', width: 800, height: 1000, durationSeconds: null, sortOrder: 0 },
      { id: 'old-media-2', mediaKey: 'old-output-2', url: 'https://cdn.example.com/old-2.jpg', mediaKind: 'image', contentType: 'image/jpeg', originalName: 'old-2.jpg', width: 800, height: 1000, durationSeconds: null, sortOrder: 1 },
    ];
    getPublicPostDetailMock.mockResolvedValue({
      id: 'post-1',
      generationId: 'gen-1',
      visibility: 'public',
      mediaUrl: 'https://cdn.example.com/current-1.jpg',
      mediaKind: 'image',
      mediaItems: [
        { id: 'current-1', mediaKey: 'current-output-1', url: 'https://cdn.example.com/current-1.jpg', mediaKind: 'image', contentType: 'image/jpeg', originalName: 'current-1.jpg', width: 800, height: 1000, durationSeconds: null, sortOrder: 0 },
        { id: 'current-2', mediaKey: 'current-output-2', url: 'https://cdn.example.com/current-2.jpg', mediaKind: 'image', contentType: 'image/jpeg', originalName: 'current-2.jpg', width: 800, height: 1000, durationSeconds: null, sortOrder: 1 },
      ],
      model: 'nano-banana-2',
      title: 'Shared creation',
      description: 'A polished showcase description.',
      prompt: 'Prompt',
      body: '',
      category: 'image',
      postFormat: 'media',
      saveCount: 12,
      remixCount: 3,
      shareCount: 7,
      shareVisitCount: 18,
      createdAt: '2026-03-28T10:00:00.000Z',
      sourceKind: 'magicbooklet',
      sourceTool: null,
      creator: { id: 'user-1', username: 'creator-name', name: 'Creator Name', avatar: null },
      resourceBundle: {
        id: 'bundle-1',
        accessMode: 'paid',
        priceQuote: { formatted: '$9.00', note: null },
        resourceKinds: ['prompt'],
        lockedPreview: null,
        viewerCanAccess: true,
        viewerIsOwner: false,
        salesCount: 3,
        resources: {
          promptText: 'Latest prompt', notesMarkdown: null, workflowShareUrl: null,
          workflowSnapshot: null, attachments: [], allowRemix: false, sections: [], items: [],
        },
        purchasedRevision: {
          revisionNumber: 1,
          purchasedAt: '2026-07-01T00:00:00.000Z',
          title: 'Purchased recipe',
          summary: 'Purchased summary',
          previewText: 'Purchased preview',
          accessMode: 'paid',
          priceUsdCents: 500,
          mediaItems: purchasedMediaItems,
          resources: {
            promptText: 'Purchased prompt', notesMarkdown: null, workflowShareUrl: null,
            workflowSnapshot: null, attachments: [], allowRemix: false, sections: [], items: [],
          },
        },
        title: 'Latest recipe',
        summary: 'Latest summary',
        previewText: 'Latest preview',
        priceUsdCents: 900,
        status: 'published',
      },
      canRemix: false,
    });

    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

    expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({
      purchasedRevision: expect.objectContaining({ mediaItems: purchasedMediaItems }),
    }));
  });
});
