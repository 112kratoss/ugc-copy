import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreatorProfilePageData } from '@/lib/creator-profile';
import { clearOwnerPageEditsForTests, rememberOwnerCreatorProfile } from '@/lib/owner-page-edits';
import { PUBLIC_PAGE_REVALIDATE_SECONDS } from '@/lib/public-page-cache';

const mocks = vi.hoisted(() => ({
  // The page is one cached render for everyone (ISR): a read of the request's
  // headers, its cookies or the server's session would make it render per
  // request again, and could put one viewer's page in front of everyone.
  requestTimeRead: vi.fn((what: string) => {
    throw new Error(`The creator page read ${what}: it must stay one cached render for everyone`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  getCreatorProfilePageData: vi.fn(),
  search: { current: '' },
  clientAuth: {
    current: { session: null, user: null } as {
      session: { access_token: string } | null;
      user: { id: string; is_anonymous?: boolean } | null;
    },
  },
}));

vi.mock('next/headers', () => ({
  headers: () => mocks.requestTimeRead('the request headers'),
  cookies: () => mocks.requestTimeRead('the request cookies'),
}));

vi.mock('next/navigation', () => ({
  notFound: () => mocks.notFound(),
  useSearchParams: () => new URLSearchParams(mocks.search.current),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => mocks.requestTimeRead("the viewer's session"),
}));

vi.mock('@/lib/creator-profile', () => ({
  getCreatorProfilePageData: (username: string, options: unknown) => mocks.getCreatorProfilePageData(username, options),
}));

vi.mock('@/components/AuthProvider', () => ({
  // `OptionalAuth`: the page resolves the session in the browser.
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mocks.clientAuth.current,
}));

vi.mock('@/app/creators/[username]/ProfileActions', () => ({
  ProfileActions: ({ profile, blockedByViewer }: { profile: { username: string }; blockedByViewer?: boolean }) => (
    <div data-testid="profile-actions" data-blocked={String(Boolean(blockedByViewer))}>{profile.username}</div>
  ),
}));

vi.mock('@/app/creators/[username]/CreatorContentTabs', () => ({
  CreatorContentTabs: ({ initialData }: { initialData: CreatorProfilePageData }) => (
    <div data-testid="creator-content-tabs">{initialData.items.map((item) => item.id).join(',')}</div>
  ),
}));

vi.mock('@/app/creators/[username]/BlockedCreatorPanel', () => ({
  BlockedCreatorPanel: ({ creatorId, username, onUnblocked }: {
    creatorId: string;
    username: string;
    onUnblocked?: () => void;
  }) => (
    <div data-testid="blocked-creator-panel">
      {`${creatorId}:${username}`}
      <button type="button" onClick={onUnblocked}>Unblock</button>
    </div>
  ),
}));

import * as pageModule from '@/app/creators/[username]/page';

const { default: CreatorPage, generateMetadata } = pageModule;

const profile: CreatorProfilePageData['profile'] = {
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
};

function pageData(profileOverrides: Partial<CreatorProfilePageData['profile']> = {}): CreatorProfilePageData {
  return {
    profile: { ...profile, ...profileOverrides },
    stats: {
      publicCreations: 3,
      totalSaves: 1234,
      totalRemixes: 5,
      unlocks: 1,
      totalUnlockSales: 2,
      toolsUsed: [],
    },
    items: [{ id: 'post-1' }, { id: 'post-2' }] as CreatorProfilePageData['items'],
    pageInfo: { hasMore: false, nextLimit: null, nextOffset: null, limit: 24, offset: 0 },
  };
}

/** Only the browser knows who is looking: the server's render is everyone's. */
function signIn(viewerId = 'viewer-1') {
  mocks.clientAuth.current = { session: { access_token: 'viewer-token' }, user: { id: viewerId } };
}

/**
 * How the page's own API answers the viewer (`GET /api/creators/{username}`):
 * missing for a viewer the creator blocked, `viewer.blockedByViewer` for one
 * who blocked the creator. The share visit is answered as recorded.
 */
function answerCreatorRead(answer: 'clear' | 'viewer-blocked-creator' | 'creator-blocked-viewer' | 'failed') {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
    if (url.startsWith('/api/creators/')) {
      if (answer === 'creator-blocked-viewer') return reply({ error: 'Creator not found.' }, 404);
      if (answer === 'failed') return reply({ error: 'Failed to fetch creator profile.' }, 500);
      return reply({
        ...pageData(),
        items: [],
        viewer: { isOwner: false, isFollowing: false, blockedByViewer: answer === 'viewer-blocked-creator' },
      });
    }
    return reply({ success: true });
  }));
}

function requestsTo(prefix: string) {
  return vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith(prefix));
}

function shareVisitsSent() {
  return requestsTo('/api/profile/share').map(([, init]) => ({
    body: JSON.parse(String(init?.body)),
    authorization: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
  }));
}

const openPage = () => CreatorPage({ params: Promise.resolve({ username: 'creator-name' }) });

const renderPage = async () => render(await openPage());

describe('creator page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.search.current = '';
    mocks.clientAuth.current = { session: null, user: null };
    mocks.getCreatorProfilePageData.mockResolvedValue(pageData());
    answerCreatorRead('clear');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearOwnerPageEditsForTests();
  });

  describe('one cached render for everyone', () => {
    it('is an ISR page with no build-time creators, five minutes as its backstop', async () => {
      expect(pageModule.revalidate).toBe(PUBLIC_PAGE_REVALIDATE_SECONDS);
      await expect(pageModule.generateStaticParams()).resolves.toEqual([]);
    });

    it('reads the creator as a visitor would, once for the metadata and the page, and never the request', async () => {
      signIn();
      mocks.search.current = '?s=creator-profile';
      await renderPage();
      await generateMetadata({ params: Promise.resolve({ username: 'creator-name' }) });
      await waitFor(() => expect(shareVisitsSent()).toHaveLength(1));

      expect(mocks.requestTimeRead).not.toHaveBeenCalled();
      // No country: the cards price recipes in credits, and later pages are the API's.
      for (const [username, options] of mocks.getCreatorProfilePageData.mock.calls) {
        expect(username).toBe('creator-name');
        expect(options).toEqual({ limit: 24, offset: 0 });
      }
    });
  });

  describe('blocks', () => {
    it('asks nothing for a signed-out visitor, and shows the posts', async () => {
      await renderPage();

      expect(screen.getByTestId('creator-content-tabs')).toHaveTextContent('post-1,post-2');
      expect(screen.getByTestId('profile-actions')).toHaveAttribute('data-blocked', 'false');
      expect(requestsTo('/api/creators/')).toEqual([]);
    });

    it('asks nothing for the creator on their own page', async () => {
      signIn('creator-1');
      await renderPage();

      expect(screen.getByTestId('creator-content-tabs')).toBeInTheDocument();
      expect(requestsTo('/api/creators/')).toEqual([]);
    });

    it('draws the not-found page for a viewer the creator blocked, title included', async () => {
      signIn();
      answerCreatorRead('creator-blocked-viewer');
      await renderPage();

      expect(await screen.findByRole('heading', { level: 1, name: 'Creator not found' })).toBeInTheDocument();
      expect(document.title).toBe('Creator Not Found | Magic Booklet');
      expect(screen.queryByTestId('creator-content-tabs')).not.toBeInTheDocument();
      expect(screen.queryByText('Creator bio')).not.toBeInTheDocument();
      // The page's own API, with the viewer's session, one post only.
      const [[url, init]] = requestsTo('/api/creators/');
      expect(url).toBe('/api/creators/creator-name?limit=1&offset=0');
      expect(init?.headers).toEqual({ Authorization: 'Bearer viewer-token' });
    });

    it('shows a viewer who blocked the creator whom they blocked, with Unblock and none of the posts', async () => {
      signIn();
      answerCreatorRead('viewer-blocked-creator');
      await renderPage();

      expect(await screen.findByTestId('blocked-creator-panel')).toHaveTextContent('creator-1:creator-name');
      expect(screen.getByRole('heading', { level: 1, name: 'Creator Name' })).toBeInTheDocument();
      expect(screen.getByText('1,234')).toBeInTheDocument();
      expect(screen.getByTestId('profile-actions')).toHaveAttribute('data-blocked', 'true');
      expect(screen.queryByTestId('creator-content-tabs')).not.toBeInTheDocument();

      // Unblocking brings the posts and Follow back: the server's render is
      // everyone's, so drawing it again would not.
      fireEvent.click(screen.getByRole('button', { name: 'Unblock' }));
      expect(screen.getByTestId('creator-content-tabs')).toHaveTextContent('post-1,post-2');
      expect(screen.getByTestId('profile-actions')).toHaveAttribute('data-blocked', 'false');
    });

    it('shows a signed-in viewer with no block the posts', async () => {
      signIn();
      await renderPage();

      await waitFor(() => expect(requestsTo('/api/creators/')).toHaveLength(1));
      expect(screen.getByTestId('creator-content-tabs')).toHaveTextContent('post-1,post-2');
      expect(screen.queryByTestId('blocked-creator-panel')).not.toBeInTheDocument();
    });

    it('leaves the page as everyone sees it when the read fails', async () => {
      signIn();
      answerCreatorRead('failed');
      await renderPage();

      await waitFor(() => expect(requestsTo('/api/creators/')).toHaveLength(1));
      expect(screen.getByTestId('creator-content-tabs')).toBeInTheDocument();
    });

    it('answers not found for an unknown handle', async () => {
      mocks.getCreatorProfilePageData.mockResolvedValue(null);

      await expect(openPage()).rejects.toThrow('NEXT_NOT_FOUND');
      await expect(generateMetadata({ params: Promise.resolve({ username: 'creator-name' }) }))
        .resolves.toEqual({ title: 'Creator Not Found' });
    });
  });

  describe('share visits', () => {
    it.each(['creator-profile', 'profile', 'whatsapp'])(
      'sends the visit a link shared as ?s=%s brought, once, for the server to file',
      async (surface) => {
        mocks.search.current = `?s=${surface}`;
        const { rerender } = await renderPage();
        rerender(await openPage());

        // `parseProfileSharePayloadForRoute` files a marker it does not know as
        // the creator page, as the page did before the browser sent it.
        await waitFor(() => expect(shareVisitsSent()).toEqual([{
          body: { username: 'creator-name', eventType: 'share_visit', sourceSurface: surface },
          authorization: null,
        }]));
      },
    );

    it('sends nothing for a visit that did not come from a share', async () => {
      await renderPage();

      expect(screen.getByTestId('creator-content-tabs')).toBeInTheDocument();
      expect(shareVisitsSent()).toEqual([]);
    });

    // A shared profile link carries its sharer's invite, `?r=<code>`, recorded
    // here for a visitor with no account, as the post page records it.
    describe('the invite a shared profile link carries', () => {
      const CODE = '30b5f916c7aa';
      const inviteVisitsSent = () => requestsTo('/api/referrals/visit').map(([, init]) => ({
        body: JSON.parse(String(init?.body)),
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
      }));

      it('is recorded once for a visitor, with the creator page as where it led', async () => {
        mocks.search.current = `?s=profile&r=${CODE}`;
        const { rerender } = await renderPage();
        rerender(await openPage());

        await waitFor(() => expect(inviteVisitsSent()).toEqual([{
          body: { code: CODE, source: 'web', next: '/creators/creator-name' },
          authorization: null,
        }]));
        expect(shareVisitsSent()).toHaveLength(1);
      });

      it('is recorded for a guest and not for an account that exists', async () => {
        mocks.search.current = `?s=creator-profile&r=${CODE}`;
        mocks.clientAuth.current = { session: { access_token: 'guest-token' }, user: { id: 'guest-1', is_anonymous: true } };
        const guest = await renderPage();
        await waitFor(() => expect(inviteVisitsSent()).toHaveLength(1));
        guest.unmount();

        vi.mocked(fetch).mockClear();
        signIn();
        await renderPage();
        await waitFor(() => expect(shareVisitsSent()).toHaveLength(1));
        expect(inviteVisitsSent()).toEqual([]);
      });

      it('sends nothing for a link with no invite on it', async () => {
        mocks.search.current = '?s=profile&r=nope';
        await renderPage();

        await waitFor(() => expect(shareVisitsSent()).toHaveLength(1));
        expect(inviteVisitsSent()).toEqual([]);
      });
    });

    it("sends a signed-in viewer's visit with their session, so none is recorded across a block", async () => {
      signIn();
      answerCreatorRead('viewer-blocked-creator');
      mocks.search.current = '?s=creator-profile';
      await renderPage();

      await waitFor(() => expect(shareVisitsSent()).toEqual([{
        body: { username: 'creator-name', eventType: 'share_visit', sourceSurface: 'creator-profile' },
        authorization: 'Bearer viewer-token',
      }]));
    });
  });

  describe('header', () => {
    it('labels the saves stat "Saves", as the app does', async () => {
      await renderPage();

      expect(screen.getByText('Saves')).toBeInTheDocument();
      expect(screen.queryByText('Saves received')).not.toBeInTheDocument();
    });

    it('opens each social pill on its own platform, and drops a stored link to anywhere else', async () => {
      mocks.getCreatorProfilePageData.mockResolvedValue(pageData({
        instagramHandle: 'luna.art',
        // Saved before handles were checked: a link on the platform's own host
        // gives its handle, never a URL pasted after the platform's.
        tiktokHandle: 'https://www.tiktok.com/@dance_crew',
        twitterHandle: 'https://evil.example/login',
      }));

      await renderPage();

      expect(screen.getByRole('link', { name: 'Instagram' })).toHaveAttribute('href', 'https://instagram.com/luna.art');
      expect(screen.getByRole('link', { name: 'TikTok' })).toHaveAttribute('href', 'https://tiktok.com/@dance_crew');
      expect(screen.queryByRole('link', { name: 'X' })).not.toBeInTheDocument();
    });

    // A profile save invalidates the page only after its answer was sent, so
    // the refresh it starts, and the router's copy of the page, can be the
    // page as it was: the creator sees what the save answered with.
    it('shows the creator the profile they just saved while the cached page still has the old one', async () => {
      signIn('creator-1');
      const view = await renderPage();
      expect(screen.getByRole('heading', { level: 1, name: 'Creator Name' })).toBeInTheDocument();

      act(() => rememberOwnerCreatorProfile({
        id: 'creator-1',
        username: 'creator-name',
        displayName: 'New Name',
        bio: 'New bio',
        avatarUrl: '',
        coverUrl: '',
        websiteUrl: '',
        twitterHandle: '',
        instagramHandle: 'new.art',
        tiktokHandle: '',
        location: 'Pune',
        credits: 120,
      }));
      view.rerender(await openPage());

      expect(screen.getByRole('heading', { level: 1, name: 'New Name' })).toBeInTheDocument();
      expect(screen.getByText('New bio')).toBeInTheDocument();
      expect(screen.getByText('Pune')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Instagram' })).toHaveAttribute('href', 'https://instagram.com/new.art');
      expect(screen.queryByText('Creator bio')).not.toBeInTheDocument();
      // The totals are still the server's.
      expect(screen.getByText('1,234')).toBeInTheDocument();

      // Anyone else, in the same tab, gets the page as it was cached.
      cleanup();
      signIn('viewer-1');
      await renderPage();
      expect(screen.getByRole('heading', { level: 1, name: 'Creator Name' })).toBeInTheDocument();
      cleanup();
      mocks.clientAuth.current = { session: null, user: null };
      await renderPage();
      expect(screen.getByRole('heading', { level: 1, name: 'Creator Name' })).toBeInTheDocument();
      expect(screen.getByText('Creator bio')).toBeInTheDocument();
    });

    it('drops a pill whose stored value is no handle at all', async () => {
      mocks.getCreatorProfilePageData.mockResolvedValue(pageData({ instagramHandle: 'my insta/page?x=1' }));

      await renderPage();

      expect(screen.queryByRole('link', { name: 'Instagram' })).not.toBeInTheDocument();
    });

    it('titles the page with the creator, and keeps a creator with no posts out of the index', async () => {
      await expect(generateMetadata({ params: Promise.resolve({ username: 'creator-name' }) }))
        .resolves.toMatchObject({ title: 'Creator Name (@creator-name)' });

      mocks.getCreatorProfilePageData.mockResolvedValue({
        ...pageData(),
        stats: { ...pageData().stats, publicCreations: 0 },
      });
      const metadata = await generateMetadata({ params: Promise.resolve({ username: 'creator-name' }) });
      expect(metadata.robots).toMatchObject({ index: false });
    });
  });
});
