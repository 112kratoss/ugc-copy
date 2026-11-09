import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  sessions: [] as Array<{ access_token: string; user: { id: string } } | null>,
  endPromise: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      // Each call takes the next session.
      getSession: async () => ({ data: { session: harness.sessions.length > 1 ? harness.sessions.shift()! : harness.sessions[0] } }),
    },
  },
}));

vi.mock('@/lib/welcome-promise', () => ({ endWelcomePromise: harness.endPromise }));

import { claimWelcomeCredits, readWelcomeCredits, WELCOME_REQUEST_TIMEOUT_MS } from '@/lib/welcome-credits-requests';

const signedIn = (id: string) => ({ access_token: `token-${id}`, user: { id } });

function answer(status: string) {
  return new Response(JSON.stringify({ status, amount: 25, credits: 25, identityComplete: true }), { status: 200 });
}

// Owner, 2026-11-09, shown that an account from before the program kept the promise: "Any sign-in
// ends it". An answer from the server is an account signed in on this browser, which is all the
// signed-out promise needs to know; what the answer says plays no part. The header ends it on every
// page with the top bar; this covers the name step, which has none.
describe('welcome credit requests end the signed-out promise in this browser', () => {
  beforeEach(() => {
    harness.sessions = [];
    harness.endPromise.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['legacy_ineligible', 'eligible', 'not_eligible', 'already_claimed', 'identity_already_claimed', 'unavailable'])(
    'on a read answered %s',
    async (status) => {
      harness.sessions = [signedIn('a')];
      vi.stubGlobal('fetch', vi.fn(async () => answer(status)));
      await expect(readWelcomeCredits()).resolves.toMatchObject({ status });
      expect(harness.endPromise).toHaveBeenCalledTimes(1);
    },
  );

  it('on a claim', async () => {
    harness.sessions = [signedIn('a')];
    vi.stubGlobal('fetch', vi.fn(async () => answer('claimed')));
    await claimWelcomeCredits();
    expect(harness.endPromise).toHaveBeenCalledTimes(1);
  });

  it('even when the account signed out while the request ran: it was signed in here', async () => {
    harness.sessions = [signedIn('a'), null];
    vi.stubGlobal('fetch', vi.fn(async () => answer('already_claimed')));
    await readWelcomeCredits();
    expect(harness.endPromise).toHaveBeenCalledTimes(1);
  });

  it('not for a guest’s answer', async () => {
    harness.sessions = [signedIn('guest')];
    vi.stubGlobal('fetch', vi.fn(async () => answer('requires_account')));
    await readWelcomeCredits();
    expect(harness.endPromise).not.toHaveBeenCalled();
  });

  it('not for a refused request', async () => {
    harness.sessions = [signedIn('a')];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })));
    await expect(readWelcomeCredits()).rejects.toThrow('nope');
    expect(harness.endPromise).not.toHaveBeenCalled();
  });
});

describe('a welcome request that stalls (review of #744: the claim held the popup with no limit)', () => {
  beforeEach(() => {
    harness.sessions = [signedIn('a')];
    harness.endPromise.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gives up after the app’s API timeout, so the popup offers Try again', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const claim = claimWelcomeCredits();
    const settled = claim.then(() => 'resolved', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(WELCOME_REQUEST_TIMEOUT_MS);
    await expect(settled).resolves.toBe('Your credits could not be added. Try again.');
    expect(harness.endPromise).not.toHaveBeenCalled();
  });
});
