import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  auth: { session: null as { access_token: string } | null, user: null as { id: string } | null, isLoading: false },
  hasAuthCookie: false,
  cookieUserId: null as string | null,
  viewerCheck: 'unread' as 'unread' | 'checking' | 'visitor' | 'signed-in',
}));
vi.mock('@/components/AuthProvider', () => ({ useAuth: () => state.auth }));
vi.mock('@/components/useSupabaseAuthCookieHint', () => ({
  useSupabaseAuthCookieHint: () => state.hasAuthCookie,
  useHasHydratedSupabaseAuthCookieHint: () => state.viewerCheck !== 'unread',
}));
vi.mock('@/lib/supabase-auth-cookie', () => ({ readSupabaseAuthCookieUserId: () => state.cookieUserId }));
vi.mock('@/lib/viewer-session-check', () => ({ useViewerSessionCheck: () => state.viewerCheck }));

import { useCreatorOwnershipResolver } from '@/lib/creator-ownership';

// The Marketplace's tiles are many sellers': whose each is, as the page knows it at a render, read
// once for every tile (sweep of 2026-11-17: a seller's own cards read "Free recipe" until the page's
// session check named them).
describe('useCreatorOwnershipResolver', () => {
  beforeEach(() => {
    state.auth = { session: null, user: null, isLoading: false };
    state.hasAuthCookie = false;
    state.cookieUserId = null;
    state.viewerCheck = 'unread';
  });

  it("is unread for every seller a style rule can name in the server's HTML and the render that hydrates it", () => {
    state.hasAuthCookie = true;
    state.cookieUserId = 'seller-1';
    const { result } = renderHook(() => useCreatorOwnershipResolver());
    expect(result.current('seller-1')).toBe('unread');
    expect(result.current('seller-2')).toBe('unread');
    expect(result.current('seller"] *{display:none} [x="')).toBe('other');
    expect(result.current(null)).toBe('other');
  });

  it('names the seller the session cookie holds while the check is out, and no one else', () => {
    state.auth = { session: null, user: null, isLoading: true };
    state.hasAuthCookie = true;
    state.cookieUserId = 'seller-1';
    state.viewerCheck = 'checking';
    const { result } = renderHook(() => useCreatorOwnershipResolver());
    expect(result.current('seller-1')).toBe('owner-checking');
    expect(result.current('seller-2')).toBe('other');
  });

  it('names the viewer the check has named, and keeps one function while nothing changes', () => {
    state.auth = { session: { access_token: 'token' }, user: { id: 'seller-2' }, isLoading: false };
    state.hasAuthCookie = true;
    state.viewerCheck = 'signed-in';
    const { result, rerender } = renderHook(() => useCreatorOwnershipResolver());
    const first = result.current;
    expect(first('seller-2')).toBe('owner');
    expect(first('seller-1')).toBe('other');
    rerender();
    expect(result.current).toBe(first);
  });

  it('is anyone else for a visitor, and once a check has ended with no one', () => {
    state.viewerCheck = 'visitor';
    const { result } = renderHook(() => useCreatorOwnershipResolver());
    expect(result.current('seller-1')).toBe('other');
  });
});
