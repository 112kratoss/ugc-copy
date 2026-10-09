import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import WelcomeCreditsCard from '@/app/home/WelcomeCreditsCard';

vi.mock('@/lib/supabase', () => ({
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } },
}));

function mockWelcome(body: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })));
}

describe('WelcomeCreditsCard', () => {
    let now = Date.parse('2026-10-09T00:00:00.000Z');

    beforeEach(() => {
        // The card shares one read for a few seconds; each case is a fresh visit.
        now += 60_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('asks an account without a claimed handle to finish its setup first', async () => {
        mockWelcome({ status: 'not_eligible', amount: 25, identityComplete: false });
        render(<WelcomeCreditsCard />);

        const link = await screen.findByRole('link', { name: /Finish your creator setup/ });
        expect(link).toHaveAttribute('href', expect.stringMatching(/^\/profile\?welcome=1&next=/));
    });

    it('offers the credits once the setup is done', async () => {
        mockWelcome({ status: 'eligible', amount: 25, identityComplete: true });
        render(<WelcomeCreditsCard />);

        const link = await screen.findByRole('link', { name: /welcome credits are waiting/ });
        expect(link).toHaveAttribute('href', '/welcome-reward?next=%2F');
        expect(screen.getByText('Claim 25 creation credits.')).toBeInTheDocument();
    });

    it('shows nothing once the credits are claimed', async () => {
        mockWelcome({ status: 'already_claimed', amount: 25, identityComplete: true });
        const { container } = render(<WelcomeCreditsCard />);

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(container).toBeEmptyDOMElement();
    });
});
