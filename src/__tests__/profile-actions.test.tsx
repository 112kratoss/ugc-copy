import type { HTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfileActions } from '@/app/creators/[username]/ProfileActions';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import type { EditableCreatorProfile } from '@/lib/profile';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import {
  buildShowcaseClientCacheKey,
  clearShowcaseClientCacheForTests,
  readShowcaseClientSnapshot,
  writeShowcaseClientSnapshot,
} from '@/lib/showcase-client-cache';

const mockPush = vi.fn();
const mockReplace = vi.fn();
const supabaseMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

let followState = false;
let fetchMock: ReturnType<typeof vi.fn>;

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    refresh: vi.fn(),
  }),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

vi.mock('@/app/creations/CreatorProfileCard', () => ({
  default: () => <div data-testid="creator-profile-card" />,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: supabaseMocks.getSession,
    },
  },
}));

const profile: EditableCreatorProfile = {
  id: 'creator-1',
  username: 'creator-name',
  displayName: 'Creator Name',
  bio: 'Profile bio',
  avatarUrl: '',
  coverUrl: '',
  websiteUrl: '',
  twitterHandle: '',
  instagramHandle: '',
  tiktokHandle: '',
  location: '',
  credits: 10,
};

describe('ProfileActions', () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockReplace.mockReset();
    resetFeedbackState();
    clearShowcaseClientCacheForTests();
    followState = false;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/profile/follow?')) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer viewer-token' });
        return {
          ok: true,
          json: async () => ({ following: followState }),
        };
      }

      if (url === '/api/profile/follow') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { following?: boolean };
        followState = Boolean(body.following);
        return {
          ok: true,
          json: async () => ({ following: followState }),
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('toggles follow state for a logged-in non-owner', async () => {
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'viewer-token',
          user: { id: 'viewer-1' },
        },
      },
    });

    render(<ProfileActions profile={profile} />);

    const followButton = await screen.findByRole('button', { name: /^follow$/i });
    fireEvent.click(followButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/profile/follow', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer viewer-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ followingId: profile.id, following: true }),
      }));
    });
    expect(await screen.findByRole('button', { name: /^following$/i })).toBeInTheDocument();
  });

  it('toggles from following to follow for a logged-in non-owner', async () => {
    followState = true;
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'viewer-token',
          user: { id: 'viewer-1' },
        },
      },
    });

    render(<ProfileActions profile={profile} />);

    const followingButton = await screen.findByRole('button', { name: /^following$/i });
    expect(followingButton).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(followingButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/profile/follow', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ followingId: profile.id, following: false }),
      }));
    });
    expect(await screen.findByRole('button', { name: /^follow$/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows loading feedback while follow is pending', async () => {
    let resolveFollow: (value: Response) => void = () => undefined;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/profile/follow?')) {
        return {
          ok: true,
          json: async () => ({ following: false }),
        };
      }

      if (url === '/api/profile/follow') {
        return new Promise((resolve) => {
          resolveFollow = resolve;
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'viewer-token',
          user: { id: 'viewer-1' },
        },
      },
    });

    render(<ProfileActions profile={profile} />);

    fireEvent.click(await screen.findByRole('button', { name: /^follow$/i }));

    const loadingButton = await screen.findByRole('button', { name: /following\.\.\./i });
    expect(loadingButton).toBeDisabled();
    expect(screen.getAllByText('Following creator...').length).toBeGreaterThan(0);

    resolveFollow({
      ok: true,
      json: async () => ({ following: true }),
    } as Response);
    expect(await screen.findByRole('button', { name: /^following$/i })).toBeInTheDocument();
  });

  it('restores the previous follow state when the update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/profile/follow?')) {
        return {
          ok: true,
          json: async () => ({ following: false }),
        };
      }

      return {
        ok: false,
        json: async () => ({ error: 'Insert failed' }),
      };
    });
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'viewer-token',
          user: { id: 'viewer-1' },
        },
      },
    });

    render(<ProfileActions profile={profile} />);

    fireEvent.click(await screen.findByRole('button', { name: /^follow$/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/previous state was restored/i).length).toBeGreaterThan(0);
    });
    expect(await screen.findByRole('button', { name: /^follow$/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps owners on edit profile instead of follow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: profile.id,
        username: profile.username,
        suggestedUsername: profile.username,
        displayName: profile.displayName,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        coverUrl: profile.coverUrl,
        websiteUrl: profile.websiteUrl,
        twitterHandle: profile.twitterHandle,
        instagramHandle: profile.instagramHandle,
        tiktokHandle: profile.tiktokHandle,
        location: profile.location,
        credits: profile.credits,
      }),
    })));
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'owner-token',
          user: { id: profile.id },
        },
      },
    });

    render(<ProfileActions profile={profile} />);

    expect(await screen.findByRole('button', { name: /edit profile/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^follow$/i })).not.toBeInTheDocument();
  });

  it('redirects signed-out visitors to login when they click follow', async () => {
    supabaseMocks.getSession.mockResolvedValue({
      data: {
        session: null,
      },
    });

    render(<ProfileActions profile={profile} />);

    const followButton = await screen.findByRole('button', { name: /^follow$/i });
    fireEvent.click(followButton);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        `/login?returnUrl=${encodeURIComponent('/creators/creator-name')}`
      );
    });
    expect(fetchMock).not.toHaveBeenCalledWith('/api/profile/follow', expect.anything());
  });

  // Report user and Block user, behind a ⋯ as on the app's creator screen. The
  // web's creator page had neither.
  describe('safety menu', () => {
    const viewerSession = {
      data: { session: { access_token: 'viewer-token', user: { id: 'viewer-1' } } },
    };
    const moderationRequests = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/moderation/'));
    const toasts = () => readFeedbackSnapshot().toasts.map(({ tone, message }) => ({ tone, message }));
    const answerModeration = (ok = true) => {
      const answerFollow = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<unknown>;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (
        url.startsWith('/api/moderation/')
          ? { ok, status: ok ? 200 : 500, json: async () => (ok ? { success: true } : { error: 'Failed to block user.' }) }
          : answerFollow(url, init)
      ));
    };
    const openMenu = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'More actions for @creator-name' }));
    };
    // What Explore kept for coming back to: two posts, one of them this creator's.
    const exploreKey = buildShowcaseClientCacheKey({
      viewerId: 'viewer-1',
      category: 'all',
      sort: 'for-you',
      tool: null,
      unlock: 'all',
      resource: 'all',
    });
    const keepExploreSnapshot = () => {
      writeShowcaseClientSnapshot(exploreKey, {
        feed: {
          items: [
            { id: 'theirs', creator: { id: 'creator-1' } },
            { id: 'someone-elses', creator: { id: 'creator-9' } },
          ] as ShowcaseFeedItem[],
          pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 0 },
        },
        renderedItemCount: 2,
        savedItemIds: [],
      });
    };
    const keptExplorePosts = () => readShowcaseClientSnapshot(exploreKey)?.feed.items.map((item) => item.id);

    it('offers a visitor Report user and Block user, and nothing about a feed', async () => {
      supabaseMocks.getSession.mockResolvedValue(viewerSession);
      render(<ProfileActions profile={profile} />);

      await openMenu();

      const rows = screen.getAllByRole('menuitem').map((row) => row.querySelector('.font-semibold')?.textContent);
      expect(rows).toEqual(['Report user', 'Block user']);
      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
      // In the body: the card around the page's header clips what it holds.
      expect(screen.getByRole('menu').parentElement).toBe(document.body);
      // Its button is one of the row's outlined pills, at the height of Follow and Share.
      const trigger = screen.getByRole('button', { name: 'More actions for @creator-name' });
      expect(trigger.className).toContain('h-11 w-11');
      expect(trigger.className).toContain('border-white/10 bg-white/[0.05]');
      expect(screen.getByRole('button', { name: /^follow$/i }).className).toContain('min-h-11');
    });

    it('is not on your own page', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
      supabaseMocks.getSession.mockResolvedValue({
        data: { session: { access_token: 'owner-token', user: { id: profile.id } } },
      });
      render(<ProfileActions profile={profile} />);

      expect(await screen.findByRole('button', { name: /edit profile/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /more actions for/i })).not.toBeInTheDocument();
    });

    it('waits to know whose page it is before it shows', () => {
      supabaseMocks.getSession.mockReturnValue(new Promise(() => undefined));
      render(<ProfileActions profile={profile} />);

      expect(screen.getByRole('button', { name: /share/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /more actions for/i })).not.toBeInTheDocument();
    });

    it('sends a signed-out visitor to sign in, and asks and sends nothing', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      supabaseMocks.getSession.mockResolvedValue({ data: { session: null } });
      render(<ProfileActions profile={profile} />);

      await openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: /block user/i }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(`/login?returnUrl=${encodeURIComponent('/creators/creator-name')}`);
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(moderationRequests()).toHaveLength(0);
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it("reports the creator as the app's creator screen files it, and stays on the page", async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      supabaseMocks.getSession.mockResolvedValue(viewerSession);
      answerModeration();
      render(<ProfileActions profile={profile} />);

      await openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: /report user/i }));

      await waitFor(() => expect(moderationRequests()).toHaveLength(1));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Report this creator?'));
      const [url, init] = moderationRequests()[0];
      expect(url).toBe('/api/moderation/reports');
      expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer viewer-token' } });
      expect(JSON.parse(String(init.body))).toEqual({
        targetType: 'user',
        targetId: 'creator-1',
        reason: 'unsafe_content',
        sourceSurface: 'creator-profile',
        details: "Reported from the creator's page on the web.",
      });
      await waitFor(() => expect(toasts()).toEqual([
        { tone: 'success', message: 'Creator reported. Our moderation team will take a look.' },
      ]));
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('blocks the creator, says so, and leaves for Explore', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      supabaseMocks.getSession.mockResolvedValue(viewerSession);
      answerModeration();
      keepExploreSnapshot();
      render(<ProfileActions profile={profile} />);

      await openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: /block user/i }));

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/showcase'));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Block this creator?'));
      const [url, init] = moderationRequests()[0];
      expect(url).toBe('/api/moderation/blocks/creator-1');
      expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer viewer-token' } });
      expect(toasts()).toEqual([
        { tone: 'success', message: 'Creator Name is blocked. Their posts are gone from your feed.' },
      ]);
      // Explore, where the viewer lands, restores what it kept: their posts are out of that too.
      expect(keptExplorePosts()).toEqual(['someone-elses']);
    });

    it('sends nothing and stays when the question is declined', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      supabaseMocks.getSession.mockResolvedValue(viewerSession);
      answerModeration();
      keepExploreSnapshot();
      render(<ProfileActions profile={profile} />);

      await openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: /block user/i }));

      await waitFor(() => expect(window.confirm).toHaveBeenCalled());
      expect(moderationRequests()).toHaveLength(0);
      expect(toasts()).toEqual([]);
      expect(mockReplace).not.toHaveBeenCalled();
      expect(keptExplorePosts()).toEqual(['theirs', 'someone-elses']);
    });

    it('stays on the page and says why when the block fails', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      supabaseMocks.getSession.mockResolvedValue(viewerSession);
      answerModeration(false);
      keepExploreSnapshot();
      render(<ProfileActions profile={profile} />);

      await openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: /block user/i }));

      await waitFor(() => expect(toasts()).toEqual([
        { tone: 'error', message: 'Could not block this creator. Failed to block user.' },
      ]));
      expect(mockReplace).not.toHaveBeenCalled();
      // Nobody was blocked, so nothing is taken out of what Explore kept.
      expect(keptExplorePosts()).toEqual(['theirs', 'someone-elses']);
    });
  });
});
