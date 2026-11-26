import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authState, router } = vi.hoisted(() => ({
  authState: {
    session: null as { access_token: string; user: { id: string; is_anonymous: boolean } } | null,
    user: null as { id: string; is_anonymous: boolean } | null,
  },
  router: { replace: vi.fn(), push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), back: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/support',
}));
vi.mock('next/link', () => ({
  default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
    <a {...props} data-prefetch={prefetch === undefined ? undefined : String(prefetch)} />
  ),
}));
vi.mock('@/components/AuthProvider', () => ({ useAuth: () => authState }));
vi.mock('@/components/useConfirmation', () => ({ useConfirmation: () => async () => true }));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));

// The account's thread, read from a transport that answers an empty conversation.
const chatTransport = vi.hoisted(() => ({
  load: vi.fn(async () => ({ kind: 'ok' as const, conversation: null, messages: [] })),
  send: vi.fn(async () => ({ ok: false as const, error: null })),
  edit: vi.fn(async () => ({ ok: false as const, error: null })),
  remove: vi.fn(async () => ({ ok: false as const, error: null })),
  react: vi.fn(async () => ({ ok: false as const, error: null })),
  markRead: vi.fn(async () => ({ ok: false as const, error: null })),
  typing: vi.fn(async () => undefined),
}));
vi.mock('@/components/support-chat/support-chat-transports', () => ({
  createAccountSupportTransport: () => chatTransport,
}));

import SupportHubClient from '@/app/support/SupportHubClient';
import FeedbackViewport from '@/components/FeedbackViewport';
import { resetFeedbackState } from '@/components/feedback-state';
import { noteSupportUpdatesLatest, resetSupportUpdatesUnreadForTests } from '@/lib/support-updates-unread';

import {
  SUPPORT_FEATURE_IDEA_PREFIX,
  SUPPORT_HUB_WORDS,
  SUPPORT_UPDATES_SEEN_STORAGE_KEY,
  supportUpdateDateLabel,
  type SupportRoadmapItem,
  type SupportUpdate,
} from '../../ugc-mobile/lib/support-hub-policy/support-hub-policy';

const UPDATE_ANNOUNCEMENT: SupportUpdate = {
  id: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a',
  kind: 'announcement',
  title: 'Folders are here',
  body: 'Group your creations into folders from your profile.\n\nTell us what you think in the comments.',
  createdAt: '2026-11-26T12:00:00.000Z',
  commentCount: 4,
  commentsLocked: false,
  reactions: { '👍': 12, '❤️': 3 },
  myReaction: null,
};

const UPDATE_SHIPPED: SupportUpdate = {
  id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  kind: 'shipped',
  title: 'Text posts',
  body: 'Share a prompt or a guide without media.',
  createdAt: '2026-11-20T09:00:00.000Z',
  commentCount: 0,
  commentsLocked: true,
  reactions: {},
  myReaction: null,
};

const DAY = 24 * 60 * 60 * 1000;
function roadmapItem(overrides: Partial<SupportRoadmapItem> & Pick<SupportRoadmapItem, 'id' | 'title' | 'status'>): SupportRoadmapItem {
  return { summary: '', shippedAt: null, shippedUpdateId: null, reactions: {}, myReaction: null, ...overrides };
}

type Call = { path: string; method: string; authorization: string | null; body: unknown };
const calls: Call[] = [];
let answer: (call: Call) => Response | Promise<Response> = () => json({ error: 'Not answered' }, 503);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const listCalls = (prefix: string) => calls.filter((call) => call.method === 'GET' && call.path.startsWith(prefix));

function signInAs({ guest = false }: { guest?: boolean } = {}) {
  const user = { id: guest ? 'guest-1' : 'viewer-1', is_anonymous: guest };
  authState.user = user;
  authState.session = { access_token: 'token-1', user };
}

function view(initialTab: 'chat' | 'updates' | 'roadmap' = 'chat') {
  return render(
    <>
      <SupportHubClient initialTab={initialTab} />
      <FeedbackViewport />
    </>,
  );
}

beforeEach(() => {
  authState.session = null;
  authState.user = null;
  router.replace.mockClear();
  calls.length = 0;
  answer = () => json({ error: 'Not answered' }, 503);
  chatTransport.load.mockClear();
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetSupportUpdatesUnreadForTests();
  // The dot's own read is answered already: nothing published yet.
  noteSupportUpdatesLatest(null);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      path: String(input),
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('Authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return answer(call);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => resetFeedbackState());
  resetSupportUpdatesUnreadForTests();
});

describe('Help & Support on the web', () => {
  describe('its tabs', () => {
    it('opens on the tab its address names, as a tab list, and writes the tab it changes to', async () => {
      signInAs();
      answer = (call) => (call.path.startsWith('/api/support/updates')
        ? json({ updates: [], nextCursor: null, latestAt: null })
        : json({ items: [] }));
      view('chat');

      expect(screen.getByRole('heading', { level: 1, name: 'Help & Support' })).toBeInTheDocument();
      const tabs = within(screen.getByRole('tablist', { name: SUPPORT_HUB_WORDS.tabsLabel })).getAllByRole('tab');
      expect(tabs.map((tab) => tab.textContent)).toEqual(['Chat', 'Updates', 'Roadmap']);
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tabpanel', { name: 'Chat' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Updates' }));
      expect(screen.getByRole('tab', { name: 'Updates' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tabpanel', { name: 'Updates' })).toBeInTheDocument();
      expect(router.replace).toHaveBeenLastCalledWith('/support?tab=updates', { scroll: false });
      expect(await screen.findByText(SUPPORT_HUB_WORDS.updatesEmptyTitle)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Roadmap' }));
      expect(router.replace).toHaveBeenLastCalledWith('/support?tab=roadmap', { scroll: false });
      expect(await screen.findByText(SUPPORT_HUB_WORDS.roadmapEmptyTitle)).toBeInTheDocument();

      // The chat has no parameter: its address is the page's own.
      fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
      expect(router.replace).toHaveBeenLastCalledWith('/support', { scroll: false });
      expect(screen.getByRole('tabpanel', { name: 'Chat' })).toBeInTheDocument();
    });

    it('opens on Updates or the Roadmap from the address, and follows a link to another tab of the page', async () => {
      answer = (call) => (call.path.startsWith('/api/support/updates')
        ? json({ updates: [UPDATE_ANNOUNCEMENT], nextCursor: null, latestAt: UPDATE_ANNOUNCEMENT.createdAt })
        : json({ items: [] }));
      const { rerender } = view('updates');
      expect(screen.getByRole('tab', { name: 'Updates' })).toHaveAttribute('aria-selected', 'true');
      expect(await screen.findByRole('link', { name: 'Folders are here' })).toBeInTheDocument();

      // The shell's Help & feedback leads to `/support`, the chat.
      rerender(
        <>
          <SupportHubClient initialTab="chat" />
          <FeedbackViewport />
        </>,
      );
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tabpanel', { name: 'Chat' })).toBeInTheDocument();
      expect(router.replace).not.toHaveBeenCalled();
    });

    it('keeps the contact page and the support mail under every tab', async () => {
      answer = (call) => (call.path.startsWith('/api/support/updates')
        ? json({ updates: [], nextCursor: null, latestAt: null })
        : json({ items: [] }));
      view('chat');
      for (const tab of ['Chat', 'Updates', 'Roadmap']) {
        fireEvent.click(screen.getByRole('tab', { name: tab }));
        expect(screen.getByRole('link', { name: 'contact page' }), tab).toHaveAttribute('href', '/contact');
        expect(screen.getByRole('link', { name: 'info@magicbooklet.com' }), tab).toHaveAttribute('href', expect.stringMatching(/^mailto:info@magicbooklet\.com\?/));
      }
      await screen.findByText(SUPPORT_HUB_WORDS.roadmapEmptyTitle);
    });
  });

  describe('the Chat tab', () => {
    // RequireAuth sent a visitor to sign in as the page opened; the page is everyone's now.
    it('asks a visitor with no session to sign in, or to write instead, and reads no thread', () => {
      view('chat');

      const panel = screen.getByRole('tabpanel', { name: 'Chat' });
      expect(within(panel).getByRole('heading', { name: 'Sign in to message support' })).toBeInTheDocument();
      expect(within(panel).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?returnUrl=%2Fsupport');
      expect(within(panel).getByRole('link', { name: 'Email us instead' })).toHaveAttribute('href', expect.stringMatching(/^mailto:info@magicbooklet\.com\?/));
      expect(screen.getByRole('link', { name: 'contact page' })).toHaveAttribute('href', '/contact');
      expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
      expect(chatTransport.load).not.toHaveBeenCalled();
    });

    it('draws the conversation for a browser with a session', async () => {
      signInAs();
      view('chat');

      expect(await screen.findByText('How can we help?')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
      expect(chatTransport.load).toHaveBeenCalled();
    });

    it('keeps the message being written while another tab is open, and stops reading the thread there', async () => {
      signInAs();
      answer = () => json({ updates: [], nextCursor: null, latestAt: null });
      view('chat');
      await screen.findByText('How can we help?');
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'My video failed' } });

      fireEvent.click(screen.getByRole('tab', { name: 'Updates' }));
      expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
      const readsWhileAway = chatTransport.load.mock.calls.length;
      await screen.findByText(SUPPORT_HUB_WORDS.updatesEmptyTitle);

      fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
      expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('My video failed');
      expect(chatTransport.load.mock.calls.length).toBeGreaterThan(readsWhileAway);
    });
  });

  describe('the Updates tab', () => {
    it('lists the updates as cards a visitor reads, through the shared read', async () => {
      answer = () => json({ updates: [UPDATE_ANNOUNCEMENT, UPDATE_SHIPPED], nextCursor: null, latestAt: UPDATE_ANNOUNCEMENT.createdAt });
      view('updates');

      const title = await screen.findByRole('link', { name: 'Folders are here' });
      expect(title).toHaveAttribute('href', `/showcase/${UPDATE_ANNOUNCEMENT.id}`);
      expect(listCalls('/api/support/updates')).toEqual([
        { path: '/api/support/updates?scope=public', method: 'GET', authorization: null, body: undefined },
      ]);

      const [announcement, shipped] = screen.getAllByRole('article');
      expect(within(announcement).getByText('Announcement')).toBeInTheDocument();
      expect(within(announcement).getByText(supportUpdateDateLabel(UPDATE_ANNOUNCEMENT.createdAt))).toBeInTheDocument();
      expect(within(announcement).getByText('Group your creations into folders from your profile. Tell us what you think in the comments.')).toBeInTheDocument();
      expect(within(announcement).getByRole('link', { name: `${SUPPORT_HUB_WORDS.openComments}: 4 comments` }))
        .toHaveAttribute('href', `/showcase/${UPDATE_ANNOUNCEMENT.id}#comments`);
      expect(within(shipped).getByText('New')).toBeInTheDocument();
      expect(within(shipped).getByText(SUPPORT_HUB_WORDS.commentsOff)).toBeInTheDocument();

      // A visitor's reactions are counts, each a way to sign in and come back to Updates.
      const signIn = '/login?returnUrl=%2Fsupport%3Ftab%3Dupdates';
      expect(within(announcement).getByRole('link', { name: `👍, 12 people. ${SUPPORT_HUB_WORDS.signInToReact}` })).toHaveAttribute('href', signIn);
      expect(within(announcement).getByRole('link', { name: SUPPORT_HUB_WORDS.signInToReact })).toHaveAttribute('href', signIn);
      expect(within(announcement).queryByRole('button', { name: SUPPORT_HUB_WORDS.react })).not.toBeInTheDocument();
    });

    it('reads the list with the token of a browser with a session, and asks a guest to sign in to react', async () => {
      signInAs({ guest: true });
      answer = () => json({ updates: [UPDATE_ANNOUNCEMENT], nextCursor: null, latestAt: UPDATE_ANNOUNCEMENT.createdAt });
      view('updates');

      await screen.findByRole('link', { name: 'Folders are here' });
      expect(listCalls('/api/support/updates')).toEqual([
        { path: '/api/support/updates', method: 'GET', authorization: 'Bearer token-1', body: undefined },
      ]);
      expect(screen.getByRole('link', { name: SUPPORT_HUB_WORDS.signInToReact })).toBeInTheDocument();
    });

    it("draws a reaction at once and takes the server's counts", async () => {
      signInAs();
      const reaction = deferred<Response>();
      answer = (call) => (call.method === 'POST'
        ? reaction.promise
        : json({ updates: [UPDATE_ANNOUNCEMENT], nextCursor: null, latestAt: UPDATE_ANNOUNCEMENT.createdAt }));
      view('updates');

      fireEvent.click(await screen.findByRole('button', { name: '👍, 12 people' }));
      const mine = screen.getByRole('button', { name: '👍, 13 people, yours' });
      expect(mine).toHaveAttribute('aria-pressed', 'true');
      expect(calls.filter((call) => call.method === 'POST')).toEqual([{
        path: `/api/support/updates/${UPDATE_ANNOUNCEMENT.id}/reaction`,
        method: 'POST',
        authorization: 'Bearer token-1',
        body: { emoji: '👍' },
      }]);

      await act(async () => {
        reaction.resolve(json({ reactions: { '👍': 20, '❤️': 3 }, myReaction: '👍' }));
      });
      expect(await screen.findByRole('button', { name: '👍, 20 people, yours' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('puts a refused reaction back and says it was not saved', async () => {
      signInAs();
      answer = (call) => (call.method === 'POST'
        ? json({ error: 'Your reaction was not saved.' }, 500)
        : json({ updates: [{ ...UPDATE_ANNOUNCEMENT, myReaction: '❤️' }], nextCursor: null, latestAt: UPDATE_ANNOUNCEMENT.createdAt }));
      view('updates');

      // From the six: 👍 replaces the reader's ❤️.
      fireEvent.click(await screen.findByRole('button', { name: SUPPORT_HUB_WORDS.react }));
      const picker = screen.getByRole('group', { name: SUPPORT_HUB_WORDS.react });
      expect(within(picker).getAllByRole('button').map((button) => button.textContent)).toEqual(['👍', '❤️', '😂', '😮', '😢', '🙏']);
      expect(within(picker).getByRole('button', { name: '❤️' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(within(picker).getByRole('button', { name: '👍' }));

      expect(screen.getByRole('button', { name: '👍, 13 people, yours' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '❤️, 2 people' })).toBeInTheDocument();
      expect(await screen.findByText(SUPPORT_HUB_WORDS.reactionFailed)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '👍, 12 people' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: '❤️, 3 people, yours' })).toHaveAttribute('aria-pressed', 'true');
      expect(calls.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual([{ emoji: '👍' }]);
    });

    it('clears the reaction the reader presses again, and sends a lapsed session to sign in', async () => {
      signInAs();
      answer = (call) => (call.method === 'POST'
        ? json({ error: 'Sign in to react.', code: 'REGISTRATION_REQUIRED' }, 401)
        : json({ updates: [{ ...UPDATE_ANNOUNCEMENT, myReaction: '👍' }], nextCursor: null, latestAt: UPDATE_ANNOUNCEMENT.createdAt }));
      view('updates');

      fireEvent.click(await screen.findByRole('button', { name: '👍, 12 people, yours' }));
      expect(screen.getByRole('button', { name: '👍, 11 people' })).toBeInTheDocument();
      expect(calls.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual([{ emoji: null }]);
      expect(await screen.findByText(SUPPORT_HUB_WORDS.signInToReact)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '👍, 12 people, yours' })).toBeInTheDocument();
    });

    it('shows more with the next page, and says when the list could not be read', async () => {
      const second: SupportUpdate = { ...UPDATE_SHIPPED, id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', title: 'Older news' };
      let firstPageFails = true;
      answer = (call) => {
        if (call.path.includes('cursor=')) return json({ updates: [second], nextCursor: null, latestAt: null });
        if (firstPageFails) return json({ error: 'Updates could not be loaded.' }, 500);
        return json({ updates: [UPDATE_ANNOUNCEMENT], nextCursor: 'cursor-2', latestAt: UPDATE_ANNOUNCEMENT.createdAt });
      };
      view('updates');

      expect(await screen.findByRole('heading', { name: SUPPORT_HUB_WORDS.updatesLoadFailed })).toBeInTheDocument();
      firstPageFails = false;
      fireEvent.click(screen.getByRole('button', { name: SUPPORT_HUB_WORDS.tryAgain }));
      await screen.findByRole('link', { name: 'Folders are here' });

      fireEvent.click(screen.getByRole('button', { name: SUPPORT_HUB_WORDS.loadMore }));
      expect(await screen.findByRole('link', { name: 'Older news' })).toBeInTheDocument();
      expect(listCalls('/api/support/updates').map((call) => call.path)).toEqual([
        '/api/support/updates?scope=public',
        '/api/support/updates?scope=public',
        '/api/support/updates?cursor=cursor-2&scope=public',
      ]);
      expect(screen.queryByRole('button', { name: SUPPORT_HUB_WORDS.loadMore })).not.toBeInTheDocument();
    });
  });

  describe('the unread dot', () => {
    it('marks Updates while an update is newer than the last look, and opening the tab marks it seen', async () => {
      window.localStorage.setItem(SUPPORT_UPDATES_SEEN_STORAGE_KEY, '2026-11-20T09:00:00.000Z');
      noteSupportUpdatesLatest(UPDATE_ANNOUNCEMENT.createdAt);
      answer = () => json({ updates: [UPDATE_ANNOUNCEMENT], nextCursor: null, latestAt: UPDATE_ANNOUNCEMENT.createdAt });
      view('chat');

      const updatesTab = screen.getByRole('tab', { name: `Updates, ${SUPPORT_HUB_WORDS.unreadUpdates}` });
      expect(updatesTab.querySelector('[data-support-updates-dot]')).not.toBeNull();

      fireEvent.click(updatesTab);
      await screen.findByRole('link', { name: 'Folders are here' });
      await waitFor(() => expect(window.localStorage.getItem(SUPPORT_UPDATES_SEEN_STORAGE_KEY)).toBe(UPDATE_ANNOUNCEMENT.createdAt));

      fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
      expect(screen.getByRole('tab', { name: 'Updates' }).querySelector('[data-support-updates-dot]')).toBeNull();
    });

    it('draws none once the newest update is seen', () => {
      window.localStorage.setItem(SUPPORT_UPDATES_SEEN_STORAGE_KEY, UPDATE_ANNOUNCEMENT.createdAt);
      noteSupportUpdatesLatest(UPDATE_ANNOUNCEMENT.createdAt);
      view('chat');

      expect(screen.getByRole('tab', { name: 'Updates' }).querySelector('[data-support-updates-dot]')).toBeNull();
    });
  });

  describe('the Roadmap tab', () => {
    const now = Date.now();
    const items = [
      roadmapItem({ id: 'a1', title: 'Collections', status: 'exploring', summary: 'Group posts you love.', reactions: { '👍': 2 } }),
      roadmapItem({ id: 'b1', title: 'Folders for creations', status: 'building', summary: 'Group what you make by project.', reactions: { '🙏': 40, '👍': 18 } }),
      roadmapItem({
        id: 'c1',
        title: 'Text posts',
        status: 'shipped',
        shippedAt: new Date(now - 3 * DAY).toISOString(),
        shippedUpdateId: UPDATE_SHIPPED.id,
        reactions: { '❤️': 9 },
        myReaction: '❤️',
      }),
      roadmapItem({ id: 'd1', title: 'Dark mode', status: 'shipped', shippedAt: new Date(now - 45 * DAY).toISOString() }),
    ];

    it('groups the items as Building, Exploring and Shipped recently, with their votes', async () => {
      signInAs();
      answer = () => json({ items });
      view('roadmap');

      expect(await screen.findByText(SUPPORT_HUB_WORDS.roadmapIntro)).toBeInTheDocument();
      const headings = await screen.findAllByRole('heading', { level: 2 });
      expect(headings.map((heading) => heading.textContent)).toEqual(['Building', 'Exploring', 'Shipped recently']);
      expect(listCalls('/api/support/roadmap')).toEqual([
        { path: '/api/support/roadmap', method: 'GET', authorization: 'Bearer token-1', body: undefined },
      ]);

      const building = screen.getByRole('region', { name: 'Building' });
      expect(within(building).getByRole('heading', { level: 3, name: 'Folders for creations' })).toBeInTheDocument();
      expect(within(building).getByText('58 people want this')).toBeInTheDocument();
      const shipped = screen.getByRole('region', { name: 'Shipped recently' });
      expect(within(shipped).getByRole('link', { name: SUPPORT_HUB_WORDS.readUpdate })).toHaveAttribute('href', `/showcase/${UPDATE_SHIPPED.id}`);
      expect(within(shipped).getByRole('button', { name: '❤️, 9 people, yours' })).toHaveAttribute('aria-pressed', 'true');
      // Shipped more than thirty days ago: it lives on as its update.
      expect(screen.queryByText('Dark mode')).not.toBeInTheDocument();
    });

    it('votes with a reaction through the roadmap route', async () => {
      signInAs();
      answer = (call) => (call.method === 'POST'
        ? json({ reactions: { '👍': 3 }, myReaction: '👍' })
        : json({ items }));
      view('roadmap');

      const exploring = await screen.findByRole('region', { name: 'Exploring' });
      fireEvent.click(within(exploring).getByRole('button', { name: '👍, 2 people' }));
      expect(await within(exploring).findByText('3 people want this')).toBeInTheDocument();
      expect(calls.filter((call) => call.method === 'POST')).toEqual([{
        path: '/api/support/roadmap/a1/reaction',
        method: 'POST',
        authorization: 'Bearer token-1',
        body: { emoji: '👍' },
      }]);
    });

    it('suggests a feature in the chat, its composer started and focused', async () => {
      signInAs();
      answer = () => json({ items });
      view('roadmap');

      fireEvent.click(await screen.findByRole('button', { name: SUPPORT_HUB_WORDS.suggestFeature }));
      expect(router.replace).toHaveBeenLastCalledWith('/support', { scroll: false });
      expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
      const composer = await screen.findByRole('textbox', { name: 'Message' });
      expect(composer).toHaveValue(SUPPORT_FEATURE_IDEA_PREFIX);
      expect(composer).toHaveFocus();
      expect((composer as HTMLTextAreaElement).selectionStart).toBe(SUPPORT_FEATURE_IDEA_PREFIX.length);
    });

    it('keeps a message already started when a feature is suggested', async () => {
      signInAs();
      answer = () => json({ items });
      view('chat');
      await screen.findByText('How can we help?');
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'About billing' } });

      fireEvent.click(screen.getByRole('tab', { name: 'Roadmap' }));
      fireEvent.click(await screen.findByRole('button', { name: SUPPORT_HUB_WORDS.suggestFeature }));
      expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('About billing');
    });

    it('asks a visitor to sign in when they suggest a feature', async () => {
      answer = () => json({ items: [] });
      view('roadmap');

      expect(await screen.findByText(SUPPORT_HUB_WORDS.roadmapEmptyTitle)).toBeInTheDocument();
      expect(listCalls('/api/support/roadmap').map((call) => call.path)).toEqual(['/api/support/roadmap?scope=public']);
      fireEvent.click(screen.getByRole('button', { name: SUPPORT_HUB_WORDS.suggestFeature }));
      expect(screen.getByRole('heading', { name: 'Sign in to message support' })).toBeInTheDocument();
      expect(chatTransport.load).not.toHaveBeenCalled();
    });

    it('says when the roadmap could not be read, and reads it again', async () => {
      let fails = true;
      answer = () => (fails ? json({ error: 'The roadmap could not be loaded.' }, 500) : json({ items }));
      view('roadmap');

      expect(await screen.findByRole('heading', { name: SUPPORT_HUB_WORDS.roadmapLoadFailed })).toBeInTheDocument();
      fails = false;
      fireEvent.click(screen.getByRole('button', { name: SUPPORT_HUB_WORDS.tryAgain }));
      expect(await screen.findByRole('heading', { level: 3, name: 'Folders for creations' })).toBeInTheDocument();
    });
  });
});
