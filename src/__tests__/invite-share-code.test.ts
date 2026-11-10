import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INVITE_SHARE_CODE_MAX_AGE_MS,
  INVITE_SHARE_CODE_STORAGE_KEY,
  currentInviteShareCode,
  forgetInviteShareCode,
  holdStoredInviteShareCode,
  primeInviteShareCode,
  resetInviteShareCodeForTests,
} from '@/lib/invite-share-code';

const USER = 'user-1';
const OTHER_USER = 'user-2';
const CODE = '30b5f916c7aa';
const OTHER_CODE = 'aaaaaaaa1111';
const NOW = Date.parse('2026-11-10T06:00:00.000Z');

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  };
}

function stored(userId: string, code: string | null, readAt: number) {
  return { [INVITE_SHARE_CODE_STORAGE_KEY]: JSON.stringify({ userId, code, readAt }) };
}

function linkAnswer(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

// A share has to go out in the click that asked for it, so the sharer's invite
// code is fetched ahead of time and read synchronously. These hold the three
// things that makes possible: it is there from the first click after signing
// in, it is never another account's, and it costs one request a week.
describe('the signed-in account’s invite code, for its shares', () => {
  beforeEach(() => {
    resetInviteShareCodeForTests();
  });

  it('holds nothing until an account is known', () => {
    expect(currentInviteShareCode()).toBeNull();
  });

  it('asks the link route once, as the account, and holds and stores the answer', async () => {
    const storage = memoryStorage();
    const fetchImpl = linkAnswer({ success: true, code: CODE, shareUrl: `https://magicbooklet.com/r/${CODE}` });

    await expect(primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl }))
      .resolves.toBe(CODE);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchImpl).mock.calls[0]).toEqual(['/api/referrals/link', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
      body: '{}',
    }]);
    expect(currentInviteShareCode()).toBe(CODE);
    expect(JSON.parse(storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY)!)).toEqual({ userId: USER, code: CODE, readAt: NOW });
  });

  it('holds what the browser stored at once, with no request, for a week', async () => {
    const storage = memoryStorage(stored(USER, CODE, NOW - INVITE_SHARE_CODE_MAX_AGE_MS + 1));
    const fetchImpl = linkAnswer({ code: OTHER_CODE });

    // As the account becomes known, before any idle time.
    expect(holdStoredInviteShareCode(USER, storage)).toEqual({ code: CODE, readAt: NOW - INVITE_SHARE_CODE_MAX_AGE_MS + 1 });
    expect(currentInviteShareCode()).toBe(CODE);

    await expect(primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl }))
      .resolves.toBe(CODE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks again once the stored answer is a week old, sharing the old code meanwhile', async () => {
    const storage = memoryStorage(stored(USER, CODE, NOW - INVITE_SHARE_CODE_MAX_AGE_MS));
    let answer: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch;

    const priming = primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl });
    expect(currentInviteShareCode()).toBe(CODE);

    answer(new Response(JSON.stringify({ code: OTHER_CODE }), { status: 200 }));
    await expect(priming).resolves.toBe(OTHER_CODE);
    expect(currentInviteShareCode()).toBe(OTHER_CODE);
  });

  it('does not trust a stored time from the future', async () => {
    const storage = memoryStorage(stored(USER, CODE, NOW + 60_000));
    const fetchImpl = linkAnswer({ code: CODE });

    await primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('asks again when what is stored is not a code, never reading it as "no link"', async () => {
    for (const broken of ['NOT A CODE', 42, '', undefined]) {
      resetInviteShareCodeForTests();
      const storage = memoryStorage({
        [INVITE_SHARE_CODE_STORAGE_KEY]: JSON.stringify({ userId: USER, code: broken, readAt: NOW - 1000 }),
      });
      const fetchImpl = linkAnswer({ code: CODE });

      expect(holdStoredInviteShareCode(USER, storage)).toEqual({ code: null, readAt: null });
      await expect(primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl }))
        .resolves.toBe(CODE);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
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

  it('never hands one account another’s code', async () => {
    const storage = memoryStorage(stored(USER, CODE, NOW));

    // Another account signs in on this browser: what is stored is not theirs.
    expect(holdStoredInviteShareCode(OTHER_USER, storage)).toEqual({ code: null, readAt: null });
    expect(currentInviteShareCode()).toBeNull();

    await primeInviteShareCode({
      userId: OTHER_USER, accessToken: 'token-2', now: NOW, storage, fetchImpl: linkAnswer({ code: OTHER_CODE }),
    });
    expect(currentInviteShareCode()).toBe(OTHER_CODE);
  });

  it('keeps the account in front when an earlier account’s answer arrives late', async () => {
    const storage = memoryStorage();
    let answer: (response: Response) => void = () => undefined;
    const slow = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch;

    const first = primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl: slow });
    await primeInviteShareCode({
      userId: OTHER_USER, accessToken: 'token-2', now: NOW, storage, fetchImpl: linkAnswer({ code: OTHER_CODE }),
    });
    answer(new Response(JSON.stringify({ code: CODE }), { status: 200 }));
    await first;

    expect(currentInviteShareCode()).toBe(OTHER_CODE);
  });

  it('lets go of the code at sign-out and keeps it stored for the account’s return', async () => {
    const storage = memoryStorage();
    await primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl: linkAnswer({ code: CODE }) });

    forgetInviteShareCode();

    expect(currentInviteShareCode()).toBeNull();
    expect(holdStoredInviteShareCode(USER, storage).code).toBe(CODE);
  });

  it('remembers, for the week, that the account’s link is switched off', async () => {
    const storage = memoryStorage(stored(USER, CODE, NOW - INVITE_SHARE_CODE_MAX_AGE_MS));
    const fetchImpl = linkAnswer({ success: false, error: 'Your referral link is unavailable.' }, 503);

    await expect(primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl }))
      .resolves.toBeNull();

    // A switched-off link is not shared: the code it had is let go.
    expect(currentInviteShareCode()).toBeNull();
    expect(JSON.parse(storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY)!)).toEqual({ userId: USER, code: null, readAt: NOW });
    await primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW + 1000, storage, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a refusal', () => linkAnswer({ error: 'Unauthorized' }, 401)],
    ['a rate limit', () => linkAnswer({ error: 'Too many requests' }, 429)],
    ['an answer with no code', () => linkAnswer({ success: true })],
    ['an answer that is not JSON', () => vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch],
    ['a network failure', () => vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch],
  ])('keeps the code it had through %s, and stores nothing', async (_name, makeFetch) => {
    const storage = memoryStorage(stored(USER, CODE, NOW - INVITE_SHARE_CODE_MAX_AGE_MS));
    const before = storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY);

    await expect(primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage, fetchImpl: makeFetch() }))
      .resolves.toBe(CODE);

    expect(currentInviteShareCode()).toBe(CODE);
    expect(storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY)).toBe(before);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['another shape', JSON.stringify(['user-1', CODE])],
    ['a code that is not one', JSON.stringify({ userId: USER, code: 'DROP TABLE', readAt: NOW })],
    ['no time', JSON.stringify({ userId: USER, code: CODE })],
  ])('reads stored %s as nothing usable', (_name, value) => {
    const storage = memoryStorage({ [INVITE_SHARE_CODE_STORAGE_KEY]: value });

    expect(holdStoredInviteShareCode(USER, storage).code).toBeNull();
    expect(currentInviteShareCode()).toBeNull();
  });

  it('works in a browser that refuses storage, asking once a week per page', async () => {
    const refusing = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => undefined,
    };
    const fetchImpl = linkAnswer({ code: CODE });

    await primeInviteShareCode({ userId: USER, accessToken: 'token-1', now: NOW, storage: refusing, fetchImpl });
    await primeInviteShareCode({ userId: USER, accessToken: 'token-2', now: NOW + 3_600_000, storage: refusing, fetchImpl });
    await primeInviteShareCode({ userId: USER, accessToken: 'token-3', now: NOW, storage: null, fetchImpl });

    expect(currentInviteShareCode()).toBe(CODE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
