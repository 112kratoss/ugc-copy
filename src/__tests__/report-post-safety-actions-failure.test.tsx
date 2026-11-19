import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ReportPostButton from '@/app/showcase/[id]/ReportPostButton';

// A post page's Report user and Block user load their actions with import() at the first reach for
// either row (`safety-actions-loader.ts`, 2026-11-19). That load can fail: a deploy renamed the chunk
// while the page was open, or the connection dropped. It asks and sends nothing then, and the row
// says the actions did not load, with a reload, which fetches the chunk names of the deployment live
// now: a toast saying "Please try again" sent a reader whose chunk a deploy had renamed back to a
// press that could only fail again (review of #884). The loader fails here as the import() does.

const routerMock = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const loadSafetyActions = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('@/components/AuthProvider', () => ({
  // A signed-in reader who is not the creator: both rows are theirs to press.
  useAuth: () => ({ session: { access_token: 'live-token' }, user: { id: 'reader-1' }, isLoading: false }),
}));

vi.mock('@/app/showcase/[id]/safety-actions-loader', () => ({
  loadSafetyActions: () => loadSafetyActions(),
}));

const CHUNK_ERROR = 'Loading chunk feed-safety-actions failed.';

describe("a post page's Report user and Block user when their actions do not load", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let confirm: ReturnType<typeof vi.spyOn>;
  const fetchMock = vi.fn();
  const reload = vi.fn();
  // Where Sentry's global handler hears an error (jsdom has no reportError of its own).
  const reportError = vi.fn();
  const onCreatorBlocked = vi.fn();

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    loadSafetyActions.mockReset();
    loadSafetyActions.mockImplementation(() => Promise.reject(new Error(CHUNK_ERROR)));
    fetchMock.mockReset();
    reload.mockReset();
    reportError.mockReset();
    onCreatorBlocked.mockReset();
    routerMock.push.mockReset();
    routerMock.refresh.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { reload });
    vi.stubGlobal('reportError', reportError);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    consoleError.mockRestore();
    confirm.mockRestore();
  });

  function renderRows() {
    render(
      <ReportPostButton
        postId="post-1"
        creator={{ id: 'creator-1', name: 'Creator Name' }}
        onCreatorBlocked={onCreatorBlocked}
      />,
    );
  }

  it.each(['Block user', 'Report user'])('%s asks and sends nothing, and the row offers a reload', async (row) => {
    renderRows();

    fireEvent.click(screen.getByRole('button', { name: row }));

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('Report user and Block user did not load. Reload the page to try again.');
    expect(loadSafetyActions).toHaveBeenCalledTimes(1);
    // Nothing asked, nothing sent, nothing hidden.
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onCreatorBlocked).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
    // The rows are pressable again: a later press asks for the actions again.
    expect(screen.getByRole('button', { name: 'Report user' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Block user' })).toBeEnabled();
    // Caught and logged, not thrown out of the page, and handed on to reportError, as Next's own
    // boundary would have, so Sentry hears it.
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to load Report user and Block user:',
      expect.objectContaining({ message: CHUNK_ERROR }),
    );
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: CHUNK_ERROR }));

    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('asks again at the next press, and acts once the actions load', async () => {
    renderRows();

    fireEvent.click(screen.getByRole('button', { name: 'Block user' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('did not load');

    // The connection is back: the next press loads the actions, and the notice goes.
    const blockCreatorAfterConfirmation = vi.fn(async () => ({ status: 'cancelled' as const }));
    loadSafetyActions.mockImplementation(async () => ({
      blockCreatorAfterConfirmation,
      reportCreatorAfterConfirmation: vi.fn(),
      toastSafetyOutcome: vi.fn(),
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

    await waitFor(() => expect(blockCreatorAfterConfirmation).toHaveBeenCalledWith({
      userId: 'creator-1',
      creatorName: 'Creator Name',
      accessToken: 'live-token',
    }));
    expect(loadSafetyActions).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });
});
