import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WelcomeRewardClient from '@/app/welcome-reward/WelcomeRewardClient';

const getSessionMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
    },
  },
}));

type WelcomeBody = {
  status: string;
  amount: number;
  credits: number;
  promotionalCredits: number;
  claimedAt: string | null;
  identityComplete: boolean;
};

function welcomeBody(overrides: Partial<WelcomeBody> = {}): WelcomeBody {
  return {
    status: 'eligible',
    amount: 25,
    credits: 0,
    promotionalCredits: 0,
    claimedAt: null,
    identityComplete: true,
    ...overrides,
  };
}

/**
 * The claim animation is driven by requestAnimationFrame against
 * `performance.now()`. jsdom provides both, but nothing advances the clock, so
 * the callback would re-queue forever at progress 0. Draining frames with a
 * stubbed clock lets the count-up run to completion deterministically.
 */
function installFrameClock() {
  let now = 0;
  const pending: FrameRequestCallback[] = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pending.push(callback);
    return pending.length;
  });
  return async function drain(milliseconds: number) {
    now += milliseconds;
    while (pending.length) {
      const callback = pending.shift();
      callback?.(now);
    }
  };
}

describe('WelcomeRewardClient', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token' } } });
  });

  it('offers the claim button while the grant is eligible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(welcomeBody()), { status: 200 })));

    render(<WelcomeRewardClient nextPath="/create" />);

    expect(await screen.findByRole('button', { name: /claim 25 credits/i })).toBeTruthy();
  });

  it('counts the credits up and fires confetti once the claim lands', async () => {
    const drain = installFrameClock();
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => new Response(
      JSON.stringify(init?.method === 'POST'
        ? welcomeBody({ status: 'claimed', credits: 25, promotionalCredits: 25, claimedAt: '2026-08-25T00:00:00.000Z' })
        : welcomeBody()),
      { status: 200 },
    )));

    const { container } = render(<WelcomeRewardClient nextPath="/create" />);
    fireEvent.click(await screen.findByRole('button', { name: /claim 25 credits/i }));

    // Celebration starts at zero, not at the final amount.
    await waitFor(() => {
      expect(container.querySelector('.welcome-reward-count.is-celebrating')).toBeTruthy();
    });
    expect(container.querySelectorAll('.welcome-reward-confetti')).toHaveLength(14);

    await drain(900);

    await waitFor(() => {
      expect(screen.getByText('25')).toBeTruthy();
    });
  });

  it('skips the animation when the viewer prefers reduced motion', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => new Response(
      JSON.stringify(init?.method === 'POST'
        ? welcomeBody({ status: 'claimed', credits: 25 })
        : welcomeBody()),
      { status: 200 },
    )));

    const { container } = render(<WelcomeRewardClient nextPath="/create" />);
    fireEvent.click(await screen.findByRole('button', { name: /claim 25 credits/i }));

    await waitFor(() => {
      expect(screen.getByText('25')).toBeTruthy();
    });
    // No pop, no confetti — the final number is simply present.
    expect(container.querySelector('.is-celebrating')).toBeNull();
    expect(container.querySelectorAll('.welcome-reward-confetti')).toHaveLength(0);
  });

  it('sends a guest to registration instead of an unreachable claim', async () => {
    // `requires_account` is the status a guest gets. The old `not_eligible`
    // rendering offered no route forward at all, because the copy asked for a
    // creator name that PATCH /api/profile refuses to set for anonymous users.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify(welcomeBody({ status: 'requires_account', identityComplete: false })),
      { status: 200 },
    )));

    render(<WelcomeRewardClient nextPath="/create" />);

    const signUp = await screen.findByRole('link', { name: /create an account/i });
    expect(signUp.getAttribute('href')).toContain('mode=signup');
    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull();
    expect(screen.getByText(/guest sessions cannot hold a welcome reward/i)).toBeTruthy();
  });

  it('calls the grant "welcome credits", never the paid Creator pack', async () => {
    // Mobile renamed it in #209 (App Review 2.1(b)): the free grant was named
    // "Creator Pack" like the paid Creator credit pack, and a guest was told to
    // "unlock" it by creating an account. The web page kept the old copy.
    const cases: Array<[WelcomeBody, string]> = [
      [welcomeBody(), 'Claim your welcome credits'],
      [welcomeBody({ status: 'claimed', credits: 25, promotionalCredits: 25, claimedAt: '2026-08-25T00:00:00.000Z' }), 'Your welcome credits are ready'],
      [welcomeBody({ status: 'legacy_ineligible', credits: 25 }), 'Your welcome credits are ready'],
      [welcomeBody({ status: 'requires_account', identityComplete: false }), 'Claim your welcome credits'],
      [welcomeBody({ status: 'identity_already_claimed' }), 'Welcome credits already claimed'],
    ];
    for (const [body, heading] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
      const { unmount } = render(<WelcomeRewardClient nextPath="/create" />);
      expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
      expect(screen.queryByText(/creator pack/i)).toBeNull();
      expect(screen.queryByText(/unlock/i)).toBeNull();
      unmount();
    }
  });

  it('shows a number only to someone about to receive credits or who just did', async () => {
    // For every other status `amount` is the program default, so an account that
    // predates the program was shown "Your welcome credits are ready" and "25".
    const cases: Array<[WelcomeBody, string, boolean]> = [
      [welcomeBody(), 'Claim your welcome credits', true],
      [welcomeBody({ status: 'claimed', credits: 25, promotionalCredits: 25, claimedAt: '2026-08-25T00:00:00.000Z' }), 'Your welcome credits are ready', true],
      [welcomeBody({ status: 'legacy_ineligible', credits: 25 }), 'Your welcome credits are ready', false],
      [welcomeBody({ status: 'not_eligible' }), 'Finish your creator profile first', false],
      [welcomeBody({ status: 'unavailable' }), 'Welcome credits are unavailable right now', false],
      [welcomeBody({ status: 'identity_already_claimed' }), 'Welcome credits already claimed', false],
    ];
    for (const [body, heading, showsAmount] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
      const { unmount } = render(<WelcomeRewardClient nextPath="/create" />);
      expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
      expect(Boolean(screen.queryByText('25'))).toBe(showsAmount);
      unmount();
    }
  });

  it('sends an incomplete profile to the editor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(welcomeBody({ status: 'not_eligible' })), { status: 200 })));
    render(<WelcomeRewardClient nextPath="/create" />);
    const link = await screen.findByRole('link', { name: /finish creator profile/i });
    expect(link.getAttribute('href')).toBe('/profile/edit');
  });

  it('names the welcome credits when they cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '' }), { status: 503 })));

    render(<WelcomeRewardClient nextPath="/create" />);

    expect((await screen.findByRole('alert')).textContent).toBe('Could not load your welcome credits.');
    expect(screen.getByRole('heading', { level: 1, name: 'Your welcome credits' })).toBeTruthy();
    expect(screen.queryByText(/creator pack/i)).toBeNull();
  });
});
