import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ session: null as { access_token: string } | null, user: null as { id: string } | null }));
vi.mock('@/components/AuthProvider', () => ({ useAuth: () => authState }));

import { useViewerRecipeState } from '@/app/marketplace/useViewerRecipeState';

describe('useViewerRecipeState', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    authState.session = null;
    authState.user = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks nothing for a signed-out viewer', () => {
    const { result } = renderHook(() => useViewerRecipeState());
    expect(result.current).toEqual({ viewerUserId: null, unlockedBundleIds: new Set() });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the signed-in viewer's recipes once, with their token", async () => {
    authState.session = { access_token: 'token-1' };
    authState.user = { id: 'buyer-1' };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, bundleIds: ['b1', 7, 'b2'] }) });
    const { result, rerender } = renderHook(() => useViewerRecipeState());
    expect(result.current.viewerUserId).toBe('buyer-1');
    await waitFor(() => expect(result.current.unlockedBundleIds.has('b1')).toBe(true));
    expect(Array.from(result.current.unlockedBundleIds)).toEqual(['b1', 'b2']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/me/unlocked-recipes');
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer token-1');
    rerender();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the price on the cards when the read fails', async () => {
    authState.session = { access_token: 'token-1' };
    authState.user = { id: 'buyer-1' };
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'down' }) });
    const { result } = renderHook(() => useViewerRecipeState());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.unlockedBundleIds.size).toBe(0);
  });
});
