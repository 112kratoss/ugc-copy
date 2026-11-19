import fs from 'node:fs';
import path from 'node:path';

import { Activity, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfileActions } from '@/app/creators/[username]/ProfileActions';
import {
  forgetCreatorProfileEditSheetForTests,
  useLoadedCreatorProfileEditSheet,
} from '@/app/creators/[username]/creator-profile-edit-sheet-loader';
import FeedbackViewport from '@/components/FeedbackViewport';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import { clearOwnerPageEditsForTests, useOwnerCreatorProfile } from '@/lib/owner-page-edits';
import type { EditableCreatorProfile } from '@/lib/profile';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import {
  buildShowcaseClientCacheKey,
  clearShowcaseClientCacheForTests,
  readShowcaseClientSnapshot,
  writeShowcaseClientSnapshot,
} from '@/lib/showcase-client-cache';

// One router for every render, so a test can read what a click asked of it.
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
const mockPush = routerMock.push;
const mockReplace = routerMock.replace;
const supabaseMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));
type ViewerSession = { access_token: string; user: { id: string } };
// Who is looking, as the page's auth provider says (`useAuth`), and whether the browser holds a
// session cookie: the provider is still checking one while `isLoading`.
const authMocks = vi.hoisted(() => ({
  state: { session: null, isLoading: false, cookie: false } as {
    session: ViewerSession | null;
    isLoading: boolean;
    cookie: boolean;
  },
}));

/**
 * The viewer: the provider's session, and the session the client reads at a press, which is the
 * same one unless a test says otherwise.
 */
function viewAs(result: { data: { session: ViewerSession | null } }) {
  authMocks.state = { session: result.data.session, isLoading: false, cookie: result.data.session !== null };
  supabaseMocks.getSession.mockResolvedValue(result);
}

/** A session cookie the provider has not finished checking. */
function stillChecking() {
  authMocks.state = { session: null, isLoading: true, cookie: true };
  supabaseMocks.getSession.mockReturnValue(new Promise(() => undefined));
}

let followState = false;
let fetchMock: ReturnType<typeof vi.fn>;

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...props
    }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement>; initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }) => {
      void _initial;
      void _animate;
      void _exit;
      void _transition;
      return <div {...props}>{children}</div>;
    },
  },
}));

// The editor, as far as the dialog meets it: the profile it was handed, one
// field, and a save. A case can have it fail to draw, which its boundary meets as it meets a
// rejected import of its code (a module mock whose factory throws is not steady under vitest).
const editorDraw = vi.hoisted(() => ({ fails: false }));
vi.mock('@/app/creations/CreatorProfileCard', () => ({
  default: ({ initialProfile, onProfileSaved }: {
    initialProfile: EditableCreatorProfile;
    onProfileSaved?: (profile: EditableCreatorProfile) => void;
  }) => {
    if (editorDraw.fails) throw new Error('Loading chunk app_creators_username_CreatorProfileEditSheet_tsx failed.');
    return (
      <form data-testid="creator-profile-card" data-display-name={initialProfile.displayName}>
        <label>
          Bio
          <input name="bio" defaultValue={initialProfile.bio} />
        </label>
        <button type="button" onClick={() => onProfileSaved?.({ ...initialProfile, bio: 'Saved bio' })}>
          Save changes
        </button>
      </form>
    );
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: supabaseMocks.getSession,
    },
  },
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: authMocks.state.session,
    user: authMocks.state.session?.user ?? null,
    isLoading: authMocks.state.isLoading,
  }),
}));

vi.mock('@/components/useSupabaseAuthCookieHint', () => ({
  useSupabaseAuthCookieHint: () => authMocks.state.cookie,
  useHasHydratedSupabaseAuthCookieHint: () => true,
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
    routerMock.refresh.mockReset();
    resetFeedbackState();
    clearShowcaseClientCacheForTests();
    // A visitor, until a case says who is looking; and no editor loaded yet.
    authMocks.state = { session: null, isLoading: false, cookie: false };
    supabaseMocks.getSession.mockReset();
    forgetCreatorProfileEditSheetForTests();
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
    clearOwnerPageEditsForTests();
  });

  it('toggles follow state for a logged-in non-owner', async () => {
    viewAs({
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
    viewAs({
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
    viewAs({
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
    viewAs({
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
    viewAs({
      data: {
        session: {
          access_token: 'owner-token',
          user: { id: profile.id },
        },
      },
    });

    render(<ProfileActions profile={profile} />);

    expect(await screen.findByRole('button', { name: 'Edit profile' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^follow$/i })).not.toBeInTheDocument();
  });

  it('redirects signed-out visitors to login when they click follow', async () => {
    viewAs({
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

  // Who is looking is the page's auth provider's to say: it loads the Supabase client only for a
  // browser with a session cookie, so a visitor's creator page never fetched it to ask.
  it('knows a visitor from the page auth, and never loads the client for them', async () => {
    render(<ProfileActions profile={profile} />);

    fireEvent.click(await screen.findByRole('button', { name: /^follow$/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(`/login?returnUrl=${encodeURIComponent('/creators/creator-name')}`);
    });
    expect(supabaseMocks.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads whether the viewer follows once, and not again for a renewed token', async () => {
    viewAs({ data: { session: { access_token: 'viewer-token', user: { id: 'viewer-1' } } } });
    const followReads = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/profile/follow?'));
    const { rerender } = render(<ProfileActions profile={profile} />);

    await screen.findByRole('button', { name: /^follow$/i });
    await waitFor(() => expect(followReads()).toHaveLength(1));

    // Supabase renews the token about hourly; the provider hands the page the new one.
    authMocks.state = { ...authMocks.state, session: { access_token: 'renewed-token', user: { id: 'viewer-1' } } };
    rerender(<ProfileActions profile={profile} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(followReads()).toHaveLength(1);
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
      viewAs(viewerSession);
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
      viewAs({
        data: { session: { access_token: 'owner-token', user: { id: profile.id } } },
      });
      render(<ProfileActions profile={profile} />);

      expect(await screen.findByRole('button', { name: /edit profile/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /more actions for/i })).not.toBeInTheDocument();
    });

    it('waits to know whose page it is before it shows', () => {
      stillChecking();
      render(<ProfileActions profile={profile} />);

      expect(screen.getByRole('button', { name: /share/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /more actions for/i })).not.toBeInTheDocument();
    });

    it('sends a signed-out visitor to sign in, and asks and sends nothing', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      viewAs({ data: { session: null } });
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
      viewAs(viewerSession);
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
      viewAs(viewerSession);
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
      viewAs(viewerSession);
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
      viewAs(viewerSession);
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

  // The server render says the viewer blocked this creator; the page's own
  // panel offers Unblock.
  describe('a creator the viewer blocked', () => {
    const viewerSession = {
      data: { session: { access_token: 'viewer-token', user: { id: 'viewer-1' } } },
    };

    it('offers Report user alone: no Follow, no Share, no Block, and reads no follow state', async () => {
      viewAs(viewerSession);
      render(<ProfileActions profile={profile} blockedByViewer />);

      fireEvent.click(screen.getByRole('button', { name: 'More actions for @creator-name' }));

      const rows = screen.getAllByRole('menuitem').map((row) => row.querySelector('.font-semibold')?.textContent);
      expect(rows).toEqual(['Report user']);
      expect(screen.queryByRole('button', { name: /follow/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /edit profile/i })).not.toBeInTheDocument();
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still reports them', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      viewAs(viewerSession);
      fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
      render(<ProfileActions profile={profile} blockedByViewer />);

      fireEvent.click(screen.getByRole('button', { name: 'More actions for @creator-name' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /report user/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/moderation/reports', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer viewer-token' }),
      })));
    });
  });

  // The owner's Edit profile dialog: read when asked for, named, closable from
  // the keyboard, and never throwing edits away without asking.
  describe('the owner editor', () => {
    const ownerSession = {
      data: { session: { access_token: 'owner-token', user: { id: profile.id } } },
    };
    const privateProfile = {
      id: profile.id,
      username: profile.username,
      suggestedUsername: profile.username,
      displayName: 'Private Name',
      bio: 'Private bio',
      avatarUrl: '',
      coverUrl: '',
      websiteUrl: '',
      twitterHandle: '',
      instagramHandle: '',
      tiktokHandle: '',
      location: '',
      credits: 10,
    };
    const profileReads = () => fetchMock.mock.calls.filter(([url]) => url === '/api/profile');
    const answerProfileRead = (answer: () => unknown = () => ({ ok: true, status: 200, json: async () => privateProfile })) => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url === '/api/profile') return answer();
        throw new Error(`Unexpected fetch: ${url}`);
      });
    };
    const openEditor = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Edit profile' }));
      return screen.findByRole('dialog', { name: 'Edit profile' });
    };

    beforeEach(() => {
      viewAs(ownerSession);
    });

    // The editor and framer-motion are code a visitor never needs: the owner's page loads them
    // in its first idle moment, so the first press draws the dialog at once.
    it("loads the editor's code ahead of the owner's press, and no one else's page asks for it", async () => {
      function EditorCode() {
        return <span data-testid="editor-code" data-loaded={String(useLoadedCreatorProfileEditSheet() !== null)} />;
      }
      answerProfileRead();
      viewAs({ data: { session: { access_token: 'viewer-token', user: { id: 'viewer-1' } } } });
      fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ following: false }) }));
      render(<><ProfileActions profile={profile} /><EditorCode /></>);
      await screen.findByRole('button', { name: /^follow$/i });
      // Past the idle wait (80 ms where the browser has no requestIdleCallback, as jsdom).
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      expect(screen.getByTestId('editor-code')).toHaveAttribute('data-loaded', 'false');
      cleanup();

      viewAs(ownerSession);
      answerProfileRead();
      render(<><ProfileActions profile={profile} /><EditorCode /></>);
      expect(screen.getByTestId('editor-code')).toHaveAttribute('data-loaded', 'false');
      await waitFor(() => expect(screen.getByTestId('editor-code')).toHaveAttribute('data-loaded', 'true'));

      // Drawn in the render the press makes.
      fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
      expect(screen.getByRole('dialog', { name: 'Edit profile' })).toBeInTheDocument();
    });

    it('draws the dialog once its code lands, for a press made before it had, and mounts it once', async () => {
      answerProfileRead();
      render(<ProfileActions profile={profile} />);
      // The owner is known in the first render, before the idle moment that loads the editor.
      const edit = screen.getByRole('button', { name: 'Edit profile' });

      fireEvent.click(edit);

      // On its way: the button says so, and nothing is drawn over the page yet.
      expect(edit).toHaveAttribute('aria-busy', 'true');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const dialog = await screen.findByRole('dialog', { name: 'Edit profile' });
      expect(edit).not.toHaveAttribute('aria-busy');
      await waitFor(() => expect(dialog).toHaveFocus());
      expect(await within(dialog).findByTestId('creator-profile-card')).toHaveAttribute('data-display-name', 'Private Name');
      // The dialog the focus went to is still the one on the page: never drawn a second time.
      expect(screen.getByRole('dialog', { name: 'Edit profile' })).toBe(dialog);
      expect(dialog).toHaveFocus();
    });

    it('reads the private profile when Edit profile is pressed, not on the visit', async () => {
      answerProfileRead();
      render(<ProfileActions profile={profile} />);

      await screen.findByRole('button', { name: 'Edit profile' });
      await Promise.resolve();
      expect(profileReads()).toHaveLength(0);

      const dialog = await openEditor();

      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(await within(dialog).findByTestId('creator-profile-card')).toHaveAttribute('data-display-name', 'Private Name');
      expect(profileReads()).toHaveLength(1);
      expect(profileReads()[0][1]).toMatchObject({ headers: { Authorization: 'Bearer owner-token' } });
    });

    it('draws the form only once the read has landed', async () => {
      let answerRead: (value: unknown) => void = () => undefined;
      answerProfileRead(() => new Promise((resolve) => {
        answerRead = resolve;
      }));
      render(<ProfileActions profile={profile} />);

      const dialog = await openEditor();

      expect(within(dialog).getByRole('status', { name: 'Loading your profile' })).toBeInTheDocument();
      expect(within(dialog).queryByTestId('creator-profile-card')).not.toBeInTheDocument();

      answerRead({ ok: true, status: 200, json: async () => privateProfile });

      expect(await within(dialog).findByTestId('creator-profile-card')).toBeInTheDocument();
      expect(within(dialog).queryByRole('status', { name: 'Loading your profile' })).not.toBeInTheDocument();
    });

    it('says when the read fails, and reads again on Try again', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let failing = true;
      answerProfileRead(() => (failing
        ? { ok: false, status: 500, json: async () => ({ error: 'Failed' }) }
        : { ok: true, status: 200, json: async () => privateProfile }));
      render(<ProfileActions profile={profile} />);

      const dialog = await openEditor();

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not load your profile.');
      failing = false;
      fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));

      expect(await within(dialog).findByTestId('creator-profile-card')).toBeInTheDocument();
      expect(profileReads()).toHaveLength(2);
    });

    it('closes from its labelled Close button and from Escape, asking nothing when untouched', async () => {
      const confirm = vi.spyOn(window, 'confirm');
      answerProfileRead();
      render(<ProfileActions profile={profile} />);

      let dialog = await openEditor();
      await within(dialog).findByTestId('creator-profile-card');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit profile' })).toHaveFocus();

      dialog = await openEditor();
      await within(dialog).findByTestId('creator-profile-card');
      fireEvent.keyDown(window, { key: 'Escape' });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(confirm).not.toHaveBeenCalled();
    });

    it('asks before throwing changes away, from Close and from Escape', async () => {
      answerProfileRead();
      render(
        <>
          <ProfileActions profile={profile} />
          <FeedbackViewport />
        </>
      );

      const dialog = await openEditor();
      const bio = await within(dialog).findByRole('textbox', { name: 'Bio' });
      fireEvent.change(bio, { target: { value: 'A new bio' } });

      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      const question = await screen.findByRole('alertdialog', { name: 'Discard your profile changes?' });
      expect(question).toHaveAccessibleDescription('Your edits haven’t been saved and will be lost.');
      fireEvent.click(within(question).getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(screen.getByRole('dialog', { name: 'Edit profile' })).toBeInTheDocument();
      expect(bio).toHaveValue('A new bio');

      fireEvent.keyDown(bio, { key: 'Escape' });
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Edit profile' })).toHaveFocus();
    });

    // The editor's Escape and Tab trap listen on the window, which hears a key
    // after the question has handled it.
    it('leaves the keyboard to its question: Escape answers it, and Tab stays among its buttons', async () => {
      answerProfileRead();
      render(
        <>
          <ProfileActions profile={profile} />
          <FeedbackViewport />
        </>
      );

      const dialog = await openEditor();
      const bio = await within(dialog).findByRole('textbox', { name: 'Bio' });
      fireEvent.change(bio, { target: { value: 'A new bio' } });
      bio.focus();
      fireEvent.keyDown(bio, { key: 'Escape' });

      const question = await screen.findByRole('alertdialog', { name: 'Discard your profile changes?' });
      const keep = within(question).getByRole('button', { name: 'Keep editing' });
      const discard = within(question).getByRole('button', { name: 'Discard changes' });
      await waitFor(() => expect(keep).toHaveFocus());

      // A Tab that does not wrap never reaches the editor's trap beneath,
      // which would pull the focus back into the editor.
      fireEvent.keyDown(keep, { key: 'Tab' });
      expect(keep).toHaveFocus();

      fireEvent.keyDown(keep, { key: 'Tab', shiftKey: true });
      expect(discard).toHaveFocus();
      fireEvent.keyDown(discard, { key: 'Tab' });
      expect(keep).toHaveFocus();

      // Escape answers the question alone: the editor stays, asks nothing
      // more, and has its focus back.
      fireEvent.keyDown(keep, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(screen.getByRole('dialog', { name: 'Edit profile' })).toBeInTheDocument();
      expect(bio).toHaveValue('A new bio');
      expect(bio).toHaveFocus();
    });

    // A save on its way when Close asked: landing, it closes the editor, and
    // the question about that editor goes with it.
    it('takes its discard question down when a save closes the editor while it is up', async () => {
      answerProfileRead();
      render(
        <>
          <ProfileActions profile={profile} />
          <FeedbackViewport />
        </>
      );

      const dialog = await openEditor();
      fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Bio' }), { target: { value: 'Saved bio' } });
      const save = within(dialog).getByRole('button', { name: 'Save changes' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      await screen.findByRole('alertdialog', { name: 'Discard your profile changes?' });

      fireEvent.click(save);

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(screen.queryByRole('dialog', { name: 'Edit profile' })).not.toBeInTheDocument();
      await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
    });

    it('starts each opening unchanged', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      answerProfileRead();
      render(<ProfileActions profile={profile} />);

      let dialog = await openEditor();
      fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Bio' }), { target: { value: 'Draft' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      expect(confirm).toHaveBeenCalledTimes(1);

      dialog = await openEditor();
      await within(dialog).findByTestId('creator-profile-card');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes after a save without asking, and draws the page again', async () => {
      const confirm = vi.spyOn(window, 'confirm');
      // What the page's header reads as the profile (`useCreatorPageProfile`).
      function HeaderBio() {
        return <span data-testid="header-bio">{useOwnerCreatorProfile(profile.id, true)?.bio ?? 'as cached'}</span>;
      }
      answerProfileRead();
      render(
        <>
          <ProfileActions profile={profile} />
          <HeaderBio />
        </>
      );

      const dialog = await openEditor();
      fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Bio' }), { target: { value: 'Saved bio' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(confirm).not.toHaveBeenCalled();
      await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
      // The page is cached for everyone and invalidated only after the save's
      // answer was sent, so that refresh can be served it as it was: the
      // header shows what the save answered with.
      expect(screen.getByTestId('header-bio')).toHaveTextContent('Saved bio');
    });

    // A hidden <Activity> (and Fast Refresh) runs every cleanup, the key
    // listener's included; the effects that run again put it back.
    it('keeps its Escape guard when every effect runs again', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      answerProfileRead();
      const inActivity = (mode: 'visible' | 'hidden') => (
        <Activity mode={mode}>
          <ProfileActions profile={profile} />
        </Activity>
      );
      const { rerender } = render(inActivity('visible'));

      const dialog = await openEditor();
      fireEvent.change(await within(dialog).findByRole('textbox', { name: 'Bio' }), { target: { value: 'Draft' } });
      rerender(inActivity('hidden'));
      rerender(inActivity('visible'));

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('dialog', { name: 'Edit profile' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Bio' })).toHaveValue('Draft');
    });

    it('keeps Tab inside the dialog', async () => {
      answerProfileRead();
      render(<ProfileActions profile={profile} />);

      const dialog = await openEditor();
      const save = await within(dialog).findByRole('button', { name: 'Save changes' });
      const close = within(dialog).getByRole('button', { name: 'Close' });

      save.focus();
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(close).toHaveFocus();

      fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
      expect(save).toHaveFocus();
    });

    // Below 768px the app shell's bottom navigation floats over the page at
    // its own layer (globals.css). At z-50 the editor sat under it, so on a
    // phone the nav was drawn over the dialog's lower part and took its taps.
    it('is drawn over the bottom navigation, with a Close button of the 48px floor', async () => {
      const globalsCss = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
      const bottomNavLayer = Number(/\n\.app-shell-bottom-nav\s*\{[^}]*?\bz-index:\s*(\d+)/.exec(globalsCss)?.[1]);
      answerProfileRead();
      render(<ProfileActions profile={profile} />);

      const dialog = await openEditor();
      const backdrop = dialog.parentElement!;

      // The modal layer of the scale in docs/design/design-web.md (Layers).
      expect(backdrop).toHaveClass('fixed', 'inset-0', 'z-[80]');
      expect(Number(/(?:^|\s)z-\[(\d+)\]/.exec(backdrop.className)?.[1])).toBeGreaterThan(bottomNavLayer);
      // h-12 and w-12: 3rem, 48px at the default text size.
      expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveClass('h-12', 'w-12');
    });

    // Its code is loaded apart from the page's (a deploy can rotate the chunk names while the tab
    // is open): a load that fails is kept from the page, which would otherwise give way to the
    // creator page's error screen.
    describe('when the editor does not load', () => {
      const reload = vi.fn();
      // Where Sentry's global handler hears an error (jsdom has no reportError of its own).
      const reportError = vi.fn();

      beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        reload.mockReset();
        reportError.mockReset();
        vi.stubGlobal('reportError', reportError);
        editorDraw.fails = true;
      });

      afterEach(() => {
        editorDraw.fails = false;
      });

      it('closes it, says so under the buttons, and Try again reloads the page', async () => {
        answerProfileRead();
        render(<ProfileActions profile={profile} />);
        const edit = screen.getByRole('button', { name: 'Edit profile' });

        fireEvent.click(edit);

        const said = await screen.findByRole('alert');
        expect(said).toHaveTextContent('The profile editor did not load.');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(edit).not.toHaveAttribute('aria-busy');
        expect(edit).toHaveFocus();
        expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
          message: 'Loading chunk app_creators_username_CreatorProfileEditSheet_tsx failed.',
        }));

        vi.stubGlobal('location', { reload });
        fireEvent.click(within(said).getByRole('button', { name: 'Try again' }));
        expect(reload).toHaveBeenCalledTimes(1);
      });
    });
  });
});
