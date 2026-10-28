import { renderHook, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ session: null as { access_token: string } | null, user: null as { id: string } | null }));
vi.mock('@/components/AuthProvider', () => ({ useAuth: () => authState }));

import { useViewerRecipeState } from '@/app/marketplace/useViewerRecipeState';

function answer(ids: unknown[]) {
  return { ok: true, json: async () => ({ success: true, bundleIds: ids }) };
}

// The hook keeps one read per viewer for the page's whole life, so each case
// signs in a viewer of its own.
function signIn(userId: string, token = `token-${userId}`) {
  authState.session = { access_token: token };
  authState.user = { id: userId };
}

describe('useViewerRecipeState', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    authState.session = null;
    authState.user = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks nothing for a signed-out viewer', () => {
    const { result } = renderHook(() => useViewerRecipeState());
    expect(result.current.viewerUserId).toBeNull();
    expect(result.current.unlockedBundleIds.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the signed-in viewer's recipes once, with their token", async () => {
    signIn('buyer-1');
    fetchMock.mockResolvedValue(answer(['b1', 7, 'b2']));
    const { result, rerender } = renderHook(() => useViewerRecipeState());
    expect(result.current.viewerUserId).toBe('buyer-1');
    await waitFor(() => expect(result.current.unlockedBundleIds.has('b1')).toBe(true));
    expect(Array.from(result.current.unlockedBundleIds)).toEqual(['b1', 'b2']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/me/unlocked-recipes');
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer token-buyer-1');
    rerender();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The server-drawn shell and the browser that takes over from it are two
  // lists of cards on one page: one read serves both, and the browser's cards
  // say what the shell's said from their first frame (review of #568).
  it('shares one read between every list of cards, a later one starting with it', async () => {
    signIn('buyer-2');
    fetchMock.mockResolvedValue(answer(['b1']));
    const shell = renderHook(() => useViewerRecipeState());
    await waitFor(() => expect(shell.result.current.unlockedBundleIds.has('b1')).toBe(true));

    const browser = renderHook(() => useViewerRecipeState());
    expect(browser.result.current.unlockedBundleIds.has('b1')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A session's token is refreshed about hourly; the viewer and what they
  // have are the same, so the cards keep their words and nothing is read again.
  it('keeps the recipes through a refreshed token', async () => {
    signIn('buyer-3');
    fetchMock.mockResolvedValue(answer(['b1']));
    const { result, rerender } = renderHook(() => useViewerRecipeState());
    await waitFor(() => expect(result.current.unlockedBundleIds.has('b1')).toBe(true));

    authState.session = { access_token: 'token-buyer-3-refreshed' };
    rerender();
    expect(result.current.unlockedBundleIds.has('b1')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A list that mounts once the last read is old reads again, so a recipe
  // unlocked meanwhile shows; until the answer lands it draws the old one.
  it('reads again for a list that mounts later, drawing the last answer meanwhile', async () => {
    signIn('buyer-4');
    fetchMock.mockResolvedValueOnce(answer(['b1']));
    const first = renderHook(() => useViewerRecipeState());
    await waitFor(() => expect(first.result.current.unlockedBundleIds.has('b1')).toBe(true));
    first.unmount();

    const later = Date.now() + 31_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    fetchMock.mockResolvedValueOnce(answer(['b1', 'b2']));
    const second = renderHook(() => useViewerRecipeState());
    expect(second.result.current.unlockedBundleIds.has('b1')).toBe(true);
    await waitFor(() => expect(second.result.current.unlockedBundleIds.has('b2')).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The page is drawn on the server for everyone and hydrated as drawn: the
  // viewer's recipes arrive after that, whatever this tab has read.
  it('draws nothing of the viewer on the server', async () => {
    signIn('buyer-5');
    fetchMock.mockResolvedValue(answer(['b1']));
    const { result } = renderHook(() => useViewerRecipeState());
    await waitFor(() => expect(result.current.unlockedBundleIds.has('b1')).toBe(true));

    function Probe() {
      return <span>{useViewerRecipeState().unlockedBundleIds.size}</span>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe('<span>0</span>');
  });

  it('leaves the price on the cards when the read fails', async () => {
    signIn('buyer-6');
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'down' }) });
    const { result } = renderHook(() => useViewerRecipeState());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(result.current.unlockedBundleIds.size).toBe(0);
  });
});
