import { act, type ReactNode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreatorContentTabs } from '@/app/creators/[username]/CreatorContentTabs';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import type { CreatorProfilePageData } from '@/lib/creator-profile';
import type { ShowcaseFeedItem } from '@/lib/showcase';

// One router for every render, so a test can read what a click asked of it.
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
const routerPush = routerMock.push;
const routerReplace = routerMock.replace;
const authState = vi.hoisted(() => ({
  session: null as { access_token: string } | null,
  user: null as { id: string } | null,
}));
// The query the page is opened with; empty unless a test opens a link.
const searchState = vi.hoisted(() => ({ search: '' }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/creators/creator-name',
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(searchState.search),
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: authState.session, user: authState.user }),
}));

vi.mock('@/app/showcase/ShowcaseMediaCarousel', () => ({
  default: ({ onOpen, title }: { onOpen?: (index: number) => void; title: string }) => (
    <button type="button" onClick={() => onOpen?.(0)}>{title}</button>
  ),
}));

// Stands in for the reel: says which post is open, and offers a button for each
// menu handler the page gives it.
type ReelHandler = (item: ShowcaseFeedItem) => void | Promise<void>;
vi.mock('@/app/showcase/ShowcaseReelViewer', () => ({
  default: ({
    isOpen,
    items: reelItems,
    selectedItemId,
    savedItemIds,
    hasMoreItems,
    onFeedback,
    onReportContent,
    onReportUser,
    onBlockUser,
    originLabel,
    selectedItemStatus,
    onRetrySelectedItem,
    loadMoreError,
    onToggleSave,
  }: {
    isOpen: boolean;
    items: ShowcaseFeedItem[];
    selectedItemId: string | null;
    savedItemIds?: Set<string>;
    hasMoreItems?: boolean;
    originLabel?: string;
    onFeedback?: unknown;
    onReportContent?: ReelHandler;
    onReportUser?: ReelHandler;
    onBlockUser?: ReelHandler;
    selectedItemStatus?: string | null;
    onRetrySelectedItem?: () => void;
    loadMoreError?: string | null;
    onToggleSave?: (id: string) => unknown;
  }) => {
    const openItem = reelItems.find((candidate) => candidate.id === selectedItemId);
    return isOpen ? (
      <div role="dialog" aria-label="Creator immersive viewer">
        <span>{selectedItemId}</span>
        <span>Closes to {originLabel ?? 'Explore'}</span>
        <span data-testid="reel-saved">{[...(savedItemIds ?? [])].sort().join(',')}</span>
        <span data-testid="reel-has-more">{String(Boolean(hasMoreItems))}</span>
        {selectedItemStatus ? <span>Linked post: {selectedItemStatus}</span> : null}
        {selectedItemStatus === 'failed' && onRetrySelectedItem
          ? <button type="button" onClick={onRetrySelectedItem}>Try again</button>
          : null}
        {loadMoreError ? <span role="alert">{loadMoreError}</span> : null}
        {onFeedback ? <button type="button">Feed rows</button> : null}
        {openItem && onReportContent ? <button type="button" onClick={() => void onReportContent(openItem)}>Report content</button> : null}
        {openItem && onReportUser ? <button type="button" onClick={() => void onReportUser(openItem)}>Report user</button> : null}
        {openItem && onBlockUser ? <button type="button" onClick={() => void onBlockUser(openItem)}>Block user</button> : null}
        {openItem && onToggleSave ? <button type="button" onClick={() => void onToggleSave(openItem.id)}>Save post</button> : null}
      </div>
    ) : null;
  },
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: { div: ({ children }: { children: ReactNode }) => <div>{children}</div> },
}));

const items: CreatorProfilePageData['items'] = [
  {
    id: 'item-1',
    mediaUrl: 'https://example.com/creation.jpg',
    mediaKind: 'image',
    mediaItems: [{
      id: 'media-1',
      url: 'https://example.com/creation.jpg',
      previewUrl: 'https://example.com/creation-preview.webp',
      mediaKind: 'image',
      contentType: 'image/jpeg',
      originalName: 'creation.jpg',
      width: 1080,
      height: 1350,
      durationSeconds: null,
      sortOrder: 0,
    }],
    model: 'nano-banana-2',
    title: 'Campaign Frame',
    prompt: 'A creator holds the product near a bright window.',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 12,
    remixCount: 4,
    commentCount: 0,
    createdAt: '2026-03-27T10:00:00.000Z',
    creator: { id: 'creator-1', username: 'creator-name', name: 'Creator Name', avatar: null },
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: 'gen-1',
    asset: null,
    canRemix: true,
  },
  {
    id: 'item-2',
    mediaUrl: null,
    mediaKind: null,
    model: 'external',
    title: 'Workflow Breakdown',
    prompt: '',
    body: 'A concise workflow breakdown.',
    category: 'text',
    postFormat: 'text',
    saveCount: 3,
    remixCount: 1,
    commentCount: 0,
    createdAt: '2026-03-28T10:00:00.000Z',
    creator: { id: 'creator-1', username: 'creator-name', name: 'Creator Name', avatar: null },
    sourceKind: 'external',
    sourceTool: 'Runway',
    sourceToolSlug: 'runway',
    generationId: null,
    asset: {
      id: 'bundle-1',
      postId: 'item-2',
      title: 'Workflow Breakdown Unlock',
      accessMode: 'paid',
      priceUsdCents: 900,
      previewText: 'Prompt and workflow included.',
      allowRemix: false,
      salesCount: 2,
      resourceKinds: ['prompt', 'workflow'],
    },
    canRemix: false,
  },
];

const initialData: CreatorProfilePageData = {
  profile: {
    id: 'creator-1',
    username: 'creator-name',
    displayName: 'Creator Name',
    bio: 'Creator bio',
    avatarUrl: null,
    coverUrl: null,
    websiteUrl: null,
    twitterHandle: null,
    instagramHandle: null,
    tiktokHandle: null,
    location: null,
  },
  stats: {
    publicCreations: 8,
    totalSaves: 15,
    totalRemixes: 5,
    unlocks: 3,
    totalUnlockSales: 2,
    toolsUsed: [{ slug: 'runway', label: 'Runway', count: 4 }],
  },
  items,
  pageInfo: { hasMore: false, limit: 24, offset: 0, nextOffset: null, nextLimit: null },
};

describe('CreatorContentTabs', () => {
  beforeEach(() => {
    routerPush.mockReset();
    routerReplace.mockReset();
    authState.session = null;
    authState.user = null;
    searchState.search = '';
    resetFeedbackState();
    window.history.replaceState(null, '', '/creators/creator-name');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses global counts and opens a post in the immersive viewer', async () => {
    render(<CreatorContentTabs initialData={initialData} profilePath="/creators/creator-name" />);

    expect(screen.getByRole('tab', { name: /posts 8/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /recipes 3/i })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /campaign frame/i })[0]);

    expect(await screen.findByRole('dialog', { name: /creator immersive viewer/i })).toHaveTextContent('item-1');
    expect(window.location.search).toContain('post=item-1');
  });

  it('filters recipes and makes source tools actionable', () => {
    render(<CreatorContentTabs initialData={initialData} profilePath="/creators/creator-name" />);

    fireEvent.click(screen.getByRole('tab', { name: /recipes 3/i }));
    expect(screen.getByText('Workflow Breakdown')).toBeInTheDocument();
    expect(screen.queryByText('Campaign Frame')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /tools 1/i }));
    expect(screen.getByRole('link', { name: /runway/i })).toHaveAttribute('href', '/showcase?tool=runway');
  });

  // The tile badge read "$0.50 recipe" for a recipe only credits buy, and
  // "$9.00" where the app read "900 credits". It gives the label Explore and
  // the feed give the same recipe: credits, whatever the viewer's quote.
  it('prices a recipe tile in credits, a credits-only one included', () => {
    const creditsOnly: ShowcaseFeedItem = {
      ...items[1],
      id: 'item-4',
      title: 'Credits Breakdown',
      asset: {
        ...items[1].asset!,
        id: 'bundle-4',
        postId: 'item-4',
        priceUsdCents: 50,
        priceQuote: { currency: 'INR', amountSubunits: 4200, formatted: '₹42', note: null },
      },
    };
    render(
      <CreatorContentTabs
        initialData={{ ...initialData, items: [...items, creditsOnly] }}
        profilePath="/creators/creator-name"
      />
    );

    expect(screen.getByText('900 credits')).toBeInTheDocument();
    expect(screen.getByText('50 credits')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('$9.00');
    expect(document.body.textContent).not.toContain('₹42');
  });

  it('loads and appends the next stable creator page when automatic observation is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const nextItem = {
      ...items[0],
      id: 'item-3',
      title: 'Second Page Frame',
      mediaItems: items[0].mediaItems?.map((media) => ({ ...media, id: 'media-3' })),
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...initialData,
        items: [nextItem],
        pageInfo: { hasMore: false, limit: 24, offset: 24, nextOffset: null, nextLimit: null },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <CreatorContentTabs
        initialData={{
          ...initialData,
          pageInfo: { hasMore: true, limit: 24, offset: 0, nextOffset: 24, nextLimit: 48 },
        }}
        profilePath="/creators/creator-name"
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Load more posts' }));

    expect((await screen.findAllByText('Second Page Frame')).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith('/api/creators/creator-name?limit=24&offset=24', undefined);
  });

  // The reel's own paging asked again at once after a failed page, without end,
  // and the error was drawn behind it, under the grid.
  it('tells the reel when a page fails to load', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Failed' }) })));
    render(
      <CreatorContentTabs
        initialData={{
          ...initialData,
          pageInfo: { hasMore: true, limit: 24, offset: 0, nextOffset: 24, nextLimit: 48 },
        }}
        profilePath="/creators/creator-name"
      />
    );
    fireEvent.click(screen.getAllByRole('button', { name: /campaign frame/i })[0]);
    const reel = await screen.findByRole('dialog', { name: /creator immersive viewer/i });

    fireEvent.click(await screen.findByRole('button', { name: 'Load more posts' }));

    expect(await within(reel).findByRole('alert')).toHaveTextContent('Could not load more posts.');
  });

  // A `?post=` link to a post the page does not hold is read on its own. When
  // it was gone, or someone else's, the page opened nothing and said nothing.
  describe('a linked post the page does not hold', () => {
    const linkTo = (postId: string) => {
      searchState.search = `?post=${postId}`;
      window.history.replaceState(null, '', `/creators/creator-name?post=${postId}`);
    };
    const answerPost = (answer: () => { ok: boolean; status: number; json: () => Promise<unknown> }) => {
      vi.stubGlobal('fetch', vi.fn(async (input: string) => (
        input.startsWith('/api/showcase/posts/') ? answer() : { ok: true, status: 200, json: async () => ({}) }
      )));
    };
    const renderPage = () => render(<CreatorContentTabs initialData={initialData} profilePath="/creators/creator-name" />);

    it('opens the reel on the read, and says when the post is gone', async () => {
      linkTo('item-gone');
      answerPost(() => ({ ok: false, status: 404, json: async () => ({ error: 'Post not found.' }) }));
      renderPage();

      const reel = await screen.findByRole('dialog', { name: /creator immersive viewer/i });
      expect(reel).toHaveTextContent('item-gone');
      await waitFor(() => expect(reel).toHaveTextContent('Linked post: unavailable'));
    });

    it("says that someone else's post is not on this page", async () => {
      linkTo('item-other');
      answerPost(() => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          item: {
            ...items[0],
            id: 'item-other',
            creator: { id: 'creator-9', username: 'someone-else', name: 'Someone Else', avatar: null },
          },
        }),
      }));
      renderPage();

      const reel = await screen.findByRole('dialog', { name: /creator immersive viewer/i });
      await waitFor(() => expect(reel).toHaveTextContent('Linked post: unavailable'));
    });

    it('offers Try again when the read fails, and opens the post when it comes', async () => {
      linkTo('item-late');
      let failing = true;
      answerPost(() => (failing
        ? { ok: false, status: 503, json: async () => ({ error: 'Busy' }) }
        : { ok: true, status: 200, json: async () => ({ success: true, item: { ...items[0], id: 'item-late', title: 'Late Frame' } }) }));
      renderPage();

      const reel = await screen.findByRole('dialog', { name: /creator immersive viewer/i });
      await waitFor(() => expect(reel).toHaveTextContent('Linked post: failed'));

      failing = false;
      fireEvent.click(within(reel).getByRole('button', { name: 'Try again' }));

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /creator immersive viewer/i })).not.toHaveTextContent('Linked post:');
      });
      expect(screen.getByRole('dialog', { name: /creator immersive viewer/i })).toHaveTextContent('item-late');
    });
  });

  // The reel opened from a creator's page had no ⋯ at all. It carries the three
  // safety rows, as the app's reel does there, and nothing about a feed.
  describe("the reel's safety rows", () => {
    const signIn = () => {
      authState.session = { access_token: 'viewer-token' };
      authState.user = { id: 'viewer-1' };
    };
    // A signed-in page also asks which posts are saved; only the report and
    // block requests are counted here.
    const isSafetyRequest = (url: unknown) => /^\/api\/(moderation\/|posts\/[^/]+\/report$)/.test(String(url));
    const answerRequests = (ok = true) => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        void init;
        if (!isSafetyRequest(url)) return { ok: true, status: 200, json: async () => ({ success: true, savedIds: [] }) };
        return { ok, status: ok ? 200 : 500, json: async () => (ok ? { success: true } : { error: 'Failed to block user.' }) };
      });
      vi.stubGlobal('fetch', fetchMock);
      return { sent: () => fetchMock.mock.calls.filter(([url]) => isSafetyRequest(url)) };
    };
    const toasts = () => readFeedbackSnapshot().toasts.map(({ tone, message }) => ({ tone, message }));
    const openReel = async () => {
      render(<CreatorContentTabs initialData={initialData} profilePath="/creators/creator-name" />);
      fireEvent.click(screen.getAllByRole('button', { name: /campaign frame/i })[0]);
      return screen.findByRole('dialog', { name: /creator immersive viewer/i });
    };

    it('gives the reel Report content, Report user and Block user, and no feed rows', async () => {
      const reel = await openReel();

      expect(reel).toHaveTextContent('item-1');
      expect(screen.getByRole('button', { name: 'Report content' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Report user' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Block user' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Feed rows' })).not.toBeInTheDocument();
      // Its close button goes back to this page, not to Explore, and says so.
      expect(reel).toHaveTextContent('Closes to Creator');
    });

    it('sends a signed-out viewer to sign in and back to the open post, and asks and sends nothing', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const requests = answerRequests();
      await openReel();

      fireEvent.click(screen.getByRole('button', { name: 'Report content' }));
      fireEvent.click(screen.getByRole('button', { name: 'Report user' }));
      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      const signInPath = `/login?returnUrl=${encodeURIComponent('/creators/creator-name?post=item-1#creator-creations')}`;
      expect(routerPush.mock.calls).toEqual([[signInPath], [signInPath], [signInPath]]);
      expect(confirm).not.toHaveBeenCalled();
      expect(requests.sent()).toHaveLength(0);
    });

    it("reports a post as from a creator page, and leaves it in the creator's list", async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const requests = answerRequests();
      signIn();
      const reel = await openReel();

      fireEvent.click(screen.getByRole('button', { name: 'Report content' }));

      await waitFor(() => expect(requests.sent()).toHaveLength(1));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Report content?'));
      const [url, init] = requests.sent()[0];
      expect(url).toBe('/api/posts/item-1/report');
      expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer viewer-token' } });
      expect(JSON.parse(String(init?.body))).toEqual({
        reason: 'unsafe_content',
        details: 'Reported from a creator page on the web.',
      });
      // Nothing was taken away, so the line does not say anything was.
      await waitFor(() => expect(toasts()).toEqual([
        { tone: 'success', message: 'Content reported. Our moderation team will take a look.' },
      ]));
      expect(reel).toHaveTextContent('item-1');
      expect(screen.getAllByRole('button', { name: /campaign frame/i }).length).toBeGreaterThan(0);
      expect(routerReplace).not.toHaveBeenCalled();
    });

    it("reports the creator as the app's creator screen files it", async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const requests = answerRequests();
      signIn();
      await openReel();

      fireEvent.click(screen.getByRole('button', { name: 'Report user' }));

      await waitFor(() => expect(requests.sent()).toHaveLength(1));
      const [url, init] = requests.sent()[0];
      expect(url).toBe('/api/moderation/reports');
      expect(JSON.parse(String(init?.body))).toEqual({
        targetType: 'user',
        targetId: 'creator-1',
        reason: 'unsafe_content',
        sourceSurface: 'creator-profile',
        details: "Reported from the creator's page on the web.",
      });
      await waitFor(() => expect(toasts()).toEqual([
        { tone: 'success', message: 'Creator reported. Our moderation team will take a look.' },
      ]));
      expect(routerReplace).not.toHaveBeenCalled();
    });

    it('blocks the creator, says so, and leaves their page for Explore', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const requests = answerRequests();
      signIn();
      await openReel();

      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/showcase'));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Block this creator?'));
      expect(requests.sent()).toHaveLength(1);
      const [url, init] = requests.sent()[0];
      expect(url).toBe('/api/moderation/blocks/creator-1');
      expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer viewer-token' } });
      expect(toasts()).toEqual([
        { tone: 'success', message: 'Creator Name is blocked. Their posts are gone from your feed.' },
      ]);
    });

    it('sends nothing and stays when the question is declined', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const requests = answerRequests();
      signIn();
      await openReel();

      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      await waitFor(() => expect(confirm).toHaveBeenCalled());
      expect(requests.sent()).toHaveLength(0);
      expect(toasts()).toEqual([]);
      expect(routerReplace).not.toHaveBeenCalled();
    });

    it('stays on the page and says why when the block fails', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      answerRequests(false);
      signIn();
      await openReel();

      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      await waitFor(() => expect(toasts()).toEqual([
        { tone: 'error', message: 'Could not block this creator. Failed to block user.' },
      ]));
      expect(routerReplace).not.toHaveBeenCalled();
    });

    it('does not act on your own page, whatever the reel is told', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const requests = answerRequests();
      authState.session = { access_token: 'owner-token' };
      authState.user = { id: 'creator-1' };
      await openReel();

      fireEvent.click(screen.getByRole('button', { name: 'Report user' }));
      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      expect(confirm).not.toHaveBeenCalled();
      expect(requests.sent()).toHaveLength(0);
      expect(routerReplace).not.toHaveBeenCalled();
    });
  });

  // The Recipes tab filters the loaded posts. It said "No recipes yet" under
  // "Recipes N" while recipes were still in unloaded pages, and its sentinel
  // walked every page of a creator whose count said there were none.
  describe('the Recipes tab', () => {
    const post = (id: string, recipe = false): ShowcaseFeedItem => ({
      ...items[recipe ? 1 : 0],
      id,
      title: `Post ${id}`,
      mediaItems: items[0].mediaItems?.map((media) => ({ ...media, id: `media-${id}` })),
      asset: recipe ? { ...items[1].asset!, id: `bundle-${id}`, postId: id } : null,
    });
    const page = (pageItems: ShowcaseFeedItem[], offset: number, hasMore: boolean) => ({
      profile: initialData.profile,
      items: pageItems,
      pageInfo: { hasMore, limit: 24, offset, nextOffset: hasMore ? offset + 24 : null, nextLimit: hasMore ? 24 : null },
    });
    const answerPages = (pages: Record<number, ReturnType<typeof page>>) => {
      const fetchMock = vi.fn(async (url: string) => {
        const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
        const answer = pages[offset];
        if (!answer) throw new Error(`Unexpected page: ${url}`);
        return { ok: true, status: 200, json: async () => answer };
      });
      vi.stubGlobal('fetch', fetchMock);
      return { offsets: () => fetchMock.mock.calls.map(([url]) => Number(new URL(url, 'http://localhost').searchParams.get('offset'))) };
    };
    const firstPage = (unlocks: number): CreatorProfilePageData => ({
      ...initialData,
      stats: { ...initialData.stats, unlocks },
      items: [post('post-1'), post('post-2')],
      pageInfo: { hasMore: true, limit: 24, offset: 0, nextOffset: 24, nextLimit: 24 },
    });

    it('says "No recipes yet" and loads nothing when the creator has none', async () => {
      vi.stubGlobal('IntersectionObserver', undefined);
      const pages = answerPages({});
      render(<CreatorContentTabs initialData={firstPage(0)} profilePath="/creators/creator-name" />);

      fireEvent.click(screen.getByRole('tab', { name: /recipes 0/i }));

      expect(screen.getByRole('heading', { name: 'No recipes yet' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
      expect(pages.offsets()).toEqual([]);
      // Posts still pages as before.
      fireEvent.click(screen.getByRole('tab', { name: /posts/i }));
      expect(await screen.findByRole('button', { name: 'Load more posts' })).toBeInTheDocument();
    });

    it('looks for the recipes its count promises instead of saying there are none', async () => {
      vi.stubGlobal('IntersectionObserver', undefined);
      const pages = answerPages({ 24: page([post('post-3'), post('recipe-1', true)], 24, true) });
      render(<CreatorContentTabs initialData={firstPage(1)} profilePath="/creators/creator-name" />);

      fireEvent.click(screen.getByRole('tab', { name: /recipes 1/i }));

      expect(screen.queryByRole('heading', { name: 'No recipes yet' })).not.toBeInTheDocument();
      fireEvent.click(await screen.findByRole('button', { name: 'Load more recipes' }));

      expect((await screen.findAllByRole('button', { name: /post recipe-1/i })).length).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: /post post-3/i })).not.toBeInTheDocument();
      // Every recipe the count named is here: nothing more is asked for under this tab.
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
      expect(pages.offsets()).toEqual([24]);
    });

    it('pages on its own only until the recipes it counts have come', async () => {
      const observers: Array<{ disconnected: boolean }> = [];
      vi.stubGlobal('IntersectionObserver', class {
        private state = { disconnected: false };
        constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          observers.push(this.state);
        }
        observe() {
          // The sentinel is in view: say so as a browser does, once observed.
          queueMicrotask(() => {
            if (!this.state.disconnected) this.callback([{ isIntersecting: true }]);
          });
        }
        disconnect() {
          this.state.disconnected = true;
        }
      });
      window.history.replaceState(null, '', '/creators/creator-name#creator-unlocks');
      const pages = answerPages({
        24: page([post('post-3'), post('post-4')], 24, true),
        48: page([post('post-5'), post('recipe-1', true)], 48, true),
      });
      render(<CreatorContentTabs initialData={firstPage(1)} profilePath="/creators/creator-name" />);

      expect(screen.getByRole('tab', { name: /recipes 1/i })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('Loading recipes')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'No recipes yet' })).not.toBeInTheDocument();

      expect((await screen.findAllByRole('button', { name: /post recipe-1/i })).length).toBeGreaterThan(0);
      await waitFor(() => expect(screen.queryByText('Loading recipes')).not.toBeInTheDocument());
      // Page 72 exists, but the one recipe counted has come: no walk to the end.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(pages.offsets()).toEqual([24, 48]);
      expect(observers.length).toBeGreaterThan(0);
    });

    it('says "No recipes yet" once no pages are left', async () => {
      vi.stubGlobal('IntersectionObserver', undefined);
      answerPages({ 24: page([post('post-3')], 24, false) });
      render(<CreatorContentTabs initialData={firstPage(1)} profilePath="/creators/creator-name" />);

      fireEvent.click(screen.getByRole('tab', { name: /recipes 1/i }));
      fireEvent.click(await screen.findByRole('button', { name: 'Load more recipes' }));

      expect(await screen.findByRole('heading', { name: 'No recipes yet' })).toBeInTheDocument();
    });

    it('tells a reel opened on the recipes that more come only while the count says so', async () => {
      vi.stubGlobal('IntersectionObserver', undefined);
      answerPages({});
      render(
        <CreatorContentTabs
          initialData={{ ...firstPage(1), items: [post('post-1'), post('recipe-1', true)] }}
          profilePath="/creators/creator-name"
        />
      );

      fireEvent.click(screen.getByRole('tab', { name: /recipes 1/i }));
      fireEvent.click(screen.getAllByRole('button', { name: /post recipe-1/i })[0]);

      expect(await screen.findByTestId('reel-has-more')).toHaveTextContent('false');
    });
  });

  // Saved state: the save hook looks up the first page alone; every later
  // page and a linked post carry the viewer's `isSaved` from the API.
  describe('saved posts past the first page', () => {
    const signIn = () => {
      authState.session = { access_token: 'viewer-token' };
      authState.user = { id: 'viewer-1' };
    };

    it("draws a later page's saved posts as saved, read with the viewer's token", async () => {
      vi.stubGlobal('IntersectionObserver', undefined);
      signIn();
      const fetchMock = vi.fn(async (url: string) => {
        if (url.startsWith('/api/showcase/saved-state')) return { ok: true, status: 200, json: async () => [] };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: initialData.profile,
            items: [
              { ...items[0], id: 'item-3', title: 'Saved Frame', isSaved: true },
              { ...items[0], id: 'item-4', title: 'Unsaved Frame', isSaved: false },
            ],
            pageInfo: { hasMore: false, limit: 24, offset: 24, nextOffset: null, nextLimit: null },
          }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      render(
        <CreatorContentTabs
          initialData={{ ...initialData, pageInfo: { hasMore: true, limit: 24, offset: 0, nextOffset: 24, nextLimit: 24 } }}
          profilePath="/creators/creator-name"
        />
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Load more posts' }));
      fireEvent.click((await screen.findAllByRole('button', { name: /saved frame/i }))[0]);

      expect(await screen.findByTestId('reel-saved')).toHaveTextContent('item-3');
      expect(screen.getByTestId('reel-saved')).not.toHaveTextContent('item-4');
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/creators/creator-name?limit=24&offset=24',
        { headers: { Authorization: 'Bearer viewer-token' } },
      );
    });

    it("saves for the signed-in viewer's account, so its alert may name them once they were told", async () => {
      // Told on an earlier page: the save names its saver, and only the
      // signed-in account's telling counts.
      signIn();
      window.localStorage.setItem('magicbooklet:saver-notice:v1:viewer-1', '1');
      const fetchMock = vi.fn(async (url: string) => {
        if (url === '/api/showcase/save') return { ok: true, status: 200, json: async () => ({ success: true, isSaved: true, saveCount: 1 }) };
        return { ok: true, status: 200, json: async () => (url.startsWith('/api/showcase/saved-state') ? [] : { seen: true }) };
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<CreatorContentTabs initialData={initialData} profilePath="/creators/creator-name" />);

      fireEvent.click((await screen.findAllByRole('button', { name: /campaign frame/i }))[0]);
      fireEvent.click(await screen.findByRole('button', { name: 'Save post' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/showcase/save', expect.objectContaining({
        body: expect.stringContaining('"creatorSeesSaver":true'),
      })));
      window.localStorage.clear();
    });

    it('draws a linked post the viewer saved as saved', async () => {
      signIn();
      searchState.search = '?post=item-linked';
      window.history.replaceState(null, '', '/creators/creator-name?post=item-linked');
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.startsWith('/api/showcase/saved-state')) return { ok: true, status: 200, json: async () => [] };
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, item: { ...items[0], id: 'item-linked', isSaved: true } }),
        };
      }));
      render(<CreatorContentTabs initialData={initialData} profilePath="/creators/creator-name" />);

      await waitFor(() => expect(screen.getByTestId('reel-saved')).toHaveTextContent('item-linked'));
    });
  });

  // The server draws Posts. Reading the hash while hydrating drew another tab
  // over the server's markup on a `#creator-unlocks` link.
  it('picks the tab a link names once hydrated, without a mismatch', async () => {
    window.history.replaceState(null, '', '/creators/creator-name');
    const container = document.createElement('div');
    container.innerHTML = renderToString(
      <CreatorContentTabs initialData={initialData} profilePath="/creators/creator-name" />
    );
    document.body.appendChild(container);
    window.history.replaceState(null, '', '/creators/creator-name#creator-unlocks');
    const recoverableErrors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      root = hydrateRoot(
        container,
        <CreatorContentTabs initialData={initialData} profilePath="/creators/creator-name" />,
        { onRecoverableError: (error) => recoverableErrors.push(error) },
      );
    });

    expect(recoverableErrors).toEqual([]);
    expect(within(container).getByRole('tab', { name: /recipes 3/i })).toHaveAttribute('aria-selected', 'true');
    expect(within(container).getByText('Workflow Breakdown')).toBeInTheDocument();
    expect(within(container).queryByText('Campaign Frame')).not.toBeInTheDocument();

    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });
});
