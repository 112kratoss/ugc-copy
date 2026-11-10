import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

import { ApiError } from '../lib/api-client';
import {
  INVITE_SHARE_CODE_STORAGE_KEY,
  primeInviteShareCode,
  resetInviteShareCodePrimingForTests,
} from '../lib/invite-share-code';
import {
  currentInviteShareCode,
  forgetInviteShareCode,
  holdInviteShareCode,
} from '../lib/invite-share-code-state';
import {
  INVITE_SHARE_CODE_RETRY_DELAYS_MS,
  INVITE_SHARE_NO_LINK_RECHECK_MS,
} from '../lib/invite-share-link/invite-share-code-policy';

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

function stored(entries: Record<string, { code: unknown; readAt: number }>) {
  return { [INVITE_SHARE_CODE_STORAGE_KEY]: JSON.stringify(entries) };
}

function linkApi(answer: () => Promise<unknown> = async () => ({ success: true, code: CODE, shareUrl: `https://magicbooklet.com/r/${CODE}` })) {
  return { createReferralLink: vi.fn(answer) } as never as {
    createReferralLink: ReturnType<typeof vi.fn> & (() => Promise<never>);
  };
}

const switchedOff = () => new ApiError('Your invite link is switched off.', 409, undefined, undefined, 'REFERRAL_LINK_DISABLED');
const outage = () => new ApiError('Your referral link is unavailable.', 503);

async function settle() {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

// A share opens its sheet at the tap, so the sharer's invite code is asked for
// ahead of time and read synchronously (`buildShareUrl`). The rules for keeping
// it are the web's too (`invite-share-code-policy.ts`).
describe("the signed-in account's invite code, for the links the app shares", () => {
  beforeEach(() => {
    forgetInviteShareCode();
    resetInviteShareCodePrimingForTests();
  });

  it('holds nothing until an account is known', () => {
    expect(currentInviteShareCode()).toBeNull();
  });

  it("asks for the account's link once, and holds and stores the answer under the account", async () => {
    const storage = memoryStorage();
    const api = linkApi();

    await expect(primeInviteShareCode(api, USER, { storage, now: NOW })).resolves.toBe(CODE);

    expect(api.createReferralLink).toHaveBeenCalledTimes(1);
    expect(currentInviteShareCode()).toBe(CODE);
    expect(JSON.parse(storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY)!)).toEqual({ [USER]: { code: CODE, readAt: NOW } });
  });

  // A code never changes (a trigger keeps it), so asking again weekly cost a
  // request per account per phone for nothing (review of 2026-11-10).
  it('keeps a stored code for good, with no request', async () => {
    const storage = memoryStorage(stored({ [USER]: { code: CODE, readAt: NOW - 365 * 24 * 60 * 60 * 1000 } }));
    const api = linkApi(async () => ({ code: OTHER_CODE }));

    await expect(primeInviteShareCode(api, USER, { storage, now: NOW })).resolves.toBe(CODE);

    expect(api.createReferralLink).not.toHaveBeenCalled();
    expect(currentInviteShareCode()).toBe(CODE);
  });

  it('keeps the codes of the accounts that take turns on one phone', async () => {
    const storage = memoryStorage(stored({ [OTHER_USER]: { code: OTHER_CODE, readAt: NOW - 1000 } }));
    const api = linkApi();

    await expect(primeInviteShareCode(api, USER, { storage, now: NOW })).resolves.toBe(CODE);
    expect(JSON.parse(storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY)!)).toEqual({
      [OTHER_USER]: { code: OTHER_CODE, readAt: NOW - 1000 },
      [USER]: { code: CODE, readAt: NOW },
    });

    forgetInviteShareCode();
    await expect(primeInviteShareCode(api, OTHER_USER, { storage, now: NOW })).resolves.toBe(OTHER_CODE);
    expect(api.createReferralLink).toHaveBeenCalledTimes(1);
  });

  it('asks again when what is stored is not a code, or dated in the future', async () => {
    for (const entry of [{ code: 'NOT A CODE', readAt: NOW - 1000 }, { code: 42, readAt: NOW - 1000 }, { code: CODE, readAt: NOW + 60_000 }]) {
      forgetInviteShareCode();
      resetInviteShareCodePrimingForTests();
      const storage = memoryStorage(stored({ [USER]: entry }));
      const api = linkApi();
      await expect(primeInviteShareCode(api, USER, { storage, now: NOW })).resolves.toBe(CODE);
      expect(api.createReferralLink).toHaveBeenCalledTimes(1);
    }
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
    const storage = memoryStorage(stored({ [OTHER_USER]: { code: OTHER_CODE, readAt: NOW - 1000 } }));
    const priming = primeInviteShareCode(linkApi(), USER, { storage, now: NOW });
    expect(currentInviteShareCode()).toBeNull();
    await expect(priming).resolves.toBe(CODE);
    expect(currentInviteShareCode()).toBe(CODE);
  });

  it("keeps the account in front when an earlier account's answer arrives late", async () => {
    const storage = memoryStorage();
    let answerFirst: (link: unknown) => void = () => undefined;
    const first = linkApi(() => new Promise((resolve) => { answerFirst = resolve; }));
    const firstPriming = primeInviteShareCode(first, USER, { storage, now: NOW });
    await settle();

    forgetInviteShareCode();
    await expect(primeInviteShareCode(linkApi(async () => ({ code: OTHER_CODE })), OTHER_USER, { storage, now: NOW }))
      .resolves.toBe(OTHER_CODE);

    answerFirst({ code: CODE });
    await firstPriming;

    expect(currentInviteShareCode()).toBe(OTHER_CODE);
  });

  it('holds nothing for an account that signed out while its request was out', async () => {
    let answer: (link: unknown) => void = () => undefined;
    const priming = primeInviteShareCode(linkApi(() => new Promise((resolve) => { answer = resolve; })), USER, {
      storage: memoryStorage(),
      now: NOW,
    });
    await settle();

    forgetInviteShareCode();
    answer({ code: CODE });
    await priming;

    expect(currentInviteShareCode()).toBeNull();
  });

  // Only the server's own "switched off" answer means there is no link. An
  // outage was stored as "no link" for a week (review of 2026-11-10).
  it('remembers a switched-off link for a day, and asks again after it', async () => {
    const storage = memoryStorage();
    const api = linkApi(async () => { throw switchedOff(); });

    await expect(primeInviteShareCode(api, USER, { storage, now: NOW })).resolves.toBeNull();
    expect(JSON.parse(storage.items.get(INVITE_SHARE_CODE_STORAGE_KEY)!)).toEqual({ [USER]: { code: null, readAt: NOW } });

    forgetInviteShareCode();
    await primeInviteShareCode(api, USER, { storage, now: NOW + INVITE_SHARE_NO_LINK_RECHECK_MS - 1 });
    expect(api.createReferralLink).toHaveBeenCalledTimes(1);

    forgetInviteShareCode();
    api.createReferralLink.mockImplementation(async () => ({ code: CODE }));
    await expect(primeInviteShareCode(api, USER, { storage, now: NOW + INVITE_SHARE_NO_LINK_RECHECK_MS }))
      .resolves.toBe(CODE);
    expect(api.createReferralLink).toHaveBeenCalledTimes(2);
  });

  it('stores nothing for an outage, keeps what it held, and waits longer after each failure', async () => {
    const storage = memoryStorage();
    const api = linkApi(async () => { throw outage(); });

    await expect(primeInviteShareCode(api, USER, { storage, now: NOW })).resolves.toBeNull();
    expect(storage.items.has(INVITE_SHARE_CODE_STORAGE_KEY)).toBe(false);

    // Within the first wait: no request.
    await primeInviteShareCode(api, USER, { storage, now: NOW + INVITE_SHARE_CODE_RETRY_DELAYS_MS[0] - 1 });
    expect(api.createReferralLink).toHaveBeenCalledTimes(1);

    // After it: asked again, and the next wait is longer.
    await primeInviteShareCode(api, USER, { storage, now: NOW + INVITE_SHARE_CODE_RETRY_DELAYS_MS[0] });
    expect(api.createReferralLink).toHaveBeenCalledTimes(2);
    await primeInviteShareCode(api, USER, { storage, now: NOW + INVITE_SHARE_CODE_RETRY_DELAYS_MS[0] * 2 });
    expect(api.createReferralLink).toHaveBeenCalledTimes(2);

    // A success ends the waiting.
    api.createReferralLink.mockImplementation(async () => ({ code: CODE }));
    const later = NOW + INVITE_SHARE_CODE_RETRY_DELAYS_MS[0] + INVITE_SHARE_CODE_RETRY_DELAYS_MS[1];
    await expect(primeInviteShareCode(api, USER, { storage, now: later })).resolves.toBe(CODE);
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

    forgetInviteShareCode();
    await expect(primeInviteShareCode(api, USER, { storage, now: NOW + 1000 })).resolves.toBe(CODE);
    expect(api.createReferralLink).toHaveBeenCalledTimes(1);
  });

  it('lets go of the code when told to', () => {
    holdInviteShareCode(USER, CODE, NOW);
    expect(currentInviteShareCode()).toBe(CODE);

    forgetInviteShareCode();
    expect(currentInviteShareCode()).toBeNull();
  });
});
