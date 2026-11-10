import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

import {
  INVITE_SHARE_CODE_MAX_AGE_MS,
  INVITE_SHARE_CODE_STORAGE_KEY,
  primeInviteShareCode,
  resetInviteShareCodePrimingForTests,
} from '../lib/invite-share-code';
import {
  currentInviteShareCode,
  forgetInviteShareCode,
  holdInviteShareCode,
} from '../lib/invite-share-code-state';

const USER = 'user-1';
const OTHER_USER = 'user-2';
const CODE = '30b5f916c7aa';
const OTHER_CODE = 'aaaaaaaa1111';
const NOW = Date.parse('2026-11-10T06:00:00.000Z');

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: vi.fn(async (key: string) => items.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      items.set(key, value);
    }),
  };
}

function stored(userId: string, code: unknown, readAt: number) {
  return { [INVITE_SHARE_CODE_STORAGE_KEY]: JSON.stringify({ userId, code, readAt }) };
}

function linkApi(answer: () => Promise<unknown> = async () => ({ success: true, code: CODE, shareUrl: `https://magicbooklet.com/r/${CODE}` })) {
  return { createReferralLink: vi.fn(answer) } as never as {
    createReferralLink: ReturnType<typeof vi.fn> & (() => Promise<never>);
  };
}

function switchedOff() {
  return Object.assign(new Error('Invite links are unavailable.'), { status: 503 });
}

/** Lets the storage read and the request that follows it run. */
async function settle() {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

// A share opens its sheet at the tap, so the sharer's invite code is asked for
// ahead of time and read synchronously (`buildShareUrl`). These hold what that
// rests on: the code is there after one request, it is never another account's,
// and a phone asks for it once a week.
describe("the signed-in account's invite code, for the links the app shares", () => {
  beforeEach(() => {
    forgetInviteShareCode();
    resetInviteShareCodePrimingForTests();
  });

  it('holds nothing until an account is known', () => {
    expect(currentInviteShareCode()).toBeNull();
  });

  it('asks for the account\'s link once, and holds and stores the answer', async () => {
    const storage = memoryStorage();
    const api = linkApi();

    await expect(primeInviteShareCode(api, USER, { storage, now: NOW })).resolves.toBe(CODE);

    expect(api.createReferralLink).toHaveBeenCalledTimes(1);
    expect(currentInviteShareCode()).toBe(CODE);
    expect(JSON.parse(storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY)!)).toEqual({ userId: USER, code: CODE, readAt: NOW });
  });

  it('holds what the phone stored, with no request, for a week', async () => {
    const storage = memoryStorage(stored(USER, CODE, NOW - INVITE_SHARE_CODE_MAX_AGE_MS + 1));
    const api = linkApi(async () => ({ code: OTHER_CODE }));

    await expect(primeInviteShareCode(api, USER, { storage, now: NOW })).resolves.toBe(CODE);

    expect(api.createReferralLink).not.toHaveBeenCalled();
    expect(currentInviteShareCode()).toBe(CODE);
  });

  it('asks again once the stored answer is a week old, sharing the old code meanwhile', async () => {
    const storage = memoryStorage(stored(USER, CODE, NOW - INVITE_SHARE_CODE_MAX_AGE_MS));
    let answer: (link: unknown) => void = () => undefined;
    const api = linkApi(() => new Promise((resolve) => { answer = resolve; }));

    const priming = primeInviteShareCode(api, USER, { storage, now: NOW });
    await settle();
    expect(api.createReferralLink).toHaveBeenCalledTimes(1);
    expect(currentInviteShareCode()).toBe(CODE);

    answer({ code: OTHER_CODE });
    await expect(priming).resolves.toBe(OTHER_CODE);
    expect(currentInviteShareCode()).toBe(OTHER_CODE);
  });

  it('does not trust a stored time from the future', async () => {
    const storage = memoryStorage(stored(USER, CODE, NOW + 60_000));
    const api = linkApi();

    await primeInviteShareCode(api, USER, { storage, now: NOW });

    expect(api.createReferralLink).toHaveBeenCalledTimes(1);
  });

  it('asks again when what is stored is not a code, never reading it as "no link"', async () => {
    for (const broken of ['NOT A CODE', 42, '']) {
      forgetInviteShareCode();
      resetInviteShareCodePrimingForTests();
      const storage = memoryStorage(stored(USER, broken, NOW - 1000));
      const api = linkApi();

      await expect(primeInviteShareCode(api, USER, { storage, now: NOW })).resolves.toBe(CODE);
      expect(api.createReferralLink).toHaveBeenCalledTimes(1);
    }

    forgetInviteShareCode();
    resetInviteShareCodePrimingForTests();
    const storage = memoryStorage({ [INVITE_SHARE_CODE_STORAGE_KEY]: '{not json' });
    const api = linkApi();
    await expect(primeInviteShareCode(api, USER, { storage, now: NOW })).resolves.toBe(CODE);
  });

  it('never asks twice at once for one account', async () => {
    const storage = memoryStorage();
    const api = linkApi();

    const answers = await Promise.all([
      primeInviteShareCode(api, USER, { storage, now: NOW }),
      primeInviteShareCode(api, USER, { storage, now: NOW }),
    ]);

    expect(answers).toEqual([CODE, CODE]);
    expect(api.createReferralLink).toHaveBeenCalledTimes(1);
  });

  it("never hands one account another's code", async () => {
    const storage = memoryStorage(stored(OTHER_USER, OTHER_CODE, NOW - 1000));
    const api = linkApi();

    const priming = primeInviteShareCode(api, USER, { storage, now: NOW });
    // Before the phone's storage has answered, and after: never the other's.
    expect(currentInviteShareCode()).toBeNull();
    await expect(priming).resolves.toBe(CODE);

    expect(api.createReferralLink).toHaveBeenCalledTimes(1);
    expect(currentInviteShareCode()).toBe(CODE);
  });

  it("keeps the account in front when an earlier account's answer arrives late", async () => {
    const storage = memoryStorage();
    let answerFirst: (link: unknown) => void = () => undefined;
    const first = linkApi(() => new Promise((resolve) => { answerFirst = resolve; }));
    const firstPriming = primeInviteShareCode(first, USER, { storage, now: NOW });
    await settle();

    // Account B signs in on the phone while A's request is still out.
    forgetInviteShareCode();
    await expect(primeInviteShareCode(linkApi(async () => ({ code: OTHER_CODE })), OTHER_USER, { storage, now: NOW }))
      .resolves.toBe(OTHER_CODE);

    answerFirst({ code: CODE });
    await firstPriming;

    expect(currentInviteShareCode()).toBe(OTHER_CODE);
  });

  it('holds nothing for an account that signed out while its request was out', async () => {
    const storage = memoryStorage();
    let answer: (link: unknown) => void = () => undefined;
    const api = linkApi(() => new Promise((resolve) => { answer = resolve; }));
    const priming = primeInviteShareCode(api, USER, { storage, now: NOW });
    await settle();

    forgetInviteShareCode();
    answer({ code: CODE });
    await priming;

    expect(currentInviteShareCode()).toBeNull();
  });

  it('holds nothing when the account left while the phone was still reading its storage', async () => {
    let finishRead: (value: string | null) => void = () => undefined;
    const storage = {
      getItem: vi.fn(() => new Promise<string | null>((resolve) => { finishRead = resolve; })),
      setItem: vi.fn(async () => undefined),
    };
    const api = linkApi();
    const priming = primeInviteShareCode(api, USER, { storage, now: NOW });

    forgetInviteShareCode();
    finishRead(JSON.stringify({ userId: USER, code: CODE, readAt: NOW - 1000 }));

    await expect(priming).resolves.toBeNull();
    expect(currentInviteShareCode()).toBeNull();
    expect(api.createReferralLink).not.toHaveBeenCalled();
  });

  it("remembers, for the week, that the account's link is switched off", async () => {
    const storage = memoryStorage(stored(USER, CODE, NOW - INVITE_SHARE_CODE_MAX_AGE_MS));
    const api = linkApi(async () => { throw switchedOff(); });

    await expect(primeInviteShareCode(api, USER, { storage, now: NOW })).resolves.toBeNull();
    expect(currentInviteShareCode()).toBeNull();
    expect(JSON.parse(storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY)!)).toEqual({ userId: USER, code: null, readAt: NOW });

    // The next start reads that answer and does not ask.
    forgetInviteShareCode();
    await expect(primeInviteShareCode(api, USER, { storage, now: NOW + 60_000 })).resolves.toBeNull();
    expect(api.createReferralLink).toHaveBeenCalledTimes(1);
  });

  it('keeps the code it held when the request fails any other way', async () => {
    const storage = memoryStorage(stored(USER, CODE, NOW - INVITE_SHARE_CODE_MAX_AGE_MS));
    const failures = [
      async () => { throw new Error('Network request failed'); },
      async () => { throw Object.assign(new Error('Too many requests'), { status: 429 }); },
      async () => ({ success: true, code: 'not a code' }),
      async () => null,
    ];
    for (const failure of failures) {
      forgetInviteShareCode();
      resetInviteShareCodePrimingForTests();
      await expect(primeInviteShareCode(linkApi(failure), USER, { storage, now: NOW })).resolves.toBe(CODE);
      expect(currentInviteShareCode()).toBe(CODE);
    }
    // Nothing was written over the stored answer, so the next start asks again.
    expect(JSON.parse(storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY)!).readAt).toBe(NOW - INVITE_SHARE_CODE_MAX_AGE_MS);
  });

  it('holds the code for this run on a phone whose storage fails', async () => {
    const storage = {
      getItem: vi.fn(async () => { throw new Error('storage unavailable'); }),
      setItem: vi.fn(async () => { throw new Error('storage unavailable'); }),
    };
    const api = linkApi();

    await expect(primeInviteShareCode(api, USER, { storage, now: NOW })).resolves.toBe(CODE);
    await settle();
    expect(currentInviteShareCode()).toBe(CODE);

    // Held, so a second call in the same run does not ask again.
    await expect(primeInviteShareCode(api, USER, { storage, now: NOW + 1000 })).resolves.toBe(CODE);
    expect(api.createReferralLink).toHaveBeenCalledTimes(1);
  });

  it('lets go of the code when told to, and of nothing else', () => {
    holdInviteShareCode(USER, CODE, NOW);
    expect(currentInviteShareCode()).toBe(CODE);

    forgetInviteShareCode();
    expect(currentInviteShareCode()).toBeNull();
  });
});
