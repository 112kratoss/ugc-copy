import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import * as pageModule from '@/app/showcase/[id]/page';
import ReportPostButton from '@/app/showcase/[id]/ReportPostButton';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import { coverNsfwContent } from '@/lib/nsfw-content';
import { clearOwnerPageEditsForTests, rememberOwnerPostVisibility } from '@/lib/owner-page-edits';
import { asksAbsentRecipeAsNone, postRecipeReadPath } from '@/lib/post-recipe-read';
import { PUBLIC_PAGE_REVALIDATE_SECONDS } from '@/lib/public-page-cache';
import {
  SESSION_CHECK_DEADLINE_MS,
  SESSION_CHECK_START_DEADLINE_MS,
  useViewerSessionCheck,
} from '@/lib/viewer-session-check';

const { default: ShowcaseDetailPage, generateMetadata } = pageModule;

// A post's id and a legacy generation id are UUIDs: the page answers not-found
// for anything else before it reads.
const POST_ID = '5a1e0000-0000-4000-8000-000000000001';
const GENERATION_ID = '6e0e0000-0000-4000-8000-000000000001';
const TEXT_POST_ID = '5a1e0000-0000-4000-8000-0000000000aa';
const MISSING_POST_ID = '5a1e0000-0000-4000-8000-00000000dead';
// The page's read of the viewer's recipe: one that is not there for them is answered as none.
const RECIPE_READ = postRecipeReadPath(POST_ID);

// The page is one cached render for everyone (ISR): a read of the request's
// headers, its cookies or the server's session would make it render per request
// again, and could put one viewer's page in front of everyone. Each throws here.
const requestTimeRead = vi.hoisted(() => vi.fn((what: string) => {
  throw new Error(`The post page read ${what}: it must stay one cached render for everyone`);
}));
const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
const mockRedirect = vi.fn((target: string) => {
  throw new Error(`NEXT_REDIRECT:${target}`);
});
const getPostReferenceForShowcaseIdMock = vi.fn<(id?: string) => Promise<Record<string, unknown> | null>>();
const getPublicPostDetailMock = vi.fn<(id?: string) => Promise<Record<string, unknown> | null>>();
// What each read of the post asked for besides its id.
const getPublicPostDetailOptionsMock = vi.fn<(id: string, options: unknown) => void>();
const postResourceBundlePanelPropsMock = vi.hoisted(() => vi.fn());
const showcaseDetailActionsPropsMock = vi.hoisted(() => vi.fn());
const postCommentsPropsMock = vi.hoisted(() => vi.fn());
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
    user: { id: string; is_anonymous?: boolean } | null;
    /** The provider is still checking a session cookie. */
    isLoading?: boolean;
    /** When the provider began that check (`performance.now()`). */
    sessionCheckStartedAt?: number | null;
    /** Asks the provider to check the session again. */
    refreshSessionState?: () => Promise<void>;
  },
}));
// The address the page was opened at, as the browser's router reads it: the
// page itself never sees it.
const locationSearch = vi.hoisted(() => ({ current: '' }));
// Whether the viewer came to the page from another page of the site in this tab:
// the post is not the page the document was loaded at, and a link click there
// counted one navigation. A full load of the post's own address is neither.
const navigatedInThisDocument = vi.hoisted(() => ({ current: false }));
const reachedInThisDocument = vi.hoisted(() => ({ current: false }));

vi.mock('@/components/navigation-progress-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/navigation-progress-state')>()),
  hasNavigatedInThisDocument: () => navigatedInThisDocument.current,
  isPageReachedInThisDocument: () => reachedInThisDocument.current,
}));

vi.mock('next/headers', () => ({
  headers: () => requestTimeRead('the request headers'),
  cookies: () => requestTimeRead('the request cookies'),
}));

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
  redirect: (target: string) => mockRedirect(target),
  // The back affordance is a client component that pops history when the viewer
  // arrived from inside the app.
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(locationSearch.current),
  usePathname: () => `/showcase/${POST_ID}`,
}));

vi.mock('@/components/AuthProvider', () => ({
  // `OptionalAuth`: the page resolves the session in the browser.
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => clientAuth.current,
}));

vi.mock('@/lib/public-posts', () => ({
  getPostReferenceForShowcaseId: (id: string) => getPostReferenceForShowcaseIdMock(id),
  getPublicPostDetail: (id: string, options?: unknown) => {
    getPublicPostDetailOptionsMock(id, options);
    return getPublicPostDetailMock(id);
  },
  getPublicPostMetaDescription: (detail: { description?: string; body?: string; prompt?: string; title: string }) =>
    detail.description || detail.body || detail.prompt || detail.title,
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => requestTimeRead("the viewer's session"),
}));

vi.mock('@/app/showcase/[id]/ShowcaseDetailActions', () => ({
  default: (props: { postId: string; ownerTools: string | null }) => {
    showcaseDetailActionsPropsMock(props);
    return (
      <div
        data-testid="showcase-detail-actions"
        data-owner-tools={String(props.ownerTools === 'ready')}
        data-owner-tools-state={props.ownerTools ?? 'none'}
      >
        {props.postId}
      </div>
    );
  },
}));

vi.mock('@/app/showcase/[id]/PostResourceBundlePanel', () => ({
  default: (props: { postId: string }) => {
    postResourceBundlePanelPropsMock(props);
    return <div data-testid="post-resource-bundle-panel">{props.postId}</div>;
  },
}));

vi.mock('@/components/PostComments', () => ({
  default: (props: { postId: string; deliveryId?: string | null }) => {
    postCommentsPropsMock(props);
    return <div data-testid="post-comments-component">Comments</div>;
  },
}));

vi.mock('@/app/showcase/[id]/ShowcaseDetailEngagementRow', () => ({
  default: ({ postId, canRemix, recipeRemix, creatorRemixMark, creatorCanRemix, remixHeld }: {
    postId: string;
    canRemix: boolean;
    recipeRemix?: { access: string; priceLabel: string } | null;
    creatorRemixMark?: string;
    creatorCanRemix?: boolean;
    remixHeld?: boolean;
  }) => (
    <div
      data-testid="showcase-detail-engagement-row"
      data-recipe-remix={recipeRemix ? `${recipeRemix.access}:${recipeRemix.priceLabel}` : ''}
      data-creator-remix={creatorRemixMark ? `${creatorRemixMark}:${creatorCanRemix ? 'open' : 'none'}` : ''}
      data-remix-held={String(Boolean(remixHeld))}
    >
      {`${postId}:${canRemix}`}
    </div>
  ),
}));

/**
 * The network as the page's client parts meet it: the mature-content
 * preference (off), a reveal that answers with `revealedDetail`, the viewer's
 * exclusions (`blockedCreatorIds`, none unless a test says so), the viewer's
 * own read of the recipe (`viewerBundle`: none unless a test gives one, so the
 * page's stands), and a plain success for a report, a block or a visit.
 */
function stubPageFetch(revealedDetail: Record<string, unknown> = {}, {
  blockedCreatorIds = [],
  viewerBundle,
}: {
  blockedCreatorIds?: string[];
  viewerBundle?: Record<string, unknown> | null;
} = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
    if (url === '/api/content-preferences') {
      return reply({ showMature: init?.method === 'POST' });
    }
    if (url === `/api/posts/${POST_ID}/reveal`) {
      return reply({ success: true, detail: revealedDetail, expiresInSeconds: 600 });
    }
    if (url === '/api/showcase/viewer-exclusions') {
      return reply({ blockedCreatorIds, hiddenCreatorIds: [], hiddenPostIds: [] });
    }
    if (url.split('?')[0] === `/api/posts/${POST_ID}/resource-bundle` && viewerBundle !== undefined) {
      // As the route answers: none for one asked with absent=none, else not found.
      return viewerBundle
        ? reply({ success: true, bundle: viewerBundle })
        : asksAbsentRecipeAsNone(url)
          ? reply({ success: true, bundle: null })
          : reply({ error: 'Resource bundle not found.' }, 404);
    }
    return reply({ success: true });
  }));
}

function requestTo(path: string) {
  return vi.mocked(fetch).mock.calls.find(([input]) => String(input) === path);
}

function requestsTo(path: string) {
  return vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === path);
}

/** The share visits the page sent, by what they said. */
function shareVisitsSent() {
  return requestsTo('/api/showcase/share').map(([, init]) => ({
    body: JSON.parse(String(init?.body)),
    authorization: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
  }));
}

/** Opens the page as the browser would, at `/showcase/<id><search>`. */
function openedAt(search: string) {
  locationSearch.current = search;
}

/** Opens the page from a link on another page of the site, as an in-app open is. */
function openedFromInsideTheSite(search: string) {
  navigatedInThisDocument.current = true;
  reachedInThisDocument.current = true;
  openedAt(search);
}

/**
 * Opens the page by the router after the document's first page, with no link click
 * counted: an alert's tap, or the composer's Publish replacing the composer.
 */
function openedByTheRouter(search: string) {
  reachedInThisDocument.current = true;
  openedAt(search);
}

describe('Showcase detail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFeedbackState();
    clientAuth.current = { session: null, user: null };
    locationSearch.current = '';
    navigatedInThisDocument.current = false;
    reachedInThisDocument.current = false;
    requestTimeRead.mockClear();
    stubPageFetch();
    // The reference lookup runs only after a missed post read now, so a test's
    // Once answer can go unread; a reset keeps it from reaching the next test.
    getPostReferenceForShowcaseIdMock.mockReset();
    getPublicPostDetailMock.mockReset();
    getPublicPostDetailOptionsMock.mockReset();
    getPostReferenceForShowcaseIdMock.mockResolvedValue({
      id: POST_ID,
      generation_id: GENERATION_ID,
      visibility: 'public',
      category: 'image',
      prompt: 'Prompt',
      source_kind: 'magicbooklet',
    });
    getPublicPostDetailMock.mockResolvedValue({
      id: POST_ID,
      generationId: GENERATION_ID,
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
    clearOwnerPageEditsForTests();
  });

  it('renders a public post and records a share visit attributed to its origin surface', async () => {
    openedAt('?s=showcase-reel');
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(screen.getByText('A polished showcase description.')).toBeInTheDocument();
    expect(screen.getByText('A creator holds the product by a bright window.')).toBeInTheDocument();
    expect(screen.getByTestId('showcase-detail-actions')).toHaveTextContent(POST_ID);
    // The marker names where the share came from. The landing page cannot infer
    // that, and before it existed every visit was filed as 'detail-page'. The
    // browser sends it, once: the cached page cannot see the query.
    await waitFor(() => expect(shareVisitsSent()).toEqual([{
      body: { postId: POST_ID, eventType: 'share_visit', sourceSurface: 'showcase-reel' },
      authorization: null,
    }]));
    expect(requestTimeRead).not.toHaveBeenCalled();
    // The conversation is a panel in the rail, beside the post, and a post
    // with no recipe shows its prompt under the post, where a recipe would
    // show its own: the rail's card held it, so the same words sat beside
    // the picture on one post and under it on the next (owner, 2026-11-13).
    const rail = screen.getByTestId('canonical-post-actions');
    const column = screen.getByTestId('canonical-post-media');
    expect(within(rail).getByTestId('canonical-post-comments')).toBeInTheDocument();
    // Drawn as a panel with a close button, which folds it to one row; the
    // thread stays mounted under the fold, so its draft and pages survive.
    const threadProps = postCommentsPropsMock.mock.lastCall?.[0] as { layout?: string; onClose?: () => void };
    expect(threadProps.layout).toBe('panel');
    act(() => threadProps.onClose?.());
    const panel = within(rail).getByTestId('canonical-post-comments');
    expect(panel).toHaveAttribute('data-open', 'false');
    expect(within(panel).getByTestId('post-comments-component')).not.toBeVisible();
    // Close hid the button it was pressed on: focus is on the row that opens
    // the panel again, which names what it opens.
    const unfold = within(panel).getByRole('button', { name: /^Comments/ });
    expect(unfold).toHaveFocus();
    expect(unfold).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(unfold.getAttribute('aria-controls') ?? ''))
      .toContainElement(within(panel).getByTestId('post-comments-component'));
    fireEvent.click(unfold);
    expect(panel).toHaveAttribute('data-open', 'true');
    expect(within(panel).getByTestId('post-comments-component')).toBeVisible();
    expect(within(column).queryByTestId('canonical-post-comments')).not.toBeInTheDocument();
    const prompt = within(column).getByTestId('canonical-post-prompt');
    expect(within(prompt).getByRole('heading', { level: 2, name: 'Prompt' })).toBeInTheDocument();
    expect(prompt).toHaveTextContent('A creator holds the product by a bright window.');
    expect(rail).not.toHaveTextContent('A creator holds the product by a bright window.');
    expect(
      screen.getByTestId('showcase-detail-engagement-row').compareDocumentPosition(prompt)
        & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // No bundle on this post — the rail offers no recipe pointer.
    expect(screen.queryByTestId('recipe-jump-link')).not.toBeInTheDocument();
  });

  it('does not count an unmarked visit, which is a bookmark or a search result', async () => {
    // This is the behaviour change: a bare URL used to be counted as a share
    // visit, so bookmarks, Google traffic and pasted links all inflated the
    // number. Only a link the product actually handed out carries the marker.
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: POST_ID }),
    }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(shareVisitsSent()).toEqual([]);
  });

  it('sends an unrecognised marker on, which the server files under the landing surface', async () => {
    // `parseShowcaseSharePayloadForRoute` files it as 'detail-page' (the
    // contract fixture holds that), as the page did before the browser sent it.
    openedAt('?s=some-future-surface');
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    await waitFor(() => expect(shareVisitsSent().map(({ body }) => body)).toEqual([
      { postId: POST_ID, eventType: 'share_visit', sourceSurface: 'some-future-surface' },
    ]));
  });

  it('sends a signed-in visitor\'s visit with their session, so the server records none across a block', async () => {
    openedAt('?s=showcase-reel');
    signInAs('user-2');
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    await waitFor(() => expect(shareVisitsSent()).toEqual([{
      body: { postId: POST_ID, eventType: 'share_visit', sourceSurface: 'showcase-reel' },
      authorization: 'Bearer live-token',
    }]));
  });

  // A link a signed-in account shares carries its invite, `?r=<code>`. The
  // page records it for a visitor with no account, as the invite landing would,
  // and shows the post: there is no landing in between.
  describe('the invite a shared link carries', () => {
    const CODE = '30b5f916c7aa';
    const inviteVisitsSent = () => requestsTo('/api/referrals/visit').map(([, init]) => ({
      body: JSON.parse(String(init?.body)),
      authorization: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
    }));

    it('is recorded once for a visitor, beside the share visit, with the post as where it led', async () => {
      openedAt(`?s=showcase-reel&r=${CODE}`);
      const { rerender } = render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
      rerender(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(inviteVisitsSent()).toEqual([{
        body: { code: CODE, source: 'web', kind: 'shared_link', next: `/showcase/${POST_ID}` },
        authorization: null,
      }]));
      expect(shareVisitsSent()).toHaveLength(1);
      // The visitor is looking at the post, not at an invite page.
      expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
      expect(requestTimeRead).not.toHaveBeenCalled();
    });

    it('is recorded for a guest, who has no account yet', async () => {
      openedAt(`?s=feed&r=${CODE}`);
      clientAuth.current = { session: { access_token: 'guest-token' }, user: { id: 'guest-1', is_anonymous: true } };
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(inviteVisitsSent()).toHaveLength(1));
    });

    it('is not recorded for an account that exists, the sharer opening their own link included', async () => {
      openedAt(`?s=showcase-reel&r=${CODE}`);
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(shareVisitsSent()).toHaveLength(1));
      expect(inviteVisitsSent()).toEqual([]);
    });

    it('is recorded whatever the post’s visibility: the invite is the sharer’s, not the post’s', async () => {
      const detail = await getPublicPostDetailMock(POST_ID);
      getPublicPostDetailMock.mockResolvedValueOnce({ ...detail, visibility: 'unlisted' });
      openedAt(`?s=showcase-reel&r=${CODE}`);
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(inviteVisitsSent()).toHaveLength(1));
      expect(shareVisitsSent()).toEqual([]);
    });

    it.each(['?s=showcase-reel', '?s=showcase-reel&r=nope', '?s=showcase-reel&ref=30b5f916c7aa'])(
      'sends nothing for a link with no invite on it (%s)',
      async (search) => {
        openedAt(search);
        render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

        await waitFor(() => expect(shareVisitsSent()).toHaveLength(1));
        expect(inviteVisitsSent()).toEqual([]);
      },
    );
  });

  it('does not count an in-app open as a share visit', async () => {
    // Every in-app link carries `from` and no marker. Both guards hold: even a
    // marker copied into an internal link cannot turn one into a share visit.
    openedFromInsideTheSite('?from=community&returnTo=%2Ffeed&s=showcase-reel');
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: /back to/i })).toHaveAttribute('href', '/feed'));
    expect(shareVisitsSent()).toEqual([]);
  });

  // Owner, 2026-11-15: a shared link's "Back to Community" was not needed. Someone who
  // arrived by the post's own address has no page of the site behind them, and the menu
  // already leads on; the same address opened from inside the site keeps its way back.
  it('draws no way back for a post opened by a shared link', async () => {
    openedAt('?s=showcase-reel');
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    // The page's script has read its address by the time the visit goes out.
    await waitFor(() => expect(shareVisitsSent()).toHaveLength(1));
    expect(screen.queryByRole('link', { name: /^back/i })).toBeNull();
  });

  it('draws no way back for an in-site address loaded on its own (a refresh, a new tab)', async () => {
    openedAt('?from=home&returnTo=%2F');
    const page = render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^back/i })).toBeNull();

    // The same address reached from Home in this tab: the way back, by Home's name.
    page.unmount();
    openedFromInsideTheSite('?from=home&returnTo=%2F');
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
    expect(await screen.findByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/');
  });

  // Review of #829: the way back was drawn only after a counted link click, so a
  // post opened by an alert's tap or the composer's Publish after the first page
  // lost it. Any arrival but the document's first page draws it.
  it('draws the way back for a post the router opened after the first page', async () => {
    openedByTheRouter('?from=home&returnTo=%2F');
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(await screen.findByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/');
  });

  it('draws a plain Back, for a link that named no page, only where it steps back inside the site', async () => {
    const historyLength = Object.getOwnPropertyDescriptor(window.history, 'length');
    Object.defineProperty(window.history, 'length', { value: 3, configurable: true });
    try {
      // Opened by the router with no link click counted: a step back could leave
      // the site, and "Back" names no page of its own to open instead.
      openedByTheRouter('');
      const page = render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
      expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /^back/i })).toBeNull();

      page.unmount();
      openedFromInsideTheSite('');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
      expect(await screen.findByRole('link', { name: 'Back' })).toBeInTheDocument();
    } finally {
      if (historyLength) Object.defineProperty(window.history, 'length', historyLength);
      else delete (window.history as { length?: number }).length;
    }
  });

  it('does not count a visit to an unlisted post', async () => {
    const detail = await getPublicPostDetailMock(POST_ID);
    getPublicPostDetailMock.mockResolvedValueOnce({ ...detail, visibility: 'unlisted' });
    openedAt('?s=showcase-reel');
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(shareVisitsSent()).toEqual([]);
  });

  // The page's own report row, by who is looking. A creator was offered a
  // report on their own post here until 2026-10-10: the feed card's menu and
  // the app's leave the row out, and the server refuses the report.
  function signInAs(userId: string) {
    // Only the browser knows who is looking: the server's render is everyone's.
    clientAuth.current = { session: { access_token: 'live-token' }, user: { id: userId } };
  }

  it('offers the report row to a signed-out visitor', async () => {
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(screen.getByRole('button', { name: /report post or recipe/i })).toBeInTheDocument();
  });

  it('offers the report row on a post with no creator account, which is no one\'s own', async () => {
    const detail = await getPublicPostDetailMock(POST_ID);
    getPublicPostDetailMock.mockResolvedValueOnce({
      ...detail,
      creator: { id: null, username: null, name: 'Magicbooklet', avatar: null },
    });
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(screen.getByRole('button', { name: /report post or recipe/i })).toBeInTheDocument();
  });

  it('offers the report row to another account', async () => {
    signInAs('user-2');
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(screen.getByRole('button', { name: /report post or recipe/i })).toBeInTheDocument();
  });

  it("leaves the report row out on the creator's own post", async () => {
    signInAs('user-1');
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /report post or recipe/i })).not.toBeInTheDocument();
  });

  // A block either way hides the post, as the app's by-id read does: a shared
  // link used to show it, with a thread that then failed to load. The server's
  // render is everyone's, so the browser asks, and draws the not-found page.
  describe('across a block', () => {
    it('draws the not-found page for a viewer on either side of a block', async () => {
      signInAs('user-2');
      stubPageFetch({}, { blockedCreatorIds: ['user-1'] });
      openedAt('?s=showcase-reel');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      expect(await screen.findByTestId('showcase-post-unavailable')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /shared creation/i })).not.toBeInTheDocument();
      // One question covers both directions: whom the viewer blocked, and who blocked them.
      const [, init] = requestTo('/api/showcase/viewer-exclusions') ?? [];
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer live-token' });
      expect(JSON.parse(String(init?.body))).toEqual({ items: [{ postId: POST_ID, creatorId: 'user-1' }] });
      // A visit the server would refuse across the block carries the session that lets it.
      expect(shareVisitsSent().every(({ authorization }) => authorization === 'Bearer live-token')).toBe(true);
    });

    it('keeps the post as everyone sees it when the check cannot be made', async () => {
      signInAs('user-2');
      vi.mocked(fetch).mockImplementation(async (input) => (
        String(input) === '/api/showcase/viewer-exclusions'
          ? { ok: false, status: 500, json: async () => ({ error: 'Failed' }) } as Response
          : { ok: true, status: 200, json: async () => ({ success: true }) } as Response
      ));
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(requestTo('/api/showcase/viewer-exclusions')).toBeDefined());
      expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
      expect(screen.queryByTestId('showcase-post-unavailable')).not.toBeInTheDocument();
    });

    it('shows the post when there is no block between them', async () => {
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(requestsTo('/api/showcase/viewer-exclusions')).toHaveLength(1));
      expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    });

    it('asks nothing for a signed-out visitor or for the creator on their own post', async () => {
      const visitor = render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
      visitor.unmount();
      signInAs('user-1');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
      expect(requestTo('/api/showcase/viewer-exclusions')).toBeUndefined();
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
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      const reason = openReportForm();
      expect(reason).toHaveValue('');
      expect(screen.getByRole('button', { name: /submit report/i })).toBeDisabled();

      fireEvent.change(reason, { target: { value: 'spam' } });
      expect(screen.getByRole('button', { name: /submit report/i })).toBeEnabled();
    });

    it('leaves the recipe reasons out on a post without a recipe', async () => {
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      openReportForm();
      expect(reasonLabels()).toEqual(['Choose a reason', 'Spam', 'Stolen content', 'Unsafe content', 'Other']);
    });

    it('offers them on a post with a recipe, and names the recipe in the report', async () => {
      signInAs('user-2');
      const detail = await getPublicPostDetailMock(POST_ID);
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
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

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
      expect(JSON.parse(String(requestTo(`/api/posts/${POST_ID}/report`)?.[1]?.body))).toEqual({
        reason: 'misleading_unlock',
        details: '',
        bundleId: 'bundle-1',
      });
    });

    // The token the page was rendered with expires; a report sent with it
    // after that failed as "Unauthorized".
    it("sends the report with the browser's live session, not the one the page was rendered with", async () => {
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      fireEvent.change(openReportForm(), { target: { value: 'spam' } });
      fireEvent.click(screen.getByRole('button', { name: /submit report/i }));

      expect(await screen.findByText('Report submitted for review.')).toBeInTheDocument();
      const [, init] = requestTo(`/api/posts/${POST_ID}/report`) ?? [];
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer live-token' });
      expect(JSON.parse(String(init?.body))).toEqual({ reason: 'spam', details: '', bundleId: null });
      // The form closes and starts over for the next report.
      expect(screen.queryByRole('combobox', { name: 'Report reason' })).not.toBeInTheDocument();
      expect(openReportForm()).toHaveValue('');
    });

    it('sends a signed-out visitor to sign in and back to the post', async () => {
      window.history.pushState({}, '', `/showcase/${POST_ID}`);
      try {
        render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

        fireEvent.change(openReportForm(), { target: { value: 'spam' } });
        fireEvent.click(screen.getByRole('button', { name: /submit report/i }));

        expect(routerMock.push).toHaveBeenCalledWith(`/login?returnUrl=${encodeURIComponent(`/showcase/${POST_ID}`)}`);
        expect(requestTo(`/api/posts/${POST_ID}/report`)).toBeUndefined();
      } finally {
        window.history.pushState({}, '', '/');
      }
    });
  });

  // A Home card opens the page with its delivery, as the app's text card opens
  // its post route with `deliveryId`. A report without one reached neither the
  // post's stats nor the reporter's interests, though a ranked card showed it.
  describe('opened from a ranked card', () => {
    const openedFromCard = `?from=home&returnTo=${encodeURIComponent('/?chip=notes')}&delivery=4242`;

    function fileSpamReport() {
      fireEvent.click(screen.getByRole('button', { name: /report post or recipe/i }));
      fireEvent.change(screen.getByRole('combobox', { name: 'Report reason' }), { target: { value: 'spam' } });
      fireEvent.click(screen.getByRole('button', { name: /submit report/i }));
    }

    it('files a report with the delivery the card opened the page with', async () => {
      signInAs('user-2');
      openedAt(openedFromCard);
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      fileSpamReport();

      expect(await screen.findByText('Report submitted for review.')).toBeInTheDocument();
      expect(JSON.parse(String(requestTo(`/api/posts/${POST_ID}/report`)?.[1]?.body))).toEqual({
        reason: 'spam',
        details: '',
        bundleId: null,
        deliveryId: '4242',
      });
    });

    it('hands the delivery to the thread, which sends it with each new comment', async () => {
      openedAt(openedFromCard);
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      expect(screen.getByTestId('post-comments-component')).toBeInTheDocument();
      expect(postCommentsPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({
        postId: POST_ID,
        deliveryId: '4242',
      }));
    });

    it('sends no delivery when the link carries an empty one', async () => {
      signInAs('user-2');
      openedAt(openedFromCard.replace('delivery=4242', 'delivery=%20'));
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      expect(postCommentsPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryId: null }));
      fileSpamReport();

      expect(await screen.findByText('Report submitted for review.')).toBeInTheDocument();
      expect(JSON.parse(String(requestTo(`/api/posts/${POST_ID}/report`)?.[1]?.body))).toEqual({
        reason: 'spam',
        details: '',
        bundleId: null,
      });
    });

    it('keeps the delivery out of the canonical URL and the structured data', async () => {
      openedAt(openedFromCard);
      const { container } = render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      const structuredData = container.querySelector('script[type="application/ld+json"]')?.textContent ?? '';
      expect(structuredData).toContain(`/showcase/${POST_ID}`);
      expect(structuredData).not.toContain('4242');

      const metadata = await generateMetadata({ params: Promise.resolve({ id: POST_ID }) });
      expect(metadata.alternates?.canonical).toBe(`/showcase/${POST_ID}`);
      expect(metadata.openGraph?.url).toBe(`/showcase/${POST_ID}`);
    });

    // The redirect is cached with the page, which never reads the query, so a
    // legacy id opened from a ranked card lands without its way back or its
    // delivery (in-app cards link by post id).
    it('redirects a legacy generation id to the post\'s own address', async () => {
      getPublicPostDetailMock.mockResolvedValueOnce(null);
      getPostReferenceForShowcaseIdMock.mockResolvedValueOnce({
        id: POST_ID,
        generation_id: GENERATION_ID,
        visibility: 'public',
        category: 'image',
        prompt: 'Prompt',
        source_kind: 'magicbooklet',
      });
      openedAt(openedFromCard);

      await expect(ShowcaseDetailPage({ params: Promise.resolve({ id: GENERATION_ID }) })).rejects.toThrow('NEXT_REDIRECT');
      expect(mockRedirect).toHaveBeenCalledWith(`/showcase/${POST_ID}`);
    });
  });

  // The page shared links land on was the one web surface where the person
  // behind a post could not be reported or blocked.
  describe('Report user and Block user', () => {
    it('offers both to a signed-in viewer who is not the creator', async () => {
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      const rail = screen.getByTestId('canonical-post-actions');
      expect(within(rail).getByRole('button', { name: 'Report user' })).toBeInTheDocument();
      expect(within(rail).getByRole('button', { name: 'Block user' })).toBeInTheDocument();
    });

    it("leaves them out for a signed-out visitor and on the creator's own post", async () => {
      const { unmount } = render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
      expect(screen.queryByRole('button', { name: 'Report user' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Block user' })).not.toBeInTheDocument();
      unmount();

      signInAs('user-1');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
      expect(screen.queryByRole('button', { name: 'Report user' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Block user' })).not.toBeInTheDocument();
    });

    it('reports the creator after a confirmation, as a feed card files a creator, and stays on the post', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

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

    it('blocks the creator after a confirmation, then hides the post as a block does', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      // The server's render is the one cached for everyone, so drawing it again
      // would show the post: the page hides it itself.
      expect(await screen.findByTestId('showcase-post-unavailable')).toBeInTheDocument();
      expect(routerMock.refresh).not.toHaveBeenCalled();
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
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Block user' })).toBeEnabled());
      expect(requestTo('/api/moderation/blocks/user-1')).toBeUndefined();
      expect(routerMock.refresh).not.toHaveBeenCalled();
    });

    // Owner's recording, 2026-11-16: the row came in when the browser's check of the session
    // cookie ended, a client navigation included, and pushed Comments down.
    describe('while a session cookie is checked', () => {
      const AUTH_COOKIE = 'sb-project-ref-auth-token';
      /** A session cookie as @supabase/ssr writes it, naming its account. */
      function holdSessionCookieOf(userId: string) {
        const session = Buffer.from(JSON.stringify({ access_token: 'cookie-token', user: { id: userId } }))
          .toString('base64url');
        document.cookie = `${AUTH_COOKIE}=base64-${session}; Path=/`;
      }

      beforeEach(() => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project-ref.supabase.co');
        clientAuth.current = { session: null, user: null, isLoading: true };
      });

      afterEach(() => {
        vi.useRealTimers();
        document.cookie = `${AUTH_COOKIE}=; Max-Age=0; Path=/`;
        vi.unstubAllEnvs();
      });

      it('draws both in their place from the first paint, inert until the check names the viewer', async () => {
        holdSessionCookieOf('user-2');
        const { rerender } = render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

        const rail = screen.getByTestId('canonical-post-actions');
        expect(within(rail).getByRole('button', { name: 'Report user' })).toBeDisabled();
        expect(within(rail).getByRole('button', { name: 'Block user' })).toBeDisabled();

        signInAs('user-2');
        rerender(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
        expect(within(rail).getByRole('button', { name: 'Report user' })).toBeEnabled();
        expect(within(rail).getByRole('button', { name: 'Block user' })).toBeEnabled();
      });

      // Review of #833: a stalled check left the row drawn and doing nothing for as long as it stalled.
      it('draws none once the check outlasts its deadline, as for a visitor, and both once a late answer names the viewer', async () => {
        holdSessionCookieOf('user-2');
        const page = await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        clientAuth.current = { ...clientAuth.current, sessionCheckStartedAt: performance.now() };
        const { rerender } = render(page);
        const rail = screen.getByTestId('canonical-post-actions');
        act(() => {
          vi.advanceTimersByTime(SESSION_CHECK_DEADLINE_MS - 100);
        });
        expect(within(rail).getByRole('button', { name: 'Report user' })).toBeDisabled();

        act(() => {
          vi.advanceTimersByTime(100);
        });
        expect(within(rail).queryByRole('button', { name: 'Report user' })).not.toBeInTheDocument();
        expect(within(rail).queryByRole('button', { name: 'Block user' })).not.toBeInTheDocument();

        vi.useRealTimers();
        signInAs('user-2');
        rerender(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
        expect(within(rail).getByRole('button', { name: 'Report user' })).toBeEnabled();
        expect(within(rail).getByRole('button', { name: 'Block user' })).toBeEnabled();
      });

      it("leaves them out while a cookie naming the post's creator is checked, and once a check finds no session", async () => {
        holdSessionCookieOf('user-1');
        const { unmount } = render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
        expect(screen.queryByRole('button', { name: 'Report user' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Block user' })).not.toBeInTheDocument();
        unmount();

        holdSessionCookieOf('user-2');
        clientAuth.current = { session: null, user: null, isLoading: false };
        render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
        expect(screen.queryByRole('button', { name: 'Report user' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Block user' })).not.toBeInTheDocument();
      });
    });

    // The page is drawn ahead of time for every viewer, and no cookie can be read on the server.
    it("draws both in the server's HTML, inert, for the root element's marks to show to a browser with a session", () => {
      const container = document.createElement('div');
      container.innerHTML = renderToString(
        <ReportPostButton postId={POST_ID} creator={{ id: 'user-1', name: 'Creator Name' }} />,
      );
      document.body.appendChild(container);
      onTestFinished(() => container.remove());

      const reportUser = within(container).getByRole('button', { name: 'Report user' });
      expect(reportUser).toBeDisabled();
      expect(reportUser.closest('.app-shell-when-signed-in')).not.toBeNull();
      expect(within(container).getByRole('button', { name: 'Block user' })).toBeDisabled();
    });

    // Review of #833: the server's row showed on the creator's own post until the page's script
    // ran, then went, and Comments jumped up. The root element names the account the session
    // cookie holds before the first paint (app-shell-account-restore.ts).
    it("hides them from the post's creator before the first paint, and hydrates as drawn", () => {
      const root = document.documentElement;
      onTestFinished(() => root.removeAttribute('data-auth-user'));
      const button = <ReportPostButton postId={POST_ID} creator={{ id: 'user-1', name: 'Creator Name' }} />;
      const container = document.createElement('div');
      container.innerHTML = renderToString(button);
      document.body.appendChild(container);
      onTestFinished(() => container.remove());
      const row = container.querySelector('[data-post-creator-rows]') as HTMLElement;

      expect(container.querySelector('style')?.textContent)
        .toBe('html[data-auth-user="user-1"] [data-post-creator-rows="user-1"]{display:none}');
      root.setAttribute('data-auth-user', 'user-2');
      expect(window.getComputedStyle(row).display).not.toBe('none');
      root.setAttribute('data-auth-user', 'user-1');
      expect(window.getComputedStyle(row).display).toBe('none');

      const consoleError = vi.spyOn(console, 'error');
      render(button, { container, hydrate: true });
      expect(consoleError).not.toHaveBeenCalled();
    });

    it("draws none in the server's HTML for a creator whose id a style rule cannot name as it stands", () => {
      const html = renderToString(
        <ReportPostButton postId={POST_ID} creator={{ id: 'user"] *{display:none} [x="', name: 'Creator Name' }} />,
      );
      expect(html).not.toContain('Report user');
      expect(html).not.toContain('<style');
    });
  });

  // Sweep of 2026-11-17 (build 941e2a55b): on their own post, opened by a client navigation, the
  // creator saw "Report post or recipe" where their tools go for about 16 frames, until the session
  // check named them; on a load, until the page's script had run and the check had ended.
  describe("the creator's own rail", () => {
    const AUTH_COOKIE = 'sb-project-ref-auth-token';
    const openPost = () => ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) });
    const reportRow = () => screen.queryByRole('button', { name: 'Report post or recipe' });
    const ownerTools = () => screen.getByTestId('showcase-detail-actions').getAttribute('data-owner-tools-state');
    /** A session cookie as @supabase/ssr writes it, naming its account. */
    function holdSessionCookieOf(userId: string) {
      const session = Buffer.from(JSON.stringify({ access_token: 'cookie-token', user: { id: userId } }))
        .toString('base64url');
      document.cookie = `${AUTH_COOKIE}=base64-${session}; Path=/`;
    }

    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project-ref.supabase.co');
      clientAuth.current = { session: null, user: null, isLoading: true };
    });

    afterEach(() => {
      vi.useRealTimers();
      document.cookie = `${AUTH_COOKIE}=; Max-Age=0; Path=/`;
      vi.unstubAllEnvs();
    });

    it('draws the creator their tools, inert, and no report row while a cookie naming them is checked', async () => {
      holdSessionCookieOf('user-1');
      const { rerender } = render(await openPost());
      expect(ownerTools()).toBe('checking');
      expect(reportRow()).not.toBeInTheDocument();

      signInAs('user-1');
      rerender(await openPost());
      expect(ownerTools()).toBe('ready');
      expect(reportRow()).not.toBeInTheDocument();
    });

    it('keeps the report row, and no Owner tools, for anyone else while their cookie is checked', async () => {
      holdSessionCookieOf('user-2');
      const { rerender } = render(await openPost());
      expect(ownerTools()).toBe('none');
      expect(reportRow()).toBeInTheDocument();

      signInAs('user-2');
      rerender(await openPost());
      expect(ownerTools()).toBe('none');
      expect(reportRow()).toBeInTheDocument();
    });

    // CI run of 2026-11-17 (PR #853): the dev server served supabase-js 8.2 s after the page's script
    // ran, past the start deadline, and the creator's rail was a visitor's, the report row in their
    // tools' place, until the late answer named them. The deadline is the reader's (the thread and the
    // composer's place fall back on it); the creator's own parts wait for the check's answer.
    it.each([
      { check: 'a check that outlasts its deadline', startedAt: () => performance.now(), deadline: SESSION_CHECK_DEADLINE_MS },
      { check: 'a check that has not begun by its start deadline', startedAt: () => null, deadline: SESSION_CHECK_START_DEADLINE_MS },
    ])("keeps the creator's tools, inert, and no report row through $check, and readies them once a late answer names them", async ({ startedAt, deadline }) => {
      holdSessionCookieOf('user-1');
      const page = await openPost();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      clientAuth.current = { ...clientAuth.current, sessionCheckStartedAt: startedAt() };
      // What the reader's own parts are told (PostComments is a stand-in here).
      function ReaderCheck() {
        return <span data-testid="reader-check">{useViewerSessionCheck()}</span>;
      }
      const { rerender } = render(<>{page}<ReaderCheck /></>);
      expect(ownerTools()).toBe('checking');

      act(() => {
        vi.advanceTimersByTime(deadline);
      });
      // The deadline has passed for the reader's parts...
      expect(screen.getByTestId('reader-check')).toHaveTextContent('visitor');
      // ...and the creator's own wait on.
      expect(ownerTools()).toBe('checking');
      expect(reportRow()).not.toBeInTheDocument();

      vi.useRealTimers();
      signInAs('user-1');
      rerender(<>{await openPost()}<ReaderCheck /></>);
      expect(ownerTools()).toBe('ready');
      expect(reportRow()).not.toBeInTheDocument();
    });

    it("draws a visitor's rail once the check ends with no one behind a cookie naming the creator", async () => {
      holdSessionCookieOf('user-1');
      const { rerender } = render(await openPost());
      expect(ownerTools()).toBe('checking');

      // A refused or lapsed session: the provider's check ends with no one.
      clientAuth.current = { session: null, user: null, isLoading: false };
      rerender(await openPost());
      expect(ownerTools()).toBe('none');
      expect(reportRow()).toBeInTheDocument();
    });

    // The page is drawn ahead of time for every viewer, and no cookie can be read on the server.
    it("draws both in the server's HTML: the root element's mark shows the creator their tools and anyone else the row, before the first paint", async () => {
      const root = document.documentElement;
      onTestFinished(() => root.removeAttribute('data-auth-user'));
      const page = await openPost();
      const container = document.createElement('div');
      container.innerHTML = renderToString(page);
      document.body.appendChild(container);
      onTestFinished(() => container.remove());

      expect(within(container).getByTestId('showcase-detail-actions')).toHaveAttribute('data-owner-tools-state', 'unread');
      const reportRows = container.querySelector('[data-post-report-rows="user-1"]') as HTMLElement;
      expect(within(reportRows).getByRole('button', { name: 'Report post or recipe' })).toBeInTheDocument();
      // Owner tools as ShowcaseDetailActions marks them in that HTML (showcase-detail-actions.test.tsx).
      const tools = document.createElement('details');
      tools.setAttribute('data-post-owner-tools', 'user-1');
      reportRows.before(tools);
      const shown = (element: HTMLElement) => window.getComputedStyle(element).display !== 'none';

      // A visitor, and another account.
      expect([shown(tools), shown(reportRows)]).toEqual([false, true]);
      root.setAttribute('data-auth-user', 'user-2');
      expect([shown(tools), shown(reportRows)]).toEqual([false, true]);
      // The creator.
      root.setAttribute('data-auth-user', 'user-1');
      expect([shown(tools), shown(reportRows)]).toEqual([true, false]);

      tools.remove();
      const consoleError = vi.spyOn(console, 'error');
      render(page, { container, hydrate: true });
      expect(consoleError).not.toHaveBeenCalled();
    });

    // Sweep of 2026-11-17: on their own post the creator was offered their own recipe, "Free recipe ·
    // View" in the rail and "View free recipe" along the bottom edge, until their own read landed.
    describe('their recipe', () => {
      const freeRecipe = {
        id: 'bundle-1',
        postId: POST_ID,
        accessMode: 'free',
        priceQuote: { formatted: 'Free', note: null },
        resourceKinds: ['prompt'],
        lockedPreview: null,
        viewerCanAccess: false,
        viewerIsOwner: false,
        viewerHasPurchased: false,
        salesCount: 0,
        freeUnlockCount: 2,
        resources: null,
        purchasedRevision: null,
        title: 'Recipe',
        summary: '',
        previewText: '',
        priceUsdCents: 0,
        allowRemix: false,
        status: 'published',
        seller: { id: 'user-1' },
      };
      const recipeLink = () => screen.getByTestId('recipe-jump-link');
      const recipeBar = () => screen.queryByText('View free recipe');
      /** The page's room for the bar along the bottom edge. */
      const barRoom = () => document.querySelector('.canonical-post-cta-room');

      beforeEach(async () => {
        const detail = await getPublicPostDetailMock(POST_ID);
        getPublicPostDetailMock.mockResolvedValue({ ...detail, resourceBundle: freeRecipe });
      });

      it("reads as theirs, with no bar offering it, while a cookie naming them is checked and before their read lands", async () => {
        // Their own read of the recipe is never answered here: the page's words do not wait for it.
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
        holdSessionCookieOf('user-1');
        const { rerender } = render(await openPost());
        expect(recipeLink()).toHaveTextContent(/^Your recipeView$/);
        expect(recipeBar()).not.toBeInTheDocument();
        expect(barRoom()).toBeNull();

        signInAs('user-1');
        rerender(await openPost());
        expect(recipeLink()).toHaveTextContent(/^Your recipeView$/);
        expect(recipeBar()).not.toBeInTheDocument();
      });

      it('is offered to anyone else while their cookie is checked, with its bar', async () => {
        holdSessionCookieOf('user-2');
        render(await openPost());
        expect(recipeLink()).toHaveTextContent(/^Free recipeView$/);
        expect(recipeBar()).toBeInTheDocument();
        expect(barRoom()).not.toBeNull();
      });

      it("reads as theirs once their read lands, and as a buyer's once a buyer's does", async () => {
        stubPageFetch({}, { viewerBundle: { ...freeRecipe, viewerIsOwner: true, viewerCanAccess: true } });
        signInAs('user-1');
        const { unmount } = render(await openPost());
        await waitFor(() => expect(requestsTo(RECIPE_READ)).toHaveLength(1));
        expect(recipeLink()).toHaveTextContent(/^Your recipeView$/);
        expect(recipeBar()).not.toBeInTheDocument();
        unmount();

        stubPageFetch({}, { viewerBundle: { ...freeRecipe, viewerCanAccess: true, viewerHasPurchased: true } });
        signInAs('user-2');
        render(await openPost());
        // A buyer's "Unlocked" is their read's alone: the page offers the recipe until it lands.
        expect(recipeLink()).toHaveTextContent(/^Free recipeView$/);
        await waitFor(() => expect(recipeLink()).toHaveTextContent(/^UnlockedView$/));
        expect(recipeBar()).not.toBeInTheDocument();
      });

      // Sweep of 2026-11-17 (build 988d55079): the recipe panel under the post read "Free recipe" and
      // offered "Get free recipe" to its creator until their own read landed, 0.4 to 1.6 s.
      describe('in the panel under the post', () => {
        const panelProps = () => postResourceBundlePanelPropsMock.mock.lastCall?.[0] as {
          viewerIsOwner: boolean;
          creatorHold?: 'opening' | 'failed' | null;
          creatorMark?: string;
          onRetryCreatorRead?: () => void;
        };
        /** The creator's own read of their recipe: all of it, theirs. */
        const ownRead = {
          ...freeRecipe,
          viewerIsOwner: true,
          viewerCanAccess: true,
          resources: { promptText: 'Prompt', notesMarkdown: null, workflowShareUrl: null, workflowSnapshot: null, attachments: [], allowRemix: false },
        };

        it("is held as theirs while a cookie naming them is checked and while their read is out", async () => {
          // Their own read of the recipe is never answered here.
          vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
          holdSessionCookieOf('user-1');
          const { rerender } = render(await openPost());
          expect(panelProps()).toMatchObject({ viewerIsOwner: false, creatorHold: 'opening', creatorMark: undefined });

          signInAs('user-1');
          rerender(await openPost());
          await waitFor(() => expect(requestsTo(RECIPE_READ)).toHaveLength(1));
          expect(panelProps()).toMatchObject({ viewerIsOwner: false, creatorHold: 'opening', creatorMark: undefined });
        });

        it('says their read failed, asks it again when they say so, and opens the recipe from the read that lands', async () => {
          vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
            if (String(input) !== RECIPE_READ) return reply({ success: true });
            return requestsTo(RECIPE_READ).length === 1
              ? reply({ error: 'Down' }, 503)
              : reply({ success: true, bundle: ownRead });
          }));
          signInAs('user-1');
          render(await openPost());
          await waitFor(() => expect(panelProps()).toMatchObject({ viewerIsOwner: false, creatorHold: 'failed' }));

          // Try again: the read it sends goes out with the render it asks for, and is answered.
          await act(async () => {
            panelProps().onRetryCreatorRead?.();
          });
          await act(async () => {
            await vi.waitFor(() => expect(requestsTo(RECIPE_READ)).toHaveLength(2));
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
          expect(panelProps()).toMatchObject({ viewerIsOwner: true, creatorHold: null });
          expect(recipeLink()).toHaveTextContent(/^Your recipeView$/);
        });

        // Review of #866: their read goes out only once the check names them, so a check that never
        // ends (supabase-js failing to load after a deploy, `getUser` hanging) held the recipe at
        // "Opening your recipe…" for good, with nothing to press.
        it("says it could not be opened once the check of their cookie outlasts its deadline, and Try again asks the check again", async () => {
          vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
          holdSessionCookieOf('user-1');
          // The check asked again hangs too.
          const refreshSessionState = vi.fn(() => new Promise<void>(() => {}));
          const page = await openPost();
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          clientAuth.current = { ...clientAuth.current, sessionCheckStartedAt: performance.now(), refreshSessionState };
          render(page);
          expect(panelProps()).toMatchObject({ viewerIsOwner: false, creatorHold: 'opening' });

          act(() => {
            vi.advanceTimersByTime(SESSION_CHECK_DEADLINE_MS);
          });
          expect(panelProps()).toMatchObject({ creatorHold: 'failed' });
          // Their Owner tools and Remix still wait for the check's answer, as before.
          expect(ownerTools()).toBe('checking');
          expect(screen.getByTestId('showcase-detail-engagement-row')).toHaveAttribute('data-remix-held', 'true');
          // No read went out: the check has not named them.
          expect(requestsTo(RECIPE_READ)).toHaveLength(0);

          // Try again asks the check again, and the recipe is opening while it runs...
          act(() => panelProps().onRetryCreatorRead?.());
          expect(refreshSessionState).toHaveBeenCalledTimes(1);
          expect(panelProps()).toMatchObject({ creatorHold: 'opening' });
          // ...for at most another deadline.
          act(() => {
            vi.advanceTimersByTime(SESSION_CHECK_DEADLINE_MS);
          });
          expect(panelProps()).toMatchObject({ creatorHold: 'failed' });
          expect(requestsTo(RECIPE_READ)).toHaveLength(0);
        });

        it('asks the check again, not the read, and opens the recipe once the check asked again names them', async () => {
          holdSessionCookieOf('user-1');
          let named = () => {};
          const refreshSessionState = vi.fn(() => new Promise<void>((resolve) => {
            named = resolve;
          }));
          stubPageFetch({}, { viewerBundle: ownRead });
          const page = await openPost();
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          clientAuth.current = { ...clientAuth.current, sessionCheckStartedAt: performance.now(), refreshSessionState };
          const { rerender } = render(page);
          act(() => {
            vi.advanceTimersByTime(SESSION_CHECK_DEADLINE_MS);
          });
          expect(panelProps()).toMatchObject({ creatorHold: 'failed' });

          act(() => panelProps().onRetryCreatorRead?.());
          expect(refreshSessionState).toHaveBeenCalledTimes(1);
          vi.useRealTimers();
          // The provider's check names them.
          signInAs('user-1');
          await act(async () => {
            named();
            rerender(await openPost());
          });
          await waitFor(() => expect(panelProps()).toMatchObject({ viewerIsOwner: true, creatorHold: null }));
          expect(requestsTo(RECIPE_READ)).toHaveLength(1);
        });

        it("is held through a read whose answer names no recipe and no none, which the page keeps its own over", async () => {
          vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }) as Response));
          signInAs('user-1');
          render(await openPost());
          await waitFor(() => expect(panelProps()).toMatchObject({ creatorHold: 'failed' }));
        });

        it('offers the recipe to anyone else as before, while their cookie is checked and once named', async () => {
          vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
          holdSessionCookieOf('user-2');
          const { rerender } = render(await openPost());
          expect(panelProps()).toMatchObject({ viewerIsOwner: false, creatorHold: null, creatorMark: undefined });

          signInAs('user-2');
          rerender(await openPost());
          expect(panelProps()).toMatchObject({ viewerIsOwner: false, creatorHold: null, creatorMark: undefined });
        });

        it("is drawn both ways in the server's HTML, for the page's rule, and held for no one there", async () => {
          renderToString(await openPost());
          expect(panelProps()).toMatchObject({ viewerIsOwner: false, creatorHold: null, creatorMark: 'user-1' });
        });
      });

      // Review of #847: a creation post whose Remix the recipe brings offered its creator their own
      // creation's Remix to claim ("Remix · Free") until their own read of the recipe landed.
      it("opens the creator's own Remix from the first frame they are known, and hands the server's HTML both", async () => {
        const detail = await getPublicPostDetailMock(POST_ID);
        getPublicPostDetailMock.mockResolvedValue({
          ...detail,
          canRemix: false,
          remixCapability: 'unlock_required',
          remixTarget: 'image',
          resourceBundle: { ...freeRecipe, allowRemix: true },
        });
        const row = () => screen.getByTestId('showcase-detail-engagement-row');
        // Their own read of the recipe is never answered here.
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

        holdSessionCookieOf('user-1');
        const { rerender, unmount } = render(await openPost());
        expect(row()).toHaveTextContent(`${POST_ID}:true`);
        expect(row()).toHaveAttribute('data-recipe-remix', '');
        // Inert until the check names them, as their Owner tools are.
        expect(row()).toHaveAttribute('data-remix-held', 'true');
        signInAs('user-1');
        rerender(await openPost());
        expect(row()).toHaveTextContent(`${POST_ID}:true`);
        expect(row()).toHaveAttribute('data-recipe-remix', '');
        expect(row()).toHaveAttribute('data-remix-held', 'false');
        unmount();

        // Anyone else is offered it with the free recipe.
        holdSessionCookieOf('user-2');
        clientAuth.current = { session: null, user: null, isLoading: true };
        const other = render(await openPost());
        expect(row()).toHaveTextContent(`${POST_ID}:false`);
        expect(row()).toHaveAttribute('data-recipe-remix', 'free:Free');
        expect(row()).toHaveAttribute('data-creator-remix', '');
        expect(row()).toHaveAttribute('data-remix-held', 'false');
        other.unmount();

        // The server's HTML: everyone else's, with the creator's own open Remix for the page's rule.
        const html = renderToString(await openPost());
        expect(html).toContain('data-recipe-remix="free:Free"');
        expect(html).toContain('data-creator-remix="user-1:open"');
      });

      // CI run of 2026-11-17 (PR #853): past the session check's deadline the creator's Remix read
      // "Remix · Free" and the rail "Free recipe", until the late answer named them.
      it("keeps the creator's Remix open and held, and their recipe theirs with no bar, past the check's deadline", async () => {
        const detail = await getPublicPostDetailMock(POST_ID);
        getPublicPostDetailMock.mockResolvedValue({
          ...detail,
          canRemix: false,
          remixCapability: 'unlock_required',
          remixTarget: 'image',
          resourceBundle: { ...freeRecipe, allowRemix: true },
        });
        const row = () => screen.getByTestId('showcase-detail-engagement-row');
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
        holdSessionCookieOf('user-1');
        const page = await openPost();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        clientAuth.current = { ...clientAuth.current, sessionCheckStartedAt: performance.now() };
        render(page);

        act(() => {
          vi.advanceTimersByTime(SESSION_CHECK_DEADLINE_MS);
        });
        expect(row()).toHaveTextContent(`${POST_ID}:true`);
        expect(row()).toHaveAttribute('data-recipe-remix', '');
        expect(row()).toHaveAttribute('data-remix-held', 'true');
        expect(recipeLink()).toHaveTextContent(/^Your recipeView$/);
        expect(recipeBar()).not.toBeInTheDocument();
        expect(barRoom()).toBeNull();
      });

      // Review of #847's third round: the Remix of a post with no creation (a picture made elsewhere)
      // is a dead end, "Only generation-backed posts can be remixed", so its creator gets none. Owner,
      // 2026-11-17 ("Yes, hide it"): nor does anyone else, and its recipe names none, whatever the
      // page's read says (here one from before, which still offered a Remix behind the free recipe).
      it("gives nobody a Remix on a post with no creation, its creator included, and its recipe names none", async () => {
        const detail = await getPublicPostDetailMock(POST_ID);
        getPublicPostDetailMock.mockResolvedValue({
          ...detail,
          generationId: null,
          canRemix: false,
          remixCapability: 'unlock_required',
          remixTarget: 'image',
          resourceBundle: { ...freeRecipe, allowRemix: true },
        });
        const row = () => screen.getByTestId('showcase-detail-engagement-row');
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

        holdSessionCookieOf('user-1');
        const { rerender, unmount } = render(await openPost());
        expect(row()).toHaveTextContent(`${POST_ID}:false`);
        expect(row()).toHaveAttribute('data-recipe-remix', '');
        signInAs('user-1');
        rerender(await openPost());
        expect(row()).toHaveTextContent(`${POST_ID}:false`);
        expect(row()).toHaveAttribute('data-recipe-remix', '');
        expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ remixIncluded: false }));
        unmount();

        // Anyone else is offered none either, and the server's HTML hands the row the creator's none.
        holdSessionCookieOf('user-2');
        clientAuth.current = { session: null, user: null, isLoading: true };
        const other = render(await openPost());
        expect(row()).toHaveTextContent(`${POST_ID}:false`);
        expect(row()).toHaveAttribute('data-recipe-remix', '');
        expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ remixIncluded: false }));
        other.unmount();
        const html = renderToString(await openPost());
        expect(html).toContain('data-recipe-remix=""');
        expect(html).toContain('data-creator-remix="user-1:none"');

        // Nor someone who has the recipe, whose own read says they may open it.
        stubPageFetch({}, { viewerBundle: { ...freeRecipe, allowRemix: true, viewerCanAccess: true, viewerHasPurchased: true } });
        signInAs('user-2');
        render(await openPost());
        await waitFor(() => expect(requestsTo(RECIPE_READ)).toHaveLength(1));
        await waitFor(() => expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ viewerCanAccess: true })));
        expect(row()).toHaveTextContent(`${POST_ID}:false`);
        expect(row()).toHaveAttribute('data-recipe-remix', '');
        expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ remixIncluded: false }));
      });

      // The page is drawn ahead of time for every viewer, and no cookie can be read on the server.
      it("draws both in the server's HTML: the root element's mark shows the creator theirs and anyone else the pitch, before the first paint", async () => {
        const root = document.documentElement;
        onTestFinished(() => root.removeAttribute('data-auth-user'));
        const page = await openPost();
        const container = document.createElement('div');
        container.innerHTML = renderToString(page);
        document.body.appendChild(container);
        onTestFinished(() => container.remove());
        const link = within(container).getByTestId('recipe-jump-link');
        const bar = within(container).getByText('View free recipe').closest('a') as HTMLElement;
        const room = container.querySelector('.canonical-post-cta-room') as HTMLElement;
        // What is shown of each: the words the pointer reads, and whether the bar and its room are drawn.
        const reads = () => Array.from(link.querySelectorAll('span'))
          .filter((span) => span.children.length === 0 && window.getComputedStyle(span).display !== 'none')
          .map((span) => span.textContent)
          .join(' · ');
        const pitched = () => [bar, room].map((element) => window.getComputedStyle(element).display !== 'none');

        // A visitor, and another account.
        expect([reads(), pitched()]).toEqual(['Free recipe · View', [true, true]]);
        root.setAttribute('data-auth-user', 'user-2');
        expect([reads(), pitched()]).toEqual(['Free recipe · View', [true, true]]);
        // The creator.
        root.setAttribute('data-auth-user', 'user-1');
        expect([reads(), pitched()]).toEqual(['Your recipe · View', [false, false]]);

        const consoleError = vi.spyOn(console, 'error');
        render(page, { container, hydrate: true });
        expect(consoleError).not.toHaveBeenCalled();
      });
    });

    it("draws the report row and no Owner tools in the server's HTML for a creator a style rule cannot name", async () => {
      const detail = await getPublicPostDetailMock(POST_ID);
      getPublicPostDetailMock.mockResolvedValueOnce({
        ...detail,
        creator: { id: 'user"] *{display:none} [x="', username: 'creator-name', name: 'Creator Name', avatar: null },
      });
      const html = renderToString(await openPost());

      expect(html).toContain('Report post or recipe');
      expect(html).toContain('data-owner-tools-state="none"');
      expect(html).not.toContain('data-post-report-rows=');
      expect(html).not.toContain('<style');
    });
  });

  // The gate takes the place of the content, not of the page: the posts most
  // likely to be reported had no Report, Block or byline on screen.
  describe('an NSFW post the server has not revealed', () => {
    async function serveCoveredPost() {
      const detail = await getPublicPostDetailMock(POST_ID) as Record<string, unknown>;
      getPublicPostDetailMock.mockResolvedValueOnce(coverNsfwContent(detail));
      return detail;
    }

    it('keeps the byline, the rail and the engagement row, and hides the content and the thread', async () => {
      signInAs('user-2');
      await serveCoveredPost();
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      const head = screen.getByTestId('canonical-post-head');
      expect(head).toHaveTextContent('@creator-name');
      // The cover's type and title are placeholders; the gate holds the one heading.
      expect(within(head).queryByText('Text')).not.toBeInTheDocument();
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
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

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
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

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

    // D4 (2026-10-27): a recipe on an NSFW post showed nowhere, even revealed (B-F11).
    it('shows the recipe the reveal carries, between the post and its thread', async () => {
      signInAs('user-2');
      const detail = await serveCoveredPost();
      stubPageFetch({
        ...detail,
        isNsfw: true,
        nsfwRevealed: true,
        mediaItems: [],
        canRemix: false,
        remixCapability: 'unlock_required',
        remixTarget: 'image',
        resourceBundle: {
          id: 'bundle-1',
          postId: POST_ID,
          accessMode: 'paid',
          priceQuote: { formatted: '$9.00', note: null },
          resourceKinds: ['prompt'],
          lockedPreview: null,
          viewerCanAccess: false,
          viewerIsOwner: false,
          salesCount: 2,
          freeUnlockCount: 0,
          resources: null,
          title: 'Mature recipe',
          summary: 'The setup.',
          previewText: '',
          priceUsdCents: 900,
          allowRemix: true,
          status: 'published',
          purchasedRevision: null,
        },
      });
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
      expect(screen.queryByTestId('post-resource-bundle-panel')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('checkbox', { name: /18 or older/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Reveal post' }));

      const media = screen.getByTestId('canonical-post-media');
      const panel = await within(media).findByTestId('post-resource-bundle-panel');
      expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({
        postId: POST_ID,
        title: 'Mature recipe',
        priceUsdCents: 900,
        remixIncluded: true,
      }));
      expect(
        panel.compareDocumentPosition(within(media).getByTestId('post-comments-component')) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();

      fireEvent.click(within(media).getByRole('button', { name: 'Hide this post' }));
      expect(within(media).queryByTestId('post-resource-bundle-panel')).not.toBeInTheDocument();
    });
  });

  it('does not mount public-only comments on an unlisted detail page', async () => {
    const detail = await getPublicPostDetailMock(POST_ID);
    getPublicPostDetailMock.mockResolvedValueOnce({
      ...detail,
      visibility: 'unlisted',
    });

    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: POST_ID }),
    }));

    expect(screen.queryByTestId('canonical-post-comments')).not.toBeInTheDocument();
    expect(screen.queryByTestId('post-comments-component')).not.toBeInTheDocument();
  });

  it('keeps media posts in the media frame and preserves public notes', async () => {
    getPublicPostDetailMock.mockResolvedValueOnce({
      id: POST_ID,
      generationId: GENERATION_ID,
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
      params: Promise.resolve({ id: POST_ID }),
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
      params: Promise.resolve({ id: POST_ID }),
    }));

    const head = screen.getByTestId('canonical-post-head');
    const media = screen.getByTestId('canonical-post-media');
    const actions = screen.getByTestId('canonical-post-actions');
    const heading = screen.getByRole('heading', { level: 1, name: 'Shared creation' });
    const frame = screen.getByTestId('media-detail-frame');
    const engagement = screen.getByTestId('showcase-detail-engagement-row');
    const mediaViewport = container.querySelector('[data-showcase-media-viewport]');

    // No identity side card. The masthead is its own grid row, above the
    // post; the rail runs beside both.
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
    openedFromInsideTheSite(`?from=unlocks&returnTo=${encodeURIComponent('/marketplace?access=paid&resource=workflow')}`);
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(screen.getByRole('link', { name: /back to marketplace/i })).toHaveAttribute(
      'href',
      '/marketplace?access=paid&resource=workflow'
    );
  });

  it('gives a shared video link the post\'s own poster frame', async () => {
    // Video and motion posts used to fall through to the site-wide OG image, so
    // the flagship output produced the least appealing card in every chat app.
    const detail = await getPublicPostDetailMock(POST_ID);
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

    const metadata = await generateMetadata({ params: Promise.resolve({ id: POST_ID }) });
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
    // One read serves the metadata and the page (it is cached with the page),
    // and it is a visitor's: no viewer, no country.
    expect(getPublicPostDetailOptionsMock).toHaveBeenCalledWith(POST_ID, undefined);
  });

  it('falls back to the site card while a poster is still rendering', async () => {
    // Posters are generated asynchronously, so a freshly published video has a
    // storage path before it has an image. Serving it would be a broken card.
    const detail = await getPublicPostDetailMock(POST_ID);
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

    const metadata = await generateMetadata({ params: Promise.resolve({ id: POST_ID }) });
    const images = Array.isArray(metadata.openGraph?.images)
      ? metadata.openGraph?.images
      : [metadata.openGraph?.images];

    expect(images[0]).toMatchObject({ url: '/opengraph-image.png', width: 1200, height: 630 });
  });

  it('falls back to the site card for legacy posts that carry no media items', async () => {
    const detail = await getPublicPostDetailMock(POST_ID);
    getPublicPostDetailMock.mockResolvedValue({
      ...detail,
      mediaKind: 'video',
      mediaUrl: 'https://cdn.example.com/showcase/gen-1.mp4',
    });

    const metadata = await generateMetadata({ params: Promise.resolve({ id: POST_ID }) });
    const images = Array.isArray(metadata.openGraph?.images)
      ? metadata.openGraph?.images
      : [metadata.openGraph?.images];

    expect(images[0]).toMatchObject({ url: '/opengraph-image.png' });
  });

  // A legacy image kept only in its creator's folder has no address but a
  // signed one, which runs out within hours: crawlers keep a share image and
  // search engines a content URL long after that.
  it('never shares a signed link: a legacy image with no other address gets the site card', async () => {
    const signedUrl = 'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/output.png?token=abc.def.ghi';
    const detail = await getPublicPostDetailMock(POST_ID) as Record<string, unknown>;
    getPublicPostDetailMock.mockResolvedValue({
      ...detail,
      mediaKind: 'image',
      mediaUrl: signedUrl,
      mediaItems: [{
        id: `${POST_ID}:cover`,
        url: signedUrl,
        mediaKind: 'image',
        previewUrl: null,
        previewStatus: 'pending',
        width: null,
        height: null,
        sortOrder: 0,
      }],
    });

    const metadata = await generateMetadata({ params: Promise.resolve({ id: POST_ID }) });
    const images = Array.isArray(metadata.openGraph?.images)
      ? metadata.openGraph?.images
      : [metadata.openGraph?.images];
    expect(images[0]).toMatchObject({ url: '/opengraph-image.png' });
    expect(JSON.stringify(metadata)).not.toContain('/object/sign/');

    const { container } = render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
    const structuredData = container.querySelector('script[type="application/ld+json"]')?.textContent ?? '';
    expect(structuredData).toContain(`/showcase/${POST_ID}`);
    expect(structuredData).not.toContain('/object/sign/');
  });

  it('generates canonical metadata for the public detail page', async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ id: POST_ID }),
    });

    const images = Array.isArray(metadata.openGraph?.images)
      ? metadata.openGraph?.images
      : metadata.openGraph?.images
        ? [metadata.openGraph.images]
        : [];

    expect(metadata.alternates?.canonical).toBe(`/showcase/${POST_ID}`);
    expect(images[0]).toMatchObject({
      url: 'https://cdn.example.com/showcase/gen-1.jpg',
    });
  });

  it('opens a post with one read of its row and no legacy reference lookup', async () => {
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: POST_ID }),
    }));

    expect(screen.getByRole('heading', { level: 1, name: 'Shared creation' })).toBeInTheDocument();
    expect(getPublicPostDetailMock).toHaveBeenCalledTimes(1);
    expect(getPublicPostDetailMock).toHaveBeenCalledWith(POST_ID);
    expect(getPostReferenceForShowcaseIdMock).not.toHaveBeenCalled();
  });

  it('redirects legacy generation ids to their post ids', async () => {
    // No post has the generation's id, so the post read misses first.
    getPublicPostDetailMock.mockResolvedValueOnce(null);
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce({
      id: POST_ID,
      generation_id: GENERATION_ID,
      visibility: 'public',
      category: 'image',
      prompt: 'Prompt',
      source_kind: 'magicbooklet',
    });

    await expect(ShowcaseDetailPage({
      params: Promise.resolve({ id: GENERATION_ID }),
    })).rejects.toThrow(`NEXT_REDIRECT:/showcase/${POST_ID}`);
    expect(getPublicPostDetailMock).toHaveBeenCalledWith(GENERATION_ID);
    expect(getPostReferenceForShowcaseIdMock).toHaveBeenCalledWith(GENERATION_ID);
  });

  it('returns notFound for private or missing posts', async () => {
    getPublicPostDetailMock.mockResolvedValueOnce(null);
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce(null);

    await expect(ShowcaseDetailPage({
      params: Promise.resolve({ id: MISSING_POST_ID }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  // Every address is its own cached page: one made up by a crawler, or an old
  // slug, must cost no read and leave no entry, and the database must never be
  // handed text where it expects a UUID.
  it.each(['missing', 'not-a-uuid', `${POST_ID}x`, `${POST_ID.slice(0, -1)}`, '../marketplace'])(
    'answers not found for %j, which is no post id, before reading anything',
    async (id) => {
      await expect(ShowcaseDetailPage({ params: Promise.resolve({ id }) })).rejects.toThrow('NEXT_NOT_FOUND');
      await expect(generateMetadata({ params: Promise.resolve({ id }) })).resolves.toEqual({
        title: 'Creation Not Found',
      });
      expect(getPublicPostDetailMock).not.toHaveBeenCalled();
      expect(getPostReferenceForShowcaseIdMock).not.toHaveBeenCalled();
    },
  );

  it('reads an id in capitals as the post it names', async () => {
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID.toUpperCase() }) }));

    expect(getPublicPostDetailMock).toHaveBeenCalledWith(POST_ID.toUpperCase());
    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
  });

  it('answers not-found, not a redirect to itself, for a post whose row exists but cannot be shown', async () => {
    // A media post with no readable media is one: the reference still finds
    // its row under the same id.
    getPublicPostDetailMock.mockResolvedValueOnce(null);
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce({
      id: POST_ID,
      generation_id: GENERATION_ID,
      visibility: 'public',
      category: 'image',
      prompt: 'Prompt',
      source_kind: 'magicbooklet',
    });

    await expect(ShowcaseDetailPage({
      params: Promise.resolve({ id: POST_ID }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('builds metadata from the post read alone, and names a legacy id a redirect', async () => {
    await generateMetadata({ params: Promise.resolve({ id: POST_ID }) });
    expect(getPostReferenceForShowcaseIdMock).not.toHaveBeenCalled();

    getPublicPostDetailMock.mockResolvedValueOnce(null);
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce({
      id: POST_ID,
      generation_id: GENERATION_ID,
      visibility: 'public',
      category: 'image',
      prompt: 'Prompt',
      source_kind: 'magicbooklet',
    });
    await expect(generateMetadata({ params: Promise.resolve({ id: GENERATION_ID }) })).resolves.toMatchObject({
      title: 'Creation Redirect',
      robots: { index: false, follow: true },
    });

    getPublicPostDetailMock.mockResolvedValueOnce(null);
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce(null);
    await expect(generateMetadata({ params: Promise.resolve({ id: MISSING_POST_ID }) })).resolves.toEqual({
      title: 'Creation Not Found',
    });
  });

  it('labels a motion post a motion creation, as its feed card does', async () => {
    const detail = await getPublicPostDetailMock(POST_ID);
    getPublicPostDetailMock.mockReset().mockResolvedValue({
      ...detail,
      mediaKind: 'video',
      category: 'video',
      creationMode: 'motion',
    });

    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: POST_ID }),
    }));

    const head = screen.getByTestId('canonical-post-head');
    expect(head).toHaveTextContent('Motion creation');
    expect(head).not.toHaveTextContent('Video creation');
  });

  // The page names the model as the feed card does (`getPostModelDisplayName`).
  // It printed the slug ("nano-banana-2"), or "magicbooklet", the app's own
  // name recorded as the tool of every post made here.
  describe('what the post was made with', () => {
    async function renderHead(fields: Record<string, unknown>) {
      const detail = await getPublicPostDetailMock(POST_ID);
      getPublicPostDetailMock.mockReset().mockResolvedValue({ ...detail, ...fields });
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
      return screen.getByTestId('canonical-post-head');
    }

    it('names a model by its display name, never its slug', async () => {
      const head = await renderHead({ model: 'nano-banana-2', sourceTool: null });

      expect(within(head).getByText('Made with Nano Banana 2.0')).toBeInTheDocument();
      expect(head).not.toHaveTextContent('nano-banana-2');
    });

    it("names the model, not the app, on a post made here", async () => {
      const head = await renderHead({ model: 'gpt-image-2', sourceKind: 'magicbooklet', sourceTool: 'magicbooklet' });

      expect(within(head).getByText('Made with GPT Image 2')).toBeInTheDocument();
      expect(head).not.toHaveTextContent(/magicbooklet/i);
    });

    it('says nothing of a model it cannot name', async () => {
      const head = await renderHead({ model: 'mystery-model-9', sourceKind: 'magicbooklet', sourceTool: 'Magicbooklet' });

      expect(head).not.toHaveTextContent('Made with');
      expect(head).not.toHaveTextContent('mystery-model-9');
      expect(head).not.toHaveTextContent(/magicbooklet/i);
    });

    it('names the outside tool a creator made the post with', async () => {
      // The read gives an outside post's tool as its model when no generation names one.
      const head = await renderHead({ generationId: null, model: 'Midjourney', sourceKind: 'external', sourceTool: 'Midjourney' });

      expect(within(head).getByText('Made with Midjourney')).toBeInTheDocument();
    });

    it('names no model on a text post, as its card names none', async () => {
      const head = await renderHead({
        model: 'nano-banana-2',
        mediaUrl: null,
        mediaKind: null,
        category: 'text',
        postFormat: 'text',
        body: 'Open with tension.',
      });

      expect(head).not.toHaveTextContent('Made with');
      expect(head).not.toHaveTextContent('Nano Banana');
    });

    // Owner's decision, 2026-11-03: the creation's settings are a standard
    // detail, on a quiet line under Made with, for a visitor who unlocked nothing.
    describe("the creation's settings", () => {
      const imageSetup = [
        { label: 'Aspect ratio', value: '9:16' },
        { label: 'Resolution', value: '1K' },
        { label: 'Output format', value: 'JPG' },
      ];

      it('reads them under Made with, each value named for a mouse and a screen reader', async () => {
        const head = await renderHead({
          generationSetup: imageSetup,
          resourceBundle: null,
        });

        const line = within(head).getByTestId('post-generation-setup');
        const terms = line.querySelector('[aria-hidden="true"]');
        expect(terms?.textContent).toBe('9:16·1K·JPG');
        expect(within(line).getByText('JPG')).toHaveAttribute('title', 'Output format');
        expect(within(line).getByText('9:16')).toHaveAttribute('title', 'Aspect ratio');
        expect(within(line).getByText(
          'Generation settings: Aspect ratio: 9:16, Resolution: 1K, Output format: JPG',
        )).toHaveClass('sr-only');
        expect(line).not.toHaveTextContent(/grounding/i);
        // Under the byline that names the model, above the title.
        const madeWith = within(head).getByText('Made with Nano Banana 2.0');
        expect(madeWith.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(line.compareDocumentPosition(within(head).getByRole('heading', { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(line).not.toHaveTextContent(/nano banana|model/i);
      });

      it('names Search grounding on a run that had it on, as a switch with its name', async () => {
        const head = await renderHead({
          generationSetup: [...imageSetup, { label: 'Google Search grounding', value: 'On' }],
        });

        const line = within(head).getByTestId('post-generation-setup');
        expect(line.querySelector('[aria-hidden="true"]')?.textContent).toBe('9:16·1K·JPG·Search grounding on');
        expect(within(line).getByText('Search grounding on')).toHaveAttribute('title', 'Google Search grounding');
      });

      // The read decides which posts have a line (`publicPostGenerationSetup`): the page draws what it is sent.
      it('draws no line where the read sends none or could not read it: an upload, a template result, a text post', async () => {
        for (const generationSetup of [[], undefined]) {
          const head = await renderHead({ generationSetup });
          expect(within(head).queryByTestId('post-generation-setup')).not.toBeInTheDocument();
          cleanup();
        }
      });

      it('draws none on a post under its NSFW cover, which clears it with the rest it hides', async () => {
        const detail = await getPublicPostDetailMock(POST_ID);
        const head = await renderHead({ ...coverNsfwContent({ ...detail, generationSetup: imageSetup }) });
        expect(within(head).queryByTestId('post-generation-setup')).not.toBeInTheDocument();
        expect(head).not.toHaveTextContent('9:16');
      });

      // A paid recipe sells the prompt and the inputs; the settings are the post's, for everyone.
      it('draws the line for a visitor beside a paid recipe they have not unlocked', async () => {
        const head = await renderHead({
          generationSetup: imageSetup,
          resourceBundle: {
            id: 'bundle-1',
            accessMode: 'paid',
            priceQuote: { formatted: '$9.00', note: null },
            resourceKinds: ['prompt', 'files'],
            lockedPreview: {
              resourceKinds: ['prompt', 'files'],
              attachmentPreviews: [],
              itemCounts: { prompt: 1, files: 2 },
              itemPreviews: [{ type: 'prompt', title: 'Prompt', role: 'primary', remixUse: 'none' }],
              hasPrompt: true,
              hasNotes: false,
              hasWorkflow: false,
              hasRemix: true,
              updatedAt: '2026-03-28T10:00:00.000Z',
            },
            viewerCanAccess: false,
            viewerIsOwner: false,
            salesCount: 0,
            resources: null,
            title: 'Golden hour recipe',
            summary: 'The prompt and its references',
            previewText: 'The prompt and its references',
            priceUsdCents: 900,
            status: 'published',
          },
        });

        const line = within(head).getByTestId('post-generation-setup');
        expect(line.querySelector('[aria-hidden="true"]')?.textContent).toBe('9:16·1K·JPG');
        // The recipe stays locked under the post, and holds no copy of the line.
        const recipe = screen.getByTestId('canonical-post-recipe');
        expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({
          isFree: false,
          viewerCanAccess: false,
          resourceKinds: ['prompt', 'files'],
        }));
        expect(within(recipe).queryByTestId('post-generation-setup')).not.toBeInTheDocument();
        expect(screen.getAllByTestId('post-generation-setup')).toHaveLength(1);
      });
    });
  });

  it('renders text-only posts without a media url', async () => {
    getPublicPostDetailMock.mockResolvedValueOnce({
      id: TEXT_POST_ID,
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
      params: Promise.resolve({ id: TEXT_POST_ID }),
    }));

    expect(screen.getByTestId('text-detail-note')).toHaveTextContent('Open with tension.');
    expect(screen.getAllByText(/open with tension/i)).toHaveLength(1);
    expect(screen.queryByTestId('media-detail-frame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('post-body-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('showcase-detail-actions')).toHaveTextContent(TEXT_POST_ID);

    // The writing is the page: one document column carrying its own byline,
    // with no identity card printing the title a second time.
    expect(screen.queryByTestId('canonical-post-identity')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Three hooks that keep working' })).toBeInTheDocument();
    expect(screen.getAllByText('Three hooks that keep working')).toHaveLength(1);
    // Attribution sits in the masthead row; the note keeps the writing.
    expect(screen.getByTestId('canonical-post-head')).toHaveTextContent('@creator-name');
    // A text post is labelled "Text", beside Image, Video and Motion (it read "Tip / note").
    expect(within(screen.getByTestId('canonical-post-head')).getByText('Text')).toBeInTheDocument();

    // The chip bar is media furniture; a written note carries its own byline.
    expect(screen.queryByText(/shared post/i)).not.toBeInTheDocument();

    // A text post's conversation is in the rail too, beside the writing, and
    // its workflow notes are under the writing.
    expect(
      within(screen.getByTestId('canonical-post-actions')).getByTestId('canonical-post-comments')
    ).toBeInTheDocument();
    expect(
      within(within(screen.getByTestId('canonical-post-media')).getByTestId('canonical-post-prompt'))
        .getByRole('heading', { level: 2, name: 'Workflow notes' })
    ).toBeInTheDocument();
  });

  it('pitches a text post recipe once, in the document column', async () => {
    getPublicPostDetailMock.mockResolvedValueOnce({
      id: TEXT_POST_ID,
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
      params: Promise.resolve({ id: TEXT_POST_ID }),
    }));

    // A text post pitches the recipe exactly once — in the document column,
    // before the conversation (it sat after the whole thread, its buy button
    // some 1,270px down on a laptop). The rail keeps a one-line pointer to it.
    expect(screen.queryByTestId('unlock-summary-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('recipe-jump-link')).toHaveAttribute('href', '#recipe');
    expect(screen.getByTestId('recipe-jump-link')).toHaveTextContent('Free recipe');
    expect(
      within(screen.getByTestId('canonical-post-media')).getByTestId('canonical-post-recipe')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('canonical-post-comments').compareDocumentPosition(
        screen.getByTestId('canonical-post-recipe')
      ) & Node.DOCUMENT_POSITION_PRECEDING
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
    const detail = await getPublicPostDetailMock(POST_ID);
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

    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(screen.getByTestId('recipe-jump-link')).toHaveTextContent(`${label}Unlock`);
    expect(screen.getByText(`Unlock recipe for ${label}`)).toBeInTheDocument();
  });

  it('forwards purchase-time proof media when the buyer opens an older revision', async () => {
    const purchasedMediaItems = [
      { id: 'old-media-1', mediaKey: 'old-output-1', url: 'https://cdn.example.com/old-1.jpg', mediaKind: 'image', contentType: 'image/jpeg', originalName: 'old-1.jpg', width: 800, height: 1000, durationSeconds: null, sortOrder: 0 },
      { id: 'old-media-2', mediaKey: 'old-output-2', url: 'https://cdn.example.com/old-2.jpg', mediaKind: 'image', contentType: 'image/jpeg', originalName: 'old-2.jpg', width: 800, height: 1000, durationSeconds: null, sortOrder: 1 },
    ];
    getPublicPostDetailMock.mockResolvedValue({
      id: POST_ID,
      generationId: GENERATION_ID,
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

    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({
      purchasedRevision: expect.objectContaining({ mediaItems: purchasedMediaItems }),
    }));
  });

  // A free unlock stopped counting as a sale on 2026-10-17 (decision 6). The
  // panel prints a free recipe's "N opened" from the free count, and the
  // owner's delete and visibility confirmations still count free unlocks.
  // S1: a creation post's recipe brings its Remix. The page drew no Remix for
  // a viewer without the recipe and the panel never said it came with it (B-F3).
  describe('a recipe that brings the post\'s Remix', () => {
    async function serveRemixRecipe(bundle: Record<string, unknown>, post: Record<string, unknown> = {}) {
      const detail = await getPublicPostDetailMock(POST_ID);
      getPublicPostDetailMock.mockResolvedValueOnce({
        ...detail,
        canRemix: false,
        remixCapability: 'unlock_required',
        remixTarget: 'image',
        ...post,
        resourceBundle: {
          id: 'bundle-1',
          accessMode: 'paid',
          priceQuote: { formatted: '$9.00', note: null },
          resourceKinds: ['prompt', 'remix'],
          lockedPreview: null,
          viewerCanAccess: false,
          viewerIsOwner: false,
          salesCount: 0,
          freeUnlockCount: 0,
          resources: null,
          title: 'Recipe',
          summary: '',
          previewText: '',
          priceUsdCents: 900,
          allowRemix: true,
          status: 'published',
          ...bundle,
        },
      });
    }

    it('locks Remix behind the recipe with its price, and names it in the recipe', async () => {
      await serveRemixRecipe({});
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      expect(screen.getByTestId('showcase-detail-engagement-row')).toHaveAttribute('data-recipe-remix', 'paid:900 credits');
      expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ remixIncluded: true }));
    });

    it('offers a free recipe\'s Remix as free', async () => {
      await serveRemixRecipe({ accessMode: 'free', priceUsdCents: 0 });
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      expect(screen.getByTestId('showcase-detail-engagement-row')).toHaveAttribute('data-recipe-remix', 'free:Free');
    });

    it('leaves Remix open, and the recipe pointing at it, once the viewer has the recipe', async () => {
      await serveRemixRecipe({ viewerCanAccess: true }, { canRemix: true, remixCapability: 'public' });
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      expect(screen.getByTestId('showcase-detail-engagement-row')).toHaveAttribute('data-recipe-remix', '');
      expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ remixIncluded: true }));
      expect(screen.getByTestId('recipe-jump-link')).toHaveTextContent('Unlocked');
    });

    it('promises no Remix where the post has none to give', async () => {
      await serveRemixRecipe({ allowRemix: false }, { remixCapability: 'none' });
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      expect(screen.getByTestId('showcase-detail-engagement-row')).toHaveAttribute('data-recipe-remix', '');
      expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ remixIncluded: false }));
    });
  });

  it('hands the recipe panel and the owner actions both unlock counts', async () => {
    const detail = await getPublicPostDetailMock(POST_ID);
    getPublicPostDetailMock.mockResolvedValueOnce({
      ...detail,
      resourceBundle: {
        id: 'bundle-1',
        accessMode: 'free',
        priceQuote: { formatted: '$0.00', note: null },
        resourceKinds: ['prompt'],
        lockedPreview: null,
        viewerCanAccess: false,
        viewerIsOwner: false,
        salesCount: 1,
        freeUnlockCount: 5,
        resources: null,
        title: 'Recipe',
        summary: '',
        previewText: '',
        priceUsdCents: 0,
        status: 'published',
      },
    });

    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ salesCount: 1, freeUnlockCount: 5 })
    );
    expect(showcaseDetailActionsPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({
      bundle: { accessMode: 'free', status: 'published', salesCount: 1, freeUnlockCount: 5 },
    }));
  });

  // A template's model is its author's: the read sends Studio's
  // `template-workflow` in its place and no Remix, and the page, its title and
  // its structured data name no model for it.
  it("names no model on a template result's post and offers no Remix", async () => {
    const detail = await getPublicPostDetailMock(POST_ID);
    const ordinary = render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
    expect(screen.getByText('Made with Nano Banana 2.0')).toBeInTheDocument();
    expect(JSON.stringify(await generateMetadata({ params: Promise.resolve({ id: POST_ID }) }))).toMatch(/made with/i);
    ordinary.unmount();

    getPublicPostDetailMock.mockResolvedValue({
      ...detail,
      model: 'template-workflow',
      canRemix: false,
      remixCapability: 'none',
      remixTarget: null,
    });
    render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/made with|template[- ]workflow/i);
    expect(screen.getByTestId('showcase-detail-engagement-row')).toHaveTextContent(`${POST_ID}:false`);
    expect(JSON.stringify(await generateMetadata({ params: Promise.resolve({ id: POST_ID }) })))
      .not.toMatch(/made with|template[- ]workflow/i);
  });
  // The page is one cached render for everyone: the server reads the post as a
  // signed-out visitor in no country would, and the browser makes it this
  // viewer's page.
  describe('one cached render for everyone', () => {
    const lockedBundle = {
      id: 'bundle-1',
      postId: POST_ID,
      accessMode: 'paid',
      priceQuote: { formatted: '$9.00', note: null },
      resourceKinds: ['prompt', 'remix'],
      lockedPreview: null,
      viewerCanAccess: false,
      viewerIsOwner: false,
      viewerHasPurchased: false,
      salesCount: 4,
      freeUnlockCount: 0,
      resources: null,
      purchasedRevision: null,
      title: 'Recipe',
      summary: '',
      previewText: '',
      priceUsdCents: 900,
      allowRemix: true,
      status: 'published',
      seller: { id: 'user-1' },
    };
    const boughtResources = {
      promptText: 'The full prompt', notesMarkdown: null, workflowShareUrl: null,
      workflowSnapshot: null, attachments: [], allowRemix: true, sections: [], items: [],
    };

    async function serveLockedRecipe() {
      const detail = await getPublicPostDetailMock(POST_ID);
      getPublicPostDetailMock.mockResolvedValue({
        ...detail,
        canRemix: false,
        remixCapability: 'unlock_required',
        remixTarget: 'image',
        resourceBundle: lockedBundle,
      });
    }

    it('is an ISR page with no build-time posts, five minutes as its backstop', async () => {
      expect(pageModule.revalidate).toBe(PUBLIC_PAGE_REVALIDATE_SECONDS);
      await expect(pageModule.generateStaticParams()).resolves.toEqual([]);
      expect(Object.keys(pageModule)).not.toContain('dynamic');
    });

    it('reads the post as a visitor would, and never the request, for anyone looking', async () => {
      signInAs('user-2');
      openedAt('?s=showcase-reel&from=home&delivery=4242');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
      await generateMetadata({ params: Promise.resolve({ id: POST_ID }) });

      expect(requestTimeRead).not.toHaveBeenCalled();
      // No viewer, no country, no query: the same read for every request.
      expect(getPublicPostDetailOptionsMock.mock.calls.every(([, options]) => options === undefined)).toBe(true);
    });

    it("draws a visitor's locked recipe in the HTML, and asks a visitor's currency only for a cash price", async () => {
      await serveLockedRecipe();
      stubPageFetch({}, {
        viewerBundle: { ...lockedBundle, priceQuote: { formatted: '₹750.00', note: 'Charged in INR for buyers in India.' } },
      });
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      expect(screen.getByTestId('recipe-jump-link')).toHaveTextContent('Unlock');
      // A visitor's read carries no session.
      const [, init] = requestTo(RECIPE_READ) ?? [];
      expect(init?.headers).toBeUndefined();
      await waitFor(() => expect(screen.getByTestId('recipe-jump-link')).toHaveTextContent('₹750.00 · 900 credits'));
      expect(screen.getByText('Unlock recipe for ₹750.00 · 900 credits')).toBeInTheDocument();
    });

    it("asks nothing for a visitor's free recipe or a post with none", async () => {
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
      expect(requestsTo(RECIPE_READ)).toEqual([]);
    });

    it("opens the recipe, Remix and the rail for a buyer once the browser has read it as theirs", async () => {
      await serveLockedRecipe();
      stubPageFetch({}, {
        viewerBundle: { ...lockedBundle, viewerCanAccess: true, viewerHasPurchased: true, resources: boughtResources },
      });
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(screen.getByTestId('recipe-jump-link')).toHaveTextContent('Unlocked'));
      const [, init] = requestTo(RECIPE_READ) ?? [];
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer live-token' });
      expect(postResourceBundlePanelPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({
        viewerCanAccess: true,
        initialResources: expect.objectContaining({ promptText: 'The full prompt' }),
      }));
      expect(screen.getByTestId('showcase-detail-engagement-row')).toHaveTextContent(`${POST_ID}:true`);
      expect(screen.getByTestId('showcase-detail-engagement-row')).toHaveAttribute('data-recipe-remix', '');
      expect(screen.queryByText(/^Unlock recipe for/)).not.toBeInTheDocument();
    });

    it("gives the owner their recipe and Owner tools, a delisted one included", async () => {
      // The page (a visitor's read) has no recipe: it is not on sale.
      stubPageFetch({}, {
        viewerBundle: { ...lockedBundle, status: 'draft', viewerIsOwner: true, viewerCanAccess: true, resources: boughtResources },
      });
      signInAs('user-1');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(screen.getByTestId('recipe-jump-link')).toHaveTextContent('Your recipe'));
      expect(screen.getByTestId('showcase-detail-actions')).toHaveAttribute('data-owner-tools', 'true');
      expect(showcaseDetailActionsPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({
        hasResourceBundle: true,
        bundle: expect.objectContaining({ status: 'draft' }),
      }));
    });

    it('takes the recipe off the page when the viewer may no longer read it', async () => {
      await serveLockedRecipe();
      stubPageFetch({}, { viewerBundle: null });
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(screen.queryByTestId('canonical-post-recipe')).not.toBeInTheDocument());
      expect(screen.queryByTestId('recipe-jump-link')).not.toBeInTheDocument();
    });

    // Sweep of 2026-11-17: every post a signed-in reader opened that had no recipe asked for theirs,
    // which the route answered 404, and the browser logged a failed load on every such post.
    it("asks a signed-in reader's recipe with one that is not there answered as none, and draws none", async () => {
      stubPageFetch({}, { viewerBundle: null });
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(requestsTo(RECIPE_READ)).toHaveLength(1));
      expect(RECIPE_READ).toBe(`/api/posts/${POST_ID}/resource-bundle?absent=none`);
      const [, init] = requestTo(RECIPE_READ) ?? [];
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer live-token' });
      expect(screen.queryByTestId('canonical-post-recipe')).not.toBeInTheDocument();
      expect(screen.queryByTestId('recipe-jump-link')).not.toBeInTheDocument();
    });

    it('takes the recipe off the page for a 404 too, from a server that predates absent=none', async () => {
      await serveLockedRecipe();
      vi.mocked(fetch).mockImplementation(async (input) => (
        String(input) === RECIPE_READ
          ? { ok: false, status: 404, json: async () => ({ error: 'Resource bundle not found.' }) } as Response
          : { ok: true, status: 200, json: async () => ({ success: true }) } as Response
      ));
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(screen.queryByTestId('canonical-post-recipe')).not.toBeInTheDocument());
      expect(screen.queryByTestId('recipe-jump-link')).not.toBeInTheDocument();
    });

    it("keeps the page's recipe for an answer that names no recipe and no none", async () => {
      await serveLockedRecipe();
      vi.mocked(fetch).mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) } as Response));
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(requestTo(RECIPE_READ)).toBeDefined());
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByTestId('canonical-post-recipe')).toBeInTheDocument();
    });

    it('keeps the page\'s recipe when the read fails', async () => {
      await serveLockedRecipe();
      vi.mocked(fetch).mockImplementation(async (input) => (
        String(input) === RECIPE_READ
          ? { ok: false, status: 503, json: async () => ({ error: 'Down' }) } as Response
          : { ok: true, status: 200, json: async () => ({ success: true }) } as Response
      ));
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      await waitFor(() => expect(requestTo(RECIPE_READ)).toBeDefined());
      expect(screen.getByTestId('canonical-post-recipe')).toBeInTheDocument();
      expect(screen.getByTestId('recipe-jump-link')).toHaveTextContent('Unlock');
    });

    it('opens Remix and drops the bottom bar when the panel unlocks the recipe', async () => {
      await serveLockedRecipe();
      signInAs('user-2');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));
      expect(screen.getByTestId('showcase-detail-engagement-row')).toHaveAttribute('data-recipe-remix', 'paid:900 credits');

      const { onAccessChange } = postResourceBundlePanelPropsMock.mock.lastCall?.[0] as {
        onAccessChange: (bundle: Record<string, unknown>) => void;
      };
      act(() => onAccessChange({ viewerCanAccess: true, viewerIsOwner: false, resources: boughtResources }));

      expect(screen.getByTestId('showcase-detail-engagement-row')).toHaveTextContent(`${POST_ID}:true`);
      expect(screen.getByTestId('recipe-jump-link')).toHaveTextContent('Unlocked');
      expect(screen.queryByText(/^Unlock recipe for/)).not.toBeInTheDocument();
      expect(routerMock.refresh).not.toHaveBeenCalled();
    });

    // Owner tools invalidate the page only after their answer was sent, so the
    // refresh they start, and the router's copy of the page, can be the page
    // as it was: the owner sees the visibility the server answered with.
    it('shows the owner the visibility they just saved while the cached page still has the old one', async () => {
      const detail = await getPublicPostDetailMock(POST_ID);
      getPublicPostDetailMock.mockResolvedValue({ ...detail, visibility: 'unlisted' });
      const openPost = () => ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) });
      signInAs('user-1');
      const view = render(await openPost());
      expect(screen.getByText('Unlisted')).toBeInTheDocument();
      expect(screen.queryByTestId('canonical-post-comments')).not.toBeInTheDocument();

      act(() => rememberOwnerPostVisibility(POST_ID, 'public'));
      view.rerender(await openPost());

      expect(screen.queryByText('Unlisted')).not.toBeInTheDocument();
      expect(screen.getByTestId('canonical-post-comments')).toBeInTheDocument();
      expect(showcaseDetailActionsPropsMock).toHaveBeenLastCalledWith(expect.objectContaining({ visibility: 'public' }));

      // Opened again in the same tab, from the router's copy: still as saved.
      view.unmount();
      render(await openPost());
      expect(screen.queryByText('Unlisted')).not.toBeInTheDocument();

      // Anyone else, in the same tab, gets the page as it was cached.
      cleanup();
      signInAs('user-2');
      render(await openPost());
      expect(screen.getByText('Unlisted')).toBeInTheDocument();
      cleanup();
      clientAuth.current = { session: null, user: null };
      render(await openPost());
      expect(screen.getByText('Unlisted')).toBeInTheDocument();
    });

    it('reads no recipe for a post under its NSFW cover: it comes with the reveal', async () => {
      const detail = await getPublicPostDetailMock(POST_ID) as Record<string, unknown>;
      getPublicPostDetailMock.mockResolvedValueOnce(coverNsfwContent(detail));
      signInAs('user-1');
      render(await ShowcaseDetailPage({ params: Promise.resolve({ id: POST_ID }) }));

      expect(screen.getByRole('button', { name: 'Reveal post' })).toBeInTheDocument();
      expect(requestsTo(RECIPE_READ)).toEqual([]);
    });
  });
});
