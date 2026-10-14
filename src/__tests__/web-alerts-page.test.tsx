import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Activity } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NotificationsPage from '@/app/notifications/page';

type TestSession = { access_token: string } | null;
type AuthListener = (event: string, session: TestSession) => void;

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() },
  publish: vi.fn(),
  session: { access_token: 'viewer-token' } as { access_token: string } | null,
  listeners: new Set<(event: string, session: { access_token: string } | null) => void>(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('@/components/useUnreadAlertsCount', () => ({ publishUnreadAlertsCount: mocks.publish }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: mocks.session } }),
      // As auth-js does: the current session is reported once, just after subscribing.
      onAuthStateChange: (listener: AuthListener) => {
        mocks.listeners.add(listener);
        queueMicrotask(() => {
          if (mocks.listeners.has(listener)) listener('INITIAL_SESSION', mocks.session);
        });
        return { data: { subscription: { unsubscribe: () => mocks.listeners.delete(listener) } } };
      },
    },
  },
}));

type AlertRow = {
  id: string;
  type: string;
  category: 'generation' | 'commerce' | 'social' | 'system';
  title: string;
  body: string;
  deepLink: string | null;
  isRead: boolean;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
};

const BASE_MS = Date.UTC(2026, 9, 14, 12, 0, 0);
/** `last_event_at` as PostgREST writes it: microseconds and an offset. */
const stamp = (index: number) => new Date(BASE_MS - index * 60_000).toISOString().replace('Z', '123+00:00');

const alertRow = (index: number, extra: Partial<AlertRow> = {}): AlertRow => ({
  id: `alert-${index}`,
  type: 'post_saved',
  category: 'social',
  title: `Alert ${index}`,
  body: `Someone saved post ${index}.`,
  deepLink: null,
  isRead: false,
  eventCount: 1,
  createdAt: stamp(index),
  updatedAt: stamp(index),
  ...extra,
});
const rows = (from: number, count: number) => Array.from({ length: count }, (_, offset) => alertRow(from + offset));

type Answer = { status?: number; body: unknown };
const inbox = (notifications: AlertRow[], unreadCount: number): Answer => ({
  body: { success: true, notifications, unreadCount },
});

function answerFetch(route: (url: URL, init?: RequestInit) => Answer | Promise<Answer>) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const answer = await route(new URL(input, 'https://magicbooklet.test'), init);
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => answer.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The titles of the rows on screen, in the order drawn. */
const titles = () => screen.queryAllByText(/^Alert -?\d+$/).map((title) => title.textContent);

describe('the web Alerts page', () => {
  beforeEach(() => {
    mocks.session = { access_token: 'viewer-token' };
    mocks.listeners.clear();
    mocks.publish.mockReset();
    mocks.router.push.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Signing in from Alerts landed on Create, and the alerts had to be found again.
  it('sends a signed-out reader to sign in and back to Alerts', async () => {
    mocks.session = null;
    const fetchMock = answerFetch(() => inbox([], 0));
    render(<NotificationsPage />);

    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?returnUrl=/notifications');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The page published its first 0 before the list arrived: every badge in the
  // shell blinked off on each visit, and stayed off when the read failed.
  it('leaves the badge alone until the list answers, then publishes its count', async () => {
    let answer: ((value: Answer) => void) | undefined;
    const fetchMock = answerFetch(() => new Promise<Answer>((resolve) => { answer = resolve; }));
    render(<NotificationsPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(screen.queryByText(/unread alert/)).toBeNull();

    await act(async () => answer!(inbox([alertRow(1), alertRow(2, { isRead: true })], 7)));

    expect(await screen.findByText('7 unread alerts')).toBeInTheDocument();
    expect(mocks.publish.mock.calls).toEqual([[7]]);
  });

  it("keeps the badge's own count when the list read fails", async () => {
    answerFetch(() => ({ status: 500, body: { error: 'Internal server error' } }));
    render(<NotificationsPage />);

    expect(await screen.findByText('Could not load alerts')).toBeInTheDocument();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('counts a tapped alert down at once, and back up when the write is refused', async () => {
    let release: (() => void) | undefined;
    answerFetch(async (url) => {
      if (url.pathname === '/api/mobile/notifications/read') {
        await new Promise<void>((resolve) => { release = resolve; });
        return { status: 500, body: { error: 'Failed to mark notifications read.' } };
      }
      return inbox([alertRow(1), alertRow(2)], 2);
    });
    render(<NotificationsPage />);

    fireEvent.click(await screen.findByText('Alert 1'));
    expect(screen.getByText('1 unread alert')).toBeInTheDocument();
    expect(mocks.publish).toHaveBeenLastCalledWith(1);

    await waitFor(() => expect(release).toBeDefined());
    await act(async () => release!());

    expect(await screen.findByText('2 unread alerts')).toBeInTheDocument();
    expect(mocks.publish).toHaveBeenLastCalledWith(2);
  });

  // A refused Mark all read looked like a broken button: nothing changed and nothing was said.
  it('keeps the alerts unread and says why when Mark all read is refused, and marks them on a retry', async () => {
    let readAllAnswer: Answer = {
      status: 429,
      body: { error: 'Too many requests. Please wait before trying again.', code: 'RATE_LIMITED' },
    };
    let release: (() => void) | undefined;
    const fetchMock = answerFetch(async (url) => {
      if (url.pathname === '/api/mobile/notifications/read-all') {
        await new Promise<void>((resolve) => { release = resolve; });
        return readAllAnswer;
      }
      return inbox([alertRow(1), alertRow(2)], 2);
    });
    render(<NotificationsPage />);

    expect(await screen.findByText('2 unread alerts')).toBeInTheDocument();
    const markAll = screen.getByRole('button', { name: 'Mark all read' });
    fireEvent.click(markAll);
    // One request at a time.
    expect(markAll).toBeDisabled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/mobile/notifications/read-all', expect.anything()));
    await act(async () => release!());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Alerts were not marked read. Too many requests. Please wait before trying again.',
    );
    expect(screen.getByText('2 unread alerts')).toBeInTheDocument();
    expect(markAll).toBeEnabled();
    expect(mocks.publish).not.toHaveBeenCalledWith(0);

    readAllAnswer = { body: { success: true } };
    release = undefined;
    fireEvent.click(markAll);
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => release!());

    expect(await screen.findByText('0 unread alerts')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocks.publish).toHaveBeenLastCalledWith(0);
    expect(markAll).toBeDisabled();
  });

  // The unread count covers every alert, but the list stopped at the newest 50.
  it("reads older alerts with the server's before cursor and lists them after the newest page", async () => {
    const newest = rows(1, 50);
    const older = rows(51, 3);
    const fetchMock = answerFetch((url) => (
      url.searchParams.has('before') ? inbox(older, 60) : inbox(newest, 61)
    ));
    render(<NotificationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Load older alerts' }));
    await waitFor(() => expect(titles()).toHaveLength(53));

    const [olderUrl, olderInit] = fetchMock.mock.calls[1];
    const query = new URL(olderUrl, 'https://magicbooklet.test').searchParams;
    // The inbox pages on each alert's last event, and its `+00:00` survives the query string.
    expect(query.get('before')).toBe(newest[49].updatedAt);
    expect(query.get('limit')).toBe('50');
    expect(olderUrl).toContain('%2B00%3A00');
    expect(olderInit).toMatchObject({ headers: { Authorization: 'Bearer viewer-token' } });
    expect(titles()).toEqual([...newest, ...older].map((row) => row.title));
    // A short page is the end of the inbox.
    expect(screen.queryByRole('button', { name: 'Load older alerts' })).toBeNull();
    expect(screen.getByText('60 unread alerts')).toBeInTheDocument();
  });

  // auth-js reports a sign-in on every return to the tab, and a hidden
  // <Activity> runs every effect again; each reads the newest page.
  it('keeps the older alerts when every effect runs again and the newest page reaches them', async () => {
    const first = rows(1, 50);
    const older = rows(51, 50);
    // One new alert at the top pushes the 50th out of the newest page.
    const fresh = [alertRow(0), ...first.slice(0, 49)];
    let newest = first;
    const fetchMock = answerFetch((url) => (
      url.searchParams.has('before') ? inbox(older, 100) : inbox(newest, 101)
    ));
    const inActivity = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <NotificationsPage />
      </Activity>
    );
    const { rerender } = render(inActivity('visible'));
    fireEvent.click(await screen.findByRole('button', { name: 'Load older alerts' }));
    await waitFor(() => expect(titles()).toHaveLength(100));

    newest = fresh;
    rerender(inActivity('hidden'));
    rerender(inActivity('visible'));
    // The positive control: the effects did run again and read the newest page.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(titles()[0]).toBe('Alert 0'));

    expect(titles()).toEqual([...fresh, first[49], ...older].map((row) => row.title));
    expect(screen.getByRole('button', { name: 'Load older alerts' })).toBeInTheDocument();
    expect(screen.getByText('101 unread alerts')).toBeInTheDocument();
  });

  it('starts the list again when the newest page does not reach the alerts already read', async () => {
    const first = rows(1, 50);
    // Fifty alerts newer than everything on screen: what lies between is unread here.
    const burst = rows(-60, 50);
    let newest = first;
    answerFetch((url) => (url.searchParams.has('before') ? inbox(rows(51, 3), 53) : inbox(newest, 103)));
    render(<NotificationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load older alerts' }));
    await waitFor(() => expect(titles()).toHaveLength(53));

    newest = burst;
    act(() => mocks.listeners.forEach((listener) => listener('SIGNED_IN', mocks.session)));

    await waitFor(() => expect(titles()).toEqual(burst.map((row) => row.title)));
    expect(screen.getByRole('button', { name: 'Load older alerts' })).toBeInTheDocument();
  });
});
