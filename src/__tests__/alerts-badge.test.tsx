import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AlertsBadge from '@/components/AlertsBadge';
import { publishUnreadAlertsCount } from '@/components/useUnreadAlertsCount';

vi.mock('next/navigation', () => ({
    usePathname: () => '/',
}));

vi.mock('@/lib/supabase', () => ({
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } },
}));

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
});
