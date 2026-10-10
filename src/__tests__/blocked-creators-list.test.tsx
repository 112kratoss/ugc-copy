import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BlockedCreatorsList from '@/app/profile/blocked/BlockedCreatorsList';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import type { BlockedCreator } from '@/lib/moderation-client';
import {
  clearShowcaseClientCacheForTests,
  getCreatorsBlockedThisVisit,
  takeBlockedCreatorOffClientFeeds,
} from '@/lib/showcase-client-cache';

const authState = vi.hoisted(() => ({
  session: { access_token: 'viewer-token' } as { access_token: string } | null,
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: authState.session }),
}));

const first: BlockedCreator = {
  id: 'creator-1',
  username: 'first-creator',
  name: 'First Creator',
  avatar: 'https://example.com/first.jpg',
  blockedAt: '2026-10-10T08:00:00.000Z',
};
const second: BlockedCreator = { id: 'creator-2', username: null, name: 'No Handle', avatar: null, blockedAt: 'not a date' };

type Answer = { ok?: boolean; status?: number; body: unknown };

/** Answers the list and the unblock requests, and keeps every request made. */
function answerRequests({ list, unblock = { body: { success: true, blocked: false } } }: { list: Answer[]; unblock?: Answer }) {
  const lists = [...list];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const answer = init?.method === 'DELETE' ? unblock : lists.length > 1 ? lists.shift()! : lists[0];
    return { ok: answer.ok ?? true, status: answer.status ?? 200, json: async () => answer.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const listOf = (...blockedUsers: BlockedCreator[]): Answer => ({ body: { success: true, blockedUsers, hasMore: false } });
const toasts = () => readFeedbackSnapshot().toasts.map(({ tone, message }) => ({ tone, message }));
/** The rows of the list, in the order drawn, each named by its button. */
const rowButtons = () => within(screen.getByRole('list', { name: 'Blocked users' })).getAllByRole('button')
  .map((button) => button.getAttribute('aria-label'));

// There was no way to see whom you had blocked, or to take a block back: the
// server could unblock, and no page asked it to.
describe('the Blocked users list', () => {
  beforeEach(() => {
    authState.session = { access_token: 'viewer-token' };
    resetFeedbackState();
    clearShowcaseClientCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the list as the signed-in viewer and names each person as a card names its creator', async () => {
    const fetchMock = answerRequests({ list: [listOf(first, second)] });
    render(<BlockedCreatorsList />);

    expect(screen.getByRole('status', { name: 'Loading blocked users' })).toBeInTheDocument();
    const rows = within(await screen.findByRole('list', { name: 'Blocked users' })).getAllByRole('listitem');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/moderation/blocks');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer viewer-token' } });
    expect(rows).toHaveLength(2);
    // The name, the handle and the day, each on a line of its own.
    expect([...rows[0].querySelectorAll('span.block')].map((line) => line.textContent))
      .toEqual(['First Creator', '@first-creator', 'Blocked Oct 10, 2026']);
    expect(within(rows[0]).getByRole('button', { name: 'Unblock @first-creator' })).toBeInTheDocument();
    // No handle and no readable date: the name alone, and a button that names them by it.
    expect(rows[1]).toHaveTextContent('No Handle');
    expect(rows[1]).not.toHaveTextContent(/Blocked|@/);
    expect(within(rows[1]).getByRole('button', { name: 'Unblock No Handle' })).toBeInTheDocument();
  });

  it('says so when nobody is blocked', async () => {
    answerRequests({ list: [listOf()] });
    render(<BlockedCreatorsList />);

    expect(await screen.findByRole('heading', { name: 'You have not blocked anyone' })).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  // An empty list would say "you have blocked nobody".
  it('says the list could not be read, never that it is empty, and reads it again when asked', async () => {
    const fetchMock = answerRequests({
      list: [{ ok: false, status: 500, body: { error: 'Failed to load blocked users.' } }, listOf(first)],
    });
    render(<BlockedCreatorsList />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your blocked users. Failed to load blocked users.');
    expect(screen.queryByText('You have not blocked anyone')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Unblock @first-creator' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats an answer of another shape as a failure', async () => {
    answerRequests({ list: [{ body: { success: true } }] });
    render(<BlockedCreatorsList />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your blocked users.');
  });

  it('unblocks after a question, takes the row away, says so, and lets Explore draw them again', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = answerRequests({ list: [listOf(first, second)] });
    takeBlockedCreatorOffClientFeeds('creator-1');
    render(<BlockedCreatorsList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unblock @first-creator' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Unblock @first-creator' })).not.toBeInTheDocument());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Unblock @first-creator?'));
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/moderation/blocks/creator-1');
    expect(init).toMatchObject({ method: 'DELETE', headers: { Authorization: 'Bearer viewer-token' } });
    expect(toasts()).toEqual([{ tone: 'success', message: '@first-creator is unblocked.' }]);
    expect(screen.getByRole('button', { name: 'Unblock No Handle' })).toBeInTheDocument();
    expect([...getCreatorsBlockedThisVisit('viewer-1')]).toEqual([]);
  });

  // A button that waits on the network reads as a press that did not land.
  it('takes the row away the moment the answer is given, before the server has replied', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finish: (answer: { ok: boolean; status: number; json: () => Promise<unknown> }) => void = () => undefined;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => (init?.method === 'DELETE'
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, blockedUsers: [first, second], hasMore: false }) })));
    vi.stubGlobal('fetch', fetchMock);
    render(<BlockedCreatorsList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unblock @first-creator' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Unblock @first-creator' })).not.toBeInTheDocument());
    expect(toasts()).toEqual([]);
    // Nothing is held meanwhile: the next person can be unblocked at once.
    expect(screen.getByRole('button', { name: 'Unblock No Handle' })).toBeEnabled();

    finish({ ok: true, status: 200, json: async () => ({ success: true, blocked: false }) });
    await waitFor(() => expect(toasts()).toEqual([{ tone: 'success', message: '@first-creator is unblocked.' }]));
  });

  it('shows the empty state once the last person is unblocked', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    answerRequests({ list: [listOf(second)] });
    render(<BlockedCreatorsList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unblock No Handle' }));

    expect(await screen.findByRole('heading', { name: 'You have not blocked anyone' })).toBeInTheDocument();
    expect(toasts()).toEqual([{ tone: 'success', message: 'No Handle is unblocked.' }]);
  });

  it('sends nothing and keeps the row when the question is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = answerRequests({ list: [listOf(first)] });
    takeBlockedCreatorOffClientFeeds('creator-1');
    render(<BlockedCreatorsList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unblock @first-creator' }));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unblock @first-creator' })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual([]);
    expect([...getCreatorsBlockedThisVisit('viewer-1')]).toEqual(['creator-1']);
  });

  it('puts the row back where it was, and says why, when the unblock fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const third: BlockedCreator = { ...first, id: 'creator-3', username: 'third-creator', name: 'Third Creator' };
    answerRequests({ list: [listOf(first, second, third)], unblock: { ok: false, status: 500, body: { error: 'Failed to unblock user.' } } });
    takeBlockedCreatorOffClientFeeds('creator-2');
    render(<BlockedCreatorsList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unblock No Handle' }));

    await waitFor(() => expect(toasts()).toEqual([
      { tone: 'error', message: 'Could not unblock this creator. Failed to unblock user.' },
    ]));
    // Back between its neighbours, not at the end of the list.
    expect(rowButtons()).toEqual(['Unblock @first-creator', 'Unblock No Handle', 'Unblock @third-creator']);
    expect([...getCreatorsBlockedThisVisit('viewer-1')]).toEqual(['creator-2']);
  });

  // Putting a row back at the place it had when it was pressed went wrong here:
  // the second was pressed when the first was already out, so it came back first.
  it('keeps the order when one unblock is refused while another is still with the server', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const third: BlockedCreator = { ...first, id: 'creator-3', username: 'third-creator', name: 'Third Creator' };
    const waiting = new Map<string, (answer: { ok: boolean; status: number; json: () => Promise<unknown> }) => void>();
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => (init?.method === 'DELETE'
      ? new Promise((resolve) => { waiting.set(url.split('/').pop()!, resolve); })
      : Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, blockedUsers: [first, second, third], hasMore: false }) }))));
    render(<BlockedCreatorsList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unblock @first-creator' }));
    await waitFor(() => expect(waiting.has('creator-1')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Unblock No Handle' }));
    await waitFor(() => expect(waiting.has('creator-2')).toBe(true));
    expect(rowButtons()).toEqual(['Unblock @third-creator']);

    // The first is refused, then the second: each is back above the one after it.
    waiting.get('creator-1')!({ ok: false, status: 500, json: async () => ({ error: 'Failed to unblock user.' }) });
    await waitFor(() => expect(rowButtons()).toEqual(['Unblock @first-creator', 'Unblock @third-creator']));
    waiting.get('creator-2')!({ ok: false, status: 500, json: async () => ({ error: 'Failed to unblock user.' }) });
    await waitFor(() => expect(rowButtons()).toEqual(['Unblock @first-creator', 'Unblock No Handle', 'Unblock @third-creator']));
  });

  it('says when the list is cut at its limit', async () => {
    answerRequests({ list: [{ body: { success: true, blockedUsers: [first], hasMore: true } }] });
    render(<BlockedCreatorsList />);

    expect(await screen.findByText(/Showing your most recent blocks/)).toBeInTheDocument();
  });

  // The note under a cut list says that unblocking someone shows the ones before them.
  it('reads a cut list again after an unblock, and never calls it empty meanwhile', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finish: (answer: { ok: boolean; status: number; json: () => Promise<unknown> }) => void = () => undefined;
    const lists = [
      { success: true, blockedUsers: [first], hasMore: true },
      { success: true, blockedUsers: [second], hasMore: false },
    ];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => (init?.method === 'DELETE'
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ ok: true, status: 200, json: async () => (lists.length > 1 ? lists.shift() : lists[0]) })));
    vi.stubGlobal('fetch', fetchMock);
    render(<BlockedCreatorsList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unblock @first-creator' }));

    // The only row shown is out, and there are earlier blocks to come.
    expect(await screen.findByRole('status', { name: 'Loading blocked users' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'You have not blocked anyone' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1);

    finish({ ok: true, status: 200, json: async () => ({ success: true, blocked: false }) });

    expect(await screen.findByRole('button', { name: 'Unblock No Handle' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(2);
    expect(screen.queryByText(/Showing your most recent blocks/)).not.toBeInTheDocument();
  });

  it('does not read a whole list again after an unblock', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = answerRequests({ list: [listOf(first, second)] });
    render(<BlockedCreatorsList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unblock @first-creator' }));

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1);
  });

  it('waits for a session before it asks', () => {
    authState.session = null;
    const fetchMock = answerRequests({ list: [listOf(first)] });
    render(<BlockedCreatorsList />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'Loading blocked users' })).toBeInTheDocument();
  });

  // The session is restored after the page's first paint on a full load.
  it('reads the list with the token of a session that arrives after the page', async () => {
    authState.session = null;
    const fetchMock = answerRequests({ list: [listOf(first)] });
    const { rerender } = render(<BlockedCreatorsList />);
    expect(fetchMock).not.toHaveBeenCalled();

    authState.session = { access_token: 'restored-token' };
    rerender(<BlockedCreatorsList />);

    expect(await screen.findByRole('button', { name: 'Unblock @first-creator' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer restored-token' } });
  });

  // The list is the account's, not the token's.
  it('does not read the list again when the token is refreshed, and unblocks with the new one', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = answerRequests({ list: [listOf(first)] });
    const { rerender } = render(<BlockedCreatorsList />);
    await screen.findByRole('button', { name: 'Unblock @first-creator' });

    authState.session = { access_token: 'refreshed-token' };
    rerender(<BlockedCreatorsList />);
    await screen.findByRole('button', { name: 'Unblock @first-creator' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Unblock @first-creator' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe('/api/moderation/blocks/creator-1');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE', headers: { Authorization: 'Bearer refreshed-token' } });
  });
});
