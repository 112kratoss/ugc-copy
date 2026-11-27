import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AlertsBadge from '@/components/AlertsBadge';
import { publishUnreadAlertsCount } from '@/components/useUnreadAlertsCount';

vi.mock('next/navigation', () => ({
    usePathname: () => '/',
}));

const mocks = vi.hoisted(() => ({ hasAuthCookie: vi.fn(() => true), supabaseLoaded: vi.fn() }));

vi.mock('@/lib/supabase-auth-cookie', () => ({ hasSupabaseAuthCookie: mocks.hasAuthCookie }));

vi.mock('@/lib/supabase', () => {
    mocks.supabaseLoaded();
    return {
        supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } },
    };
});

describe('AlertsBadge', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('shows the unread count the app shows on its Alerts tab, and clears when told', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ unreadCount: 3 }) })));
        render(<AlertsBadge />);

        // The count's words are text a screen reader reads: an aria-label on a plain span is not
        // allowed to name it, and some readers skip it. The figure itself is hidden from them.
        const words = await screen.findByText('3 unread alerts');
        const pill = words.parentElement!;
        expect(pill).not.toHaveAttribute('aria-label');
        expect(words.className.split(' ')).toContain('sr-only');
        expect(within(pill).getByText('3')).toHaveAttribute('aria-hidden', 'true');

        act(() => publishUnreadAlertsCount(0));

        expect(screen.queryByText(/unread alerts/)).not.toBeInTheDocument();
    });

    it('loads no Supabase client and asks nothing in a browser with no session cookie', async () => {
        vi.resetModules();
        mocks.hasAuthCookie.mockReturnValue(false);
        mocks.supabaseLoaded.mockClear();
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ unreadCount: 5 }) }));
        vi.stubGlobal('fetch', fetchMock);
        const { default: FreshBadge } = await import('@/components/AlertsBadge');
        render(<FreshBadge />);

        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        expect(mocks.supabaseLoaded).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.queryByText(/unread alerts/)).not.toBeInTheDocument();
    });
});
