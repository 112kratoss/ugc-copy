import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreatorContentTabs } from '@/app/creators/[username]/CreatorContentTabs';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import type { CreatorProfilePageData } from '@/lib/creator-profile';
import type { ShowcaseFeedItem } from '@/lib/showcase';

const routerPush = vi.fn();
const routerReplace = vi.fn();
const authState = vi.hoisted(() => ({
  session: null as { access_token: string } | null,
  user: null as { id: string } | null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/creators/creator-name',
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(),
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
    onFeedback,
    onReportContent,
    onReportUser,
    onBlockUser,
    originLabel,
  }: {
    isOpen: boolean;
    items: ShowcaseFeedItem[];
    selectedItemId: string | null;
    originLabel?: string;
    onFeedback?: unknown;
    onReportContent?: ReelHandler;
    onReportUser?: ReelHandler;
    onBlockUser?: ReelHandler;
  }) => {
    const openItem = reelItems.find((candidate) => candidate.id === selectedItemId);
    return isOpen ? (
      <div role="dialog" aria-label="Creator immersive viewer">
        <span>{selectedItemId}</span>
        <span>Closes to {originLabel ?? 'Explore'}</span>
        {onFeedback ? <button type="button">Feed rows</button> : null}
        {openItem && onReportContent ? <button type="button" onClick={() => void onReportContent(openItem)}>Report content</button> : null}
        {openItem && onReportUser ? <button type="button" onClick={() => void onReportUser(openItem)}>Report user</button> : null}
        {openItem && onBlockUser ? <button type="button" onClick={() => void onBlockUser(openItem)}>Block user</button> : null}
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
});
