import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreatorProfilePageData } from '@/lib/creator-profile';

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  cookies: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  after: vi.fn(),
  getServerAuthState: vi.fn(),
  getCreatorProfileSummary: vi.fn(),
  getCreatorProfilePageData: vi.fn(),
  getCreatorPublicPostCount: vi.fn(),
  loadCreatorBlockRelationship: vi.fn(),
  recordProfileShareEvent: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: () => mocks.headers(),
  cookies: () => mocks.cookies(),
}));

vi.mock('next/navigation', () => ({
  notFound: () => mocks.notFound(),
}));

// `after` throws outside a request scope; run the deferred work at once so the
// recorder's call can be read.
vi.mock('next/server', () => ({
  after: (work: unknown) => {
    mocks.after(work);
    if (typeof work === 'function') void (work as () => unknown)();
  },
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => mocks.getServerAuthState(),
}));

vi.mock('@/lib/creator-profile', () => ({
  getCreatorProfileSummary: (username: string) => mocks.getCreatorProfileSummary(username),
  getCreatorProfilePageData: (username: string, options: unknown) => mocks.getCreatorProfilePageData(username, options),
  getCreatorPublicPostCount: (userId: string) => mocks.getCreatorPublicPostCount(userId),
  loadCreatorBlockRelationship: (input: unknown) => mocks.loadCreatorBlockRelationship(input),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ service: true }),
}));

vi.mock('@/lib/profile-share-events', () => ({
  recordProfileShareEvent: (payload: unknown) => mocks.recordProfileShareEvent(payload),
}));

// The auth wrapper is an async server component; the page's own block check is
// what these tests read.
vi.mock('@/components/RouteAuthBoundary', () => ({
  RequestHintedOptionalAuth: ({ children }: { children: ReactNode }) => <div data-testid="hinted-auth">{children}</div>,
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
  BlockedCreatorPanel: ({ creatorId, username }: { creatorId: string; username: string }) => (
    <div data-testid="blocked-creator-panel">{`${creatorId}:${username}`}</div>
  ),
}));

import CreatorPage, { generateMetadata } from '@/app/creators/[username]/page';

const SESSION_COOKIE = 'sb-abcdefgh-auth-token';

function cookieStore(entries: Record<string, string>) {
  return {
    getAll: () => Object.entries(entries).map(([name, value]) => ({ name, value })),
    get: (name: string) => (name in entries ? { name, value: entries[name] } : undefined),
  };
}

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

function signIn(viewerId = 'viewer-1') {
  mocks.cookies.mockResolvedValue(cookieStore({ [SESSION_COOKIE]: 'token' }));
  mocks.getServerAuthState.mockResolvedValue({ session: { user: { id: viewerId } }, credits: 0 });
}

function blocks(relationship: { creatorBlockedViewer: boolean; viewerBlockedCreator: boolean }) {
  mocks.loadCreatorBlockRelationship.mockResolvedValue(relationship);
}

const openPage = (searchParams: Record<string, string> = {}) => CreatorPage({
  params: Promise.resolve({ username: 'creator-name' }),
  searchParams: Promise.resolve(searchParams),
});

const renderPage = async (searchParams: Record<string, string> = {}) => render(await openPage(searchParams));

describe('creator page (server render)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefgh.supabase.co');
    mocks.headers.mockResolvedValue(new Headers());
    mocks.cookies.mockResolvedValue(cookieStore({}));
    mocks.getServerAuthState.mockResolvedValue({ session: null, credits: null });
    mocks.getCreatorProfileSummary.mockResolvedValue({ ...profile });
    mocks.getCreatorProfilePageData.mockResolvedValue(pageData());
    mocks.getCreatorPublicPostCount.mockResolvedValue(3);
    blocks({ creatorBlockedViewer: false, viewerBlockedCreator: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('blocks', () => {
    it('reads no session and no blocks for a signed-out visitor, and shows the posts', async () => {
      await renderPage();

      expect(screen.getByTestId('creator-content-tabs')).toHaveTextContent('post-1,post-2');
      expect(screen.getByTestId('profile-actions')).toHaveAttribute('data-blocked', 'false');
      expect(mocks.getServerAuthState).not.toHaveBeenCalled();
      expect(mocks.loadCreatorBlockRelationship).not.toHaveBeenCalled();
    });

    it('answers not found to a viewer the creator blocked, title included', async () => {
      signIn();
      blocks({ creatorBlockedViewer: true, viewerBlockedCreator: false });

      await expect(openPage()).rejects.toThrow('NEXT_NOT_FOUND');
      expect(mocks.loadCreatorBlockRelationship).toHaveBeenCalledWith({
        adminSupabase: { service: true },
        creatorId: 'creator-1',
        viewerUserId: 'viewer-1',
      });

      await expect(generateMetadata({ params: Promise.resolve({ username: 'creator-name' }) }))
        .resolves.toEqual({ title: 'Creator Not Found' });
    });

    it('answers not found when each blocked the other', async () => {
      signIn();
      blocks({ creatorBlockedViewer: true, viewerBlockedCreator: true });

      await expect(openPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('shows a viewer who blocked the creator whom they blocked, with Unblock and none of the posts', async () => {
      signIn();
      blocks({ creatorBlockedViewer: false, viewerBlockedCreator: true });

      await renderPage();

      expect(screen.getByRole('heading', { level: 1, name: 'Creator Name' })).toBeInTheDocument();
      expect(screen.getByText('1,234')).toBeInTheDocument();
      expect(screen.getByTestId('blocked-creator-panel')).toHaveTextContent('creator-1:creator-name');
      expect(screen.getByTestId('profile-actions')).toHaveAttribute('data-blocked', 'true');
      expect(screen.queryByTestId('creator-content-tabs')).not.toBeInTheDocument();
      expect(document.body).not.toHaveTextContent('post-1');
      // Their name still heads the tab for the person who blocked them.
      const metadata = await generateMetadata({ params: Promise.resolve({ username: 'creator-name' }) });
      expect(metadata.title).toBe('Creator Name (@creator-name)');
    });

    it('shows a signed-in viewer with no block the posts', async () => {
      signIn();

      await renderPage();

      expect(screen.getByTestId('creator-content-tabs')).toHaveTextContent('post-1,post-2');
      expect(screen.queryByTestId('blocked-creator-panel')).not.toBeInTheDocument();
      expect(mocks.loadCreatorBlockRelationship).toHaveBeenCalledTimes(1);
    });

    it('fails the page, never shows it unblocked, when the block read fails', async () => {
      signIn();
      mocks.loadCreatorBlockRelationship.mockRejectedValue(new Error('user_blocks read failed'));

      await expect(openPage()).rejects.toThrow('user_blocks read failed');
    });

    it('checks no blocks for a cookie that holds no valid session', async () => {
      mocks.cookies.mockResolvedValue(cookieStore({ [SESSION_COOKIE]: 'expired' }));

      await renderPage();

      expect(mocks.getServerAuthState).toHaveBeenCalled();
      expect(mocks.loadCreatorBlockRelationship).not.toHaveBeenCalled();
      expect(screen.getByTestId('creator-content-tabs')).toBeInTheDocument();
    });

    it('checks no blocks for the E2E stand-in session, which has no account', async () => {
      vi.stubEnv('NEXT_PUBLIC_E2E_AUTH_BYPASS', '1');
      mocks.cookies.mockResolvedValue(cookieStore({ [SESSION_COOKIE]: 'token', 'e2e-auth': 'workflow-user' }));

      await renderPage();

      expect(mocks.getServerAuthState).not.toHaveBeenCalled();
      expect(mocks.loadCreatorBlockRelationship).not.toHaveBeenCalled();
    });

    it('answers not found for an unknown handle before reading anything else', async () => {
      mocks.getCreatorProfileSummary.mockResolvedValue(null);

      await expect(openPage()).rejects.toThrow('NEXT_NOT_FOUND');
      expect(mocks.getCreatorProfilePageData).not.toHaveBeenCalled();
    });
  });

  describe('share visits', () => {
    it.each([
      ['creator-profile', 'creator-profile'],
      ['profile', 'profile'],
      // Any other marker is still a shared link, filed as the page it landed on.
      ['whatsapp', 'creator-profile'],
    ])('records a visit from a link shared as ?s=%s, after the response', async (surface, recorded) => {
      await renderPage({ s: surface });

      expect(mocks.after).toHaveBeenCalledTimes(1);
      expect(mocks.after.mock.calls[0][0]).toEqual(expect.any(Function));
      expect(mocks.recordProfileShareEvent).toHaveBeenCalledWith({
        profileUserId: 'creator-1',
        eventType: 'share_visit',
        sourceSurface: recorded,
      });
    });

    it('records nothing for a visit that did not come from a share', async () => {
      await renderPage();

      expect(mocks.after).not.toHaveBeenCalled();
      expect(mocks.recordProfileShareEvent).not.toHaveBeenCalled();
    });

    it.each([
      ['a prefetch', { purpose: 'prefetch' }],
      ['a router prefetch', { 'next-router-prefetch': '1' }],
      // `router.refresh()` after an unblock or a save keeps `?s=` in the address.
      ['an in-app refresh', { rsc: '1' }],
    ])('records nothing for %s', async (_label, requestHeaders) => {
      mocks.headers.mockResolvedValue(new Headers(requestHeaders));

      await renderPage({ s: 'creator-profile' });

      expect(mocks.recordProfileShareEvent).not.toHaveBeenCalled();
    });

    it('records nothing when the viewer blocked the creator', async () => {
      signIn();
      blocks({ creatorBlockedViewer: false, viewerBlockedCreator: true });

      await renderPage({ s: 'creator-profile' });

      expect(mocks.recordProfileShareEvent).not.toHaveBeenCalled();
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

    it('drops a pill whose stored value is no handle at all', async () => {
      mocks.getCreatorProfilePageData.mockResolvedValue(pageData({ instagramHandle: 'my insta/page?x=1' }));

      await renderPage();

      expect(screen.queryByRole('link', { name: 'Instagram' })).not.toBeInTheDocument();
    });
  });
});
