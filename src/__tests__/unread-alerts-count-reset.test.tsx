import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('@/lib/supabase-auth-cookie', () => ({ hasSupabaseAuthCookie: () => true }));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } },
}));

// The count lived in module state for a minute with no reset, so after a sign-out or an account
// switch the previous account's unread count stayed on the bell for up to a minute (audit
// 2026-11-27). A reset clears it and drops a read that was out for the account before.
describe('resetUnreadAlertsCount', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('clears the previous account\'s count at once and reads the next account\'s on the next look', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ unreadCount: 7 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const unread = await import('@/components/useUnreadAlertsCount');
    act(() => unread.publishUnreadAlertsCount(4));
    const { result, rerender } = renderHook(() => unread.useUnreadAlertsCount());
    expect(result.current).toBe(4);
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => unread.resetUnreadAlertsCount());
    expect(result.current).toBe(0);

    // The kept minute is over with the reset: the next look reads the new account's count.
    rerender();
    const fresh = renderHook(() => unread.useUnreadAlertsCount());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fresh.result.current).toBe(7);
  });

  it('drops a read that was out for the account before the reset', async () => {
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    const unread = await import('@/components/useUnreadAlertsCount');
    const { result } = renderHook(() => unread.useUnreadAlertsCount());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    act(() => unread.resetUnreadAlertsCount());
    await act(async () => {
      answer(new Response(JSON.stringify({ unreadCount: 9 }), { status: 200 }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(result.current).toBe(0);
  });

  it('is called by the shell on sign-out, when the session ends and when the signed-in user changes', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/components/AppShellAccount.tsx'), 'utf8');
    const leaveSignedOut = source.slice(source.indexOf('const leaveSignedOut'), source.indexOf('const sessionsEnding'));
    expect(leaveSignedOut).toContain('resetUnreadAlertsCount()');
    const clearAccountState = source.slice(source.indexOf('function clearAccountState'), source.indexOf('/**', source.indexOf('function clearAccountState')));
    expect(clearAccountState).toContain('resetUnreadAlertsCount()');
    expect(source).toMatch(/previousUnreadUserIdRef[\s\S]{0,400}resetUnreadAlertsCount\(\)/);
  });
});
