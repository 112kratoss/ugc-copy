import { act, cleanup, render, screen } from '@testing-library/react';
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

        expect(await screen.findByLabelText('3 unread alerts')).toHaveTextContent('3');

        act(() => publishUnreadAlertsCount(0));

        expect(screen.queryByLabelText(/unread alerts/)).not.toBeInTheDocument();
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
        expect(screen.queryByLabelText(/unread alerts/)).not.toBeInTheDocument();
    });
});
