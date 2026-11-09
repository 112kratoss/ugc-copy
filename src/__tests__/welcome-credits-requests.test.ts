import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  session: { access_token: 'token-a', user: { id: 'a' } } as { access_token: string; user: { id: string } } | null,
  endPromise: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: harness.session } }),
    },
  },
}));

vi.mock('@/lib/welcome-promise', () => ({ endWelcomePromise: harness.endPromise }));

import { claimWelcomeCredits, readWelcomeCredits, WELCOME_REQUEST_TIMEOUT_MS } from '@/lib/welcome-credits-requests';

function answer(status: string) {
  return new Response(JSON.stringify({ status, amount: 25, credits: 25, identityComplete: true }), { status: 200 });
}

// Owner, 2026-11-09: "Any sign-in ends it". The signed-out promise ends where an account is seen
// signed in, the header and the name step (`welcome-promise.ts`), never from what the server says
// about an account's credits: an answer while the program is off would end it for a guest too
// (review of #746, where the proxy's refusal of a guest's token was all that stood in the way).
describe('welcome credit requests leave the signed-out promise alone', () => {
  beforeEach(() => {
    harness.session = { access_token: 'token-a', user: { id: 'a' } };
    harness.endPromise.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['eligible', 'already_claimed', 'legacy_ineligible', 'unavailable', 'requires_account'])(
    'on a read answered %s',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn(async () => answer(status)));
      await expect(readWelcomeCredits()).resolves.toMatchObject({ status });
      expect(harness.endPromise).not.toHaveBeenCalled();
    },
  );

  it('on a claim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer('claimed')));
    await expect(claimWelcomeCredits()).resolves.toMatchObject({ status: 'claimed' });
    expect(harness.endPromise).not.toHaveBeenCalled();
  });

  it('sends the token a component passes, and the browser session’s otherwise', async () => {
    const fetch = vi.fn(async () => answer('eligible'));
    vi.stubGlobal('fetch', fetch);
    await readWelcomeCredits({ accessToken: 'token-provider' });
    await readWelcomeCredits();
    const sent = fetch.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].headers as Record<string, string>);
    expect(sent.map((headers) => headers.Authorization)).toEqual(['Bearer token-provider', 'Bearer token-a']);
  });
});

describe('a welcome request that stalls (review of #744: the claim held the popup with no limit)', () => {
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
  });
});
