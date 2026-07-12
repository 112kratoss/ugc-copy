import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import {
  capturePendingReferral,
  claimPendingReferral,
  getPendingReferral,
  getRecentReferralClaim,
  normalizeReferralCode,
} from '../lib/referral-attribution';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

function referralApi() {
  return {
    recordReferralVisit: vi.fn(async ({ code }: { code: string; source: 'mobile' }) => ({
      success: true as const,
      code,
      visitToken: 'visit-token-1',
      expiresAt: '2026-08-01T00:00:00.000Z',
    })),
    claimReferral: vi.fn(async () => ({
      success: true as const,
      claimed: true,
    })),
  };
}

describe('native referral attribution', () => {
  it('accepts referral codes and first-party referral URLs only', () => {
    expect(normalizeReferralCode('abc_123')).toBe('abc_123');
    expect(normalizeReferralCode(' https://magicbooklet.com/r/abc-123 ')).toBe('abc-123');
    expect(normalizeReferralCode('https://evil.test/r/abc-123')).toBeNull();
    expect(normalizeReferralCode('bad code')).toBeNull();
  });

  it('persists the code before recording a visit so offline signup can recover it', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    api.recordReferralVisit.mockImplementationOnce(async () => {
      expect(await getPendingReferral(storage, Date.parse('2026-07-12T00:00:00.000Z'))).toMatchObject({ code: 'invite-1' });
      throw new Error('offline');
    });

    await expect(capturePendingReferral(api as never, 'invite-1', {
      storage,
      now: Date.parse('2026-07-12T00:00:00.000Z'),
    })).rejects.toThrow('offline');

    const pending = await getPendingReferral(storage, Date.parse('2026-07-12T00:01:00.000Z'));
    expect(pending).toMatchObject({ code: 'invite-1' });
    expect(pending).not.toHaveProperty('visitToken');
  });

  it('does not claim an unverified local code after account creation', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    api.recordReferralVisit.mockRejectedValueOnce(new Error('offline'));

    await expect(capturePendingReferral(api as never, 'invite-1', { storage, now })).rejects.toThrow('offline');
    await expect(claimPendingReferral(api as never, { storage, now: now + 1_000 })).rejects.toThrow(
      'retry the invite before creating your account'
    );

    expect(api.claimReferral).not.toHaveBeenCalled();
    await expect(getPendingReferral(storage, now + 2_000)).resolves.toMatchObject({ code: 'invite-1' });
  });

  it('clears a terminally invalid first code so a valid invite can replace it', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    api.recordReferralVisit.mockRejectedValueOnce(Object.assign(new Error('invalid code'), { status: 404 }));

    await expect(capturePendingReferral(api as never, 'invalid-code', { storage, now })).rejects.toThrow('invalid code');
    await expect(getPendingReferral(storage, now + 1_000)).resolves.toBeNull();

    await expect(capturePendingReferral(api as never, 'valid-code', { storage, now: now + 2_000 })).resolves.toMatchObject({
      keptEarlierInvite: false,
      pending: { code: 'valid-code', visitToken: 'visit-token-1' },
    });
  });

  it('keeps first-touch attribution when another invite is opened', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');

    await capturePendingReferral(api as never, 'first-code', { storage, now });
    const second = await capturePendingReferral(api as never, 'second-code', { storage, now: now + 1_000 });

    expect(second).toMatchObject({
      keptEarlierInvite: true,
      pending: { code: 'first-code', visitToken: 'visit-token-1' },
    });
    expect(api.recordReferralVisit).toHaveBeenCalledTimes(1);
  });

  it('claims with both token and code, clears pending state, and records a short-lived result', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    await capturePendingReferral(api as never, 'invite-1', { storage, now });

    await expect(claimPendingReferral(api as never, { storage, now: now + 1_000 })).resolves.toEqual({
      success: true,
      claimed: true,
    });

    expect(api.claimReferral).toHaveBeenCalledWith({ code: 'invite-1', visitToken: 'visit-token-1' });
    await expect(getPendingReferral(storage, now + 2_000)).resolves.toBeNull();
    await expect(getRecentReferralClaim('invite-1', storage, now + 2_000)).resolves.toMatchObject({ claimed: true });
  });

  it('deduplicates simultaneous post-auth claims', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    await capturePendingReferral(api as never, 'invite-1', { storage, now });
    api.claimReferral.mockImplementationOnce(async () => {
      await Promise.resolve();
      return { success: true as const, claimed: true };
    });

    const [first, second] = await Promise.all([
      claimPendingReferral(api as never, { storage, now: now + 1_000 }),
      claimPendingReferral(api as never, { storage, now: now + 1_000 }),
    ]);

    expect(first).toEqual(second);
    expect(api.claimReferral).toHaveBeenCalledTimes(1);
  });
});
