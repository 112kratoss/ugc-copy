import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import WelcomeCreditsCard from '@/app/home/WelcomeCreditsCard';

vi.mock('@/lib/supabase', () => ({
    supabase: {
        auth: { getSession: async () => ({ data: { session: { access_token: 'token', user: { id: 'user-1' } } } }) },
    },
}));

/** Lets the shared status read land, inside act: the card renders nothing until then. */
async function settle() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

function mockWelcome(body: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })));
}

describe('WelcomeCreditsCard', () => {
    let now = Date.parse('2026-10-09T00:00:00.000Z');

    function nextVisit() {
        // The card shares one read for a few seconds; a visit after that reads again.
        now += 60_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
    }

    beforeEach(() => {
        nextVisit();
        window.localStorage.clear();
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

    // The app asks every account without a claimed identity, whatever the
    // credit status says; the web asked only `not_eligible` and `eligible`.
    it.each(['legacy_ineligible', 'unavailable', 'identity_already_claimed'])(
        'asks a %s account without a claimed handle too',
        async (status) => {
            mockWelcome({ status, amount: 25, identityComplete: false });
            render(<WelcomeCreditsCard />);

            expect(await screen.findByRole('link', { name: /Finish your creator setup/ })).toBeInTheDocument();
        },
    );

    it('stops asking once the creator chooses Later, on both copies and on the next visit', async () => {
        mockWelcome({ status: 'legacy_ineligible', amount: 25, identityComplete: false });
        // The strip and the rail each draw the card; the stylesheet shows one.
        render(<><WelcomeCreditsCard /><WelcomeCreditsCard /></>);
        expect(await screen.findAllByRole('link', { name: /Finish your creator setup/ })).toHaveLength(2);

        fireEvent.click(screen.getAllByRole('button', { name: 'Finish your creator setup later' })[0]);

        expect(screen.queryByRole('link', { name: /Finish your creator setup/ })).not.toBeInTheDocument();

        cleanup();
        nextVisit();
        const { container } = render(<WelcomeCreditsCard />);
        await settle();
        expect(container).toBeEmptyDOMElement();
    });

    it('never asks a guest, who has no handle to claim', async () => {
        mockWelcome({ status: 'requires_account', amount: 25, identityComplete: false });
        const { container } = render(<WelcomeCreditsCard />);

        await settle();
        expect(container).toBeEmptyDOMElement();
    });

    it('offers the credits once the setup is done', async () => {
        mockWelcome({ status: 'eligible', amount: 25, identityComplete: true });
        render(<WelcomeCreditsCard />);

        const link = await screen.findByRole('link', { name: /welcome credits are waiting/ });
        expect(link).toHaveAttribute('href', '/welcome-reward?next=%2F');
        expect(screen.getByText('Claim 25 creation credits.')).toBeInTheDocument();
        // Later belongs to the setup prompt; the credits keep their own way back.
        expect(screen.queryByRole('button', { name: /later/i })).not.toBeInTheDocument();
    });

    it('shows nothing once the credits are claimed', async () => {
        mockWelcome({ status: 'already_claimed', amount: 25, identityComplete: true });
        const { container } = render(<WelcomeCreditsCard />);

        await settle();
        expect(container).toBeEmptyDOMElement();
    });
});
