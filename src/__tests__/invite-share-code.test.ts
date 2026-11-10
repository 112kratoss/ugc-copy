import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INVITE_SHARE_CODE_STORAGE_KEY,
  currentInviteShareCode,
  forgetInviteShareCode,
  holdStoredInviteShareCode,
  primeInviteShareCode,
  resetInviteShareCodeForTests,
} from '@/lib/invite-share-code';
import {
  INVITE_SHARE_CODE_RETRY_DELAYS_MS,
  INVITE_SHARE_NO_LINK_RECHECK_MS,
} from '../../ugc-mobile/lib/invite-share-link/invite-share-code-policy';

const USER = 'user-1';
const OTHER_USER = 'user-2';
const CODE = '30b5f916c7aa';
const OTHER_CODE = 'aaaaaaaa1111';
const NOW = Date.parse('2026-11-10T06:00:00.000Z');

function sessionCookie(userId: string) {
  const session = JSON.stringify({ access_token: 'token', user: { id: userId } });
  return `theme=dark; sb-example-auth-token=base64-${Buffer.from(session).toString('base64url')}`;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  };
}

function stored(entries: Record<string, { code: unknown; readAt: number }>) {
  return { [INVITE_SHARE_CODE_STORAGE_KEY]: JSON.stringify(entries) };
}

function linkAnswer(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

// A share has to go out in the click that asked for it, so the sharer's invite
// code is fetched ahead of time and read synchronously. The rules for keeping
// it are the app's too (`invite-share-code-policy.ts`).
describe('the signed-in account’s invite code, for its shares', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    resetInviteShareCodeForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('holds nothing until an account is known', () => {
    expect(currentInviteShareCode(sessionCookie(USER))).toBeNull();
  });

  it('asks the link route once, as the account, and holds and stores the answer under it', async () => {
    const storage = memoryStorage();
    const fetchImpl = linkAnswer({ success: true, code: CODE, shareUrl: `https://magicbooklet.com/r/${CODE}` });

    await expect(primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl }))
      .resolves.toBe(CODE);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]).toEqual(['/api/referrals/link', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
      body: '{}',
    }]);
    expect(currentInviteShareCode(sessionCookie(USER))).toBe(CODE);
    expect(JSON.parse(storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY)!)).toEqual({ [USER]: { code: CODE, readAt: NOW } });
  });

  // A code never changes (a trigger keeps it): no weekly re-ask (review of 2026-11-10).
  it('holds a stored code at once and keeps it for good, with no request', async () => {
    const storage = memoryStorage(stored({ [USER]: { code: CODE, readAt: NOW - 365 * 24 * 60 * 60 * 1000 } }));
    const fetchImpl = linkAnswer({ code: OTHER_CODE });

    expect(holdStoredInviteShareCode(USER, storage, NOW)).toEqual({ code: CODE, readAt: NOW - 365 * 24 * 60 * 60 * 1000 });
    expect(currentInviteShareCode(sessionCookie(USER))).toBe(CODE);
    await expect(primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl }))
      .resolves.toBe(CODE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the codes of accounts that take turns in one browser', async () => {
    const storage = memoryStorage(stored({ [OTHER_USER]: { code: OTHER_CODE, readAt: NOW - 1000 } }));
    const fetchImpl = linkAnswer({ code: CODE });

    await primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl });
    forgetInviteShareCode();
    await expect(primeInviteShareCode({ userId: OTHER_USER, accessToken: 'token-2', now: NOW, storage, fetchImpl }))
      .resolves.toBe(OTHER_CODE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never hands one account another’s code, at the share or before it', async () => {
    const storage = memoryStorage(stored({ [OTHER_USER]: { code: OTHER_CODE, readAt: NOW - 1000 } }));
    holdStoredInviteShareCode(USER, storage, NOW);
    expect(currentInviteShareCode(sessionCookie(USER))).toBeNull();

    holdStoredInviteShareCode(OTHER_USER, storage, NOW);
    // Another account's session in this browser now: not this code.
    expect(currentInviteShareCode(sessionCookie(USER))).toBeNull();
  });

  // A sign-out made where no auth provider runs never reached the holder.
  it('lets go of the code at a share when the browser has no session any more', () => {
    const storage = memoryStorage(stored({ [USER]: { code: CODE, readAt: NOW - 1000 } }));
    holdStoredInviteShareCode(USER, storage, NOW);

    expect(currentInviteShareCode('theme=dark')).toBeNull();
    // Gone for good: the session coming back does not bring an old hold back.
    expect(currentInviteShareCode(sessionCookie(USER))).toBeNull();
  });

  it('keeps the account in front when an earlier account’s answer arrives late', async () => {
    const storage = memoryStorage();
    let answer: (response: Response) => void = () => undefined;
    const slow = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch;

    const first = primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl: slow });
    holdStoredInviteShareCode(OTHER_USER, storage, NOW);
    await primeInviteShareCode({ userId: OTHER_USER, accessToken: 'token-2', now: NOW, storage, fetchImpl: linkAnswer({ code: OTHER_CODE }) });

    answer(new Response(JSON.stringify({ code: CODE }), { status: 200 }));
    await first;
    expect(currentInviteShareCode(sessionCookie(OTHER_USER))).toBe(OTHER_CODE);
  });

  // Only the server's "switched off" answer means there is no link; an outage
  // was stored as "no link" for a week (review of 2026-11-10).
  it('remembers a switched-off link for a day, and asks again after it', async () => {
    const storage = memoryStorage();
    const fetchImpl = linkAnswer({ success: false, error: 'Your invite link is switched off.', code: 'REFERRAL_LINK_DISABLED' }, 409);

    await expect(primeInviteShareCode({ userId: USER, accessToken: 't', now: NOW, storage, fetchImpl })).resolves.toBeNull();
    expect(JSON.parse(storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY)!)).toEqual({ [USER]: { code: null, readAt: NOW } });

    await primeInviteShareCode({ userId: USER, accessToken: 't', now: NOW + INVITE_SHARE_NO_LINK_RECHECK_MS - 1, storage, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await primeInviteShareCode({ userId: USER, accessToken: 't', now: NOW + INVITE_SHARE_NO_LINK_RECHECK_MS, storage, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an outage', { success: false, error: 'Your referral link is unavailable.' }, 503],
    ['an identity check that could not run', { error: 'Identity check unavailable', code: 'IDENTITY_CHECK_UNAVAILABLE' }, 503],
    ['a refused token', { error: 'Unauthorized' }, 401],
    ['a rate limit', { error: 'Too many requests.' }, 429],
    ['an answer with no code', { success: true }, 200],
  ])('keeps the code it had through %s, stores nothing, and waits before asking again', async (_name, body, status) => {
    const storage = memoryStorage(stored({ [USER]: { code: null, readAt: NOW - INVITE_SHARE_NO_LINK_RECHECK_MS } }));
    const fetchImpl = linkAnswer(body, status);

    await expect(primeInviteShareCode({ userId: USER, accessToken: 't', now: NOW, storage, fetchImpl })).resolves.toBeNull();
    expect(JSON.parse(storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY)!)).toEqual({ [USER]: { code: null, readAt: NOW - INVITE_SHARE_NO_LINK_RECHECK_MS } });

    await primeInviteShareCode({ userId: USER, accessToken: 't', now: NOW + INVITE_SHARE_CODE_RETRY_DELAYS_MS[0] - 1, storage, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await primeInviteShareCode({ userId: USER, accessToken: 't', now: NOW + INVITE_SHARE_CODE_RETRY_DELAYS_MS[0], storage, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps the code through a network failure', async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    await expect(primeInviteShareCode({ userId: USER, accessToken: 't', now: NOW, storage, fetchImpl })).resolves.toBeNull();
    expect(storage.items.has(INVITE_SHARE_CODE_STORAGE_KEY)).toBe(false);
  });

  it('never asks twice at once for one account', async () => {
    const storage = memoryStorage();
    const fetchImpl = linkAnswer({ code: CODE });

    const answers = await Promise.all([
      primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl }),
      primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl }),
    ]);

    expect(answers).toEqual([CODE, CODE]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('works in a browser that refuses storage, asking once a page', async () => {
    const fetchImpl = linkAnswer({ code: CODE });

    await expect(primeInviteShareCode({ userId: USER, accessToken: 't', now: NOW, storage: null, fetchImpl })).resolves.toBe(CODE);
    forgetInviteShareCode();
    await expect(primeInviteShareCode({ userId: USER, accessToken: 't', now: NOW + 1000, storage: null, fetchImpl })).resolves.toBe(CODE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
