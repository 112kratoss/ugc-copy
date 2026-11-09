import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  sessions: [] as Array<{ access_token: string; user: { id: string } } | null>,
  record: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      // Each call takes the next session: the first is read before the request, the second after it.
      getSession: async () => ({ data: { session: harness.sessions.length > 1 ? harness.sessions.shift()! : harness.sessions[0] } }),
    },
  },
}));

vi.mock('@/lib/welcome-promise', () => ({ recordWelcomeAnswer: harness.record }));

import { claimWelcomeCredits, readWelcomeCredits } from '@/lib/welcome-credits-requests';

const signedIn = (id: string) => ({ access_token: `token-${id}`, user: { id } });

function answer(status: string) {
  return new Response(JSON.stringify({ status, amount: 25, credits: 25, identityComplete: true }), { status: 200 });
}

describe('welcome credit requests teach the browser what its account was told', () => {
  beforeEach(() => {
    harness.sessions = [];
    harness.record.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('records a read for the account still signed in', async () => {
    harness.sessions = [signedIn('a'), signedIn('a')];
    vi.stubGlobal('fetch', vi.fn(async () => answer('already_claimed')));
    await expect(readWelcomeCredits()).resolves.toMatchObject({ status: 'already_claimed' });
    expect(harness.record).toHaveBeenCalledWith('already_claimed');
  });

  it('records a claim, so a sign-out afterwards stops the promise', async () => {
    harness.sessions = [signedIn('a'), signedIn('a')];
    vi.stubGlobal('fetch', vi.fn(async () => answer('claimed')));
    await claimWelcomeCredits();
    expect(harness.record).toHaveBeenCalledWith('claimed');
  });

  it('records nothing when another account signed in while the request ran', async () => {
    harness.sessions = [signedIn('a'), signedIn('b')];
    vi.stubGlobal('fetch', vi.fn(async () => answer('claimed')));
    await readWelcomeCredits();
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('records nothing when the account signed out while the request ran', async () => {
    harness.sessions = [signedIn('a'), null];
    vi.stubGlobal('fetch', vi.fn(async () => answer('claimed')));
    await readWelcomeCredits();
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('records nothing for a refused request', async () => {
    harness.sessions = [signedIn('a'), signedIn('a')];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })));
    await expect(readWelcomeCredits()).rejects.toThrow('nope');
    expect(harness.record).not.toHaveBeenCalled();
  });
});
