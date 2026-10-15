import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WelcomeRewardClient from '@/app/welcome-reward/WelcomeRewardClient';

const getSessionMock = vi.fn();
const authState = vi.hoisted(() => ({ updateCredits: vi.fn() }));
const searchState = vi.hoisted(() => ({ search: '' }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
    },
  },
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => authState,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchState.search),
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
    authState.updateCredits.mockReset();
    searchState.search = '';
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

  it('hands the balance the claim returned to the shell, so the creators stop reading 0', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => new Response(
      JSON.stringify(init?.method === 'POST'
        ? welcomeBody({ status: 'claimed', amount: 25, credits: 25, claimedAt: '2026-10-15T00:00:00.000Z' })
        : welcomeBody()),
      { status: 200 },
    )));

    render(<WelcomeRewardClient nextPath="/create" />);
    fireEvent.click(await screen.findByRole('button', { name: /claim 25 credits/i }));

    // AuthProvider's updateCredits sets the balance and dispatches
    // `credits_updated` with it; the header's own listener reads it there.
    await waitFor(() => {
      expect(authState.updateCredits).toHaveBeenCalledWith(25);
    });
    expect(authState.updateCredits).toHaveBeenCalledTimes(1);
  });

  it('reads the balance again when the claim says it was already claimed', async () => {
    // `credits` is the balance right after the earlier grant, stale once any of
    // it was spent (on the app, say), so it must not be set as the balance.
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => new Response(
      JSON.stringify(init?.method === 'POST'
        ? welcomeBody({ status: 'already_claimed', amount: 25, credits: 25, claimedAt: '2026-10-01T00:00:00.000Z' })
        : welcomeBody()),
      { status: 200 },
    )));
    const balanceEvents: Event[] = [];
    const onCreditsUpdated = (event: Event) => balanceEvents.push(event);
    window.addEventListener('credits_updated', onCreditsUpdated);

    try {
      render(<WelcomeRewardClient nextPath="/create" />);
      fireEvent.click(await screen.findByRole('button', { name: /claim 25 credits/i }));

      await waitFor(() => {
        expect(balanceEvents).toHaveLength(1);
      });
      expect((balanceEvents[0] as CustomEvent).detail ?? null).toBeNull();
      expect(authState.updateCredits).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('credits_updated', onCreditsUpdated);
    }
  });

  it('leaves the balance alone when nothing was claimed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => new Response(
      JSON.stringify(init?.method === 'POST'
        ? welcomeBody({ status: 'identity_already_claimed', credits: 0 })
        : welcomeBody()),
      { status: 200 },
    )));

    render(<WelcomeRewardClient nextPath="/create" />);
    fireEvent.click(await screen.findByRole('button', { name: /claim 25 credits/i }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome credits already claimed' })).toBeTruthy();
    expect(authState.updateCredits).not.toHaveBeenCalled();
  });

  it('says what happened to the invite a sign-up claimed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(welcomeBody()), { status: 200 })));
    const cases: Array<[string, RegExp]> = [
      ['next=%2Fcreate&referral=applied', /^Invite applied: your first verified credit-pack purchase gets the invite bonus\.$/],
      ['next=%2Fcreate&referral=existing_account', /invite bonuses are for new accounts only/i],
      ['next=%2Fcreate&referral=self_referral', /cannot use your own invite link/i],
      ['next=%2Fcreate&referral=already_attributed', /already has an inviter/i],
      ['next=%2Fcreate&referral=visit_unavailable', /no longer active/i],
      ['next=%2Fcreate&referral=not_applied', /not eligible for this invite/i],
    ];
    for (const [search, line] of cases) {
      searchState.search = search;
      const { unmount } = render(<WelcomeRewardClient nextPath="/create" />);
      await screen.findByRole('button', { name: /claim 25 credits/i });
      expect(screen.getByRole('status').textContent).toMatch(line);
      unmount();
    }
  });

  it('says nothing about invites when no claim ran', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(welcomeBody()), { status: 200 })));

    render(<WelcomeRewardClient nextPath="/create" />);
    await screen.findByRole('button', { name: /claim 25 credits/i });

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/invite/i)).toBeNull();
  });

  it('offers no registration route, which no web account can need', async () => {
    // A guest is the only caller the server answers `requires_account`, and the
    // web has no guest sessions; the proxy refuses a guest's token first.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify(welcomeBody({ status: 'requires_account', identityComplete: false })),
      { status: 200 },
    )));

    render(<WelcomeRewardClient nextPath="/create" />);

    expect(await screen.findByRole('link', { name: /start creating/i })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /create an account/i })).toBeNull();
    expect(screen.queryByText(/guest sessions/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull();
  });

  it('calls the grant "welcome credits", never the paid Creator pack', async () => {
    // Mobile renamed it in #209 (App Review 2.1(b)): the free grant was named
    // "Creator Pack" like the paid Creator credit pack, and a guest was told to
    // "unlock" it by creating an account. The web page kept the old copy.
    const cases: Array<[WelcomeBody, string]> = [
      [welcomeBody(), 'Claim your welcome credits'],
      [welcomeBody({ status: 'claimed', credits: 25, promotionalCredits: 25, claimedAt: '2026-08-25T00:00:00.000Z' }), 'Your welcome credits are ready'],
      [welcomeBody({ status: 'legacy_ineligible', credits: 25 }), 'Your welcome credits are ready'],
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
