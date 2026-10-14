import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlockedCreatorPanel } from '@/app/creators/[username]/BlockedCreatorPanel';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import {
  clearShowcaseClientCacheForTests,
  getCreatorsBlockedThisVisit,
  takeBlockedCreatorOffClientFeeds,
} from '@/lib/showcase-client-cache';

// One router for every render, so a test can read what a click asked of it.
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
const authState = vi.hoisted(() => ({
  session: null as { access_token: string } | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: authState.session,
    user: authState.session ? { id: 'viewer-1' } : null,
  }),
}));

const toasts = () => readFeedbackSnapshot().toasts.map(({ tone, message }) => ({ tone, message }));

function answerUnblock(ok = true) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    void url;
    void init;
    return { ok, status: ok ? 200 : 500, json: async () => (ok ? { success: true } : { error: 'Failed to unblock user.' }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const renderPanel = () => render(<BlockedCreatorPanel creatorId="creator-1" username="creator-name" />);

describe('BlockedCreatorPanel', () => {
  beforeEach(() => {
    routerMock.push.mockReset();
    routerMock.replace.mockReset();
    routerMock.refresh.mockReset();
    authState.session = { access_token: 'viewer-token' };
    resetFeedbackState();
    clearShowcaseClientCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says whom the viewer blocked, and offers Unblock', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'You blocked @creator-name' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'You blocked @creator-name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unblock' })).toBeEnabled();
  });

  it('unblocks after asking, says so, and draws the page again from the server', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = answerUnblock();
    // Blocked earlier in this visit: Explore had been leaving them out.
    takeBlockedCreatorOffClientFeeds('creator-1');
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }));

    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Unblock @creator-name?'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/moderation/blocks/creator-1');
    expect(init).toMatchObject({ method: 'DELETE', headers: { Authorization: 'Bearer viewer-token' } });
    expect(toasts()).toEqual([{ tone: 'success', message: '@creator-name is unblocked.' }]);
    expect(getCreatorsBlockedThisVisit('viewer-1').has('creator-1')).toBe(false);
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('sends nothing and stays when the question is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = answerUnblock();
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Unblock' })).toBeEnabled();
  });

  it('stays blocked and says why when the unblock fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    answerUnblock(false);
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }));

    await waitFor(() => expect(toasts()).toEqual([
      { tone: 'error', message: 'Could not unblock this creator. Failed to unblock user.' },
    ]));
    expect(routerMock.refresh).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Unblock' })).toBeEnabled();
  });

  it('sends a viewer whose session is gone to sign in and back here, and asks nothing', async () => {
    authState.session = null;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = answerUnblock();
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }));

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith(
      `/login?returnUrl=${encodeURIComponent('/creators/creator-name')}`
    ));
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
