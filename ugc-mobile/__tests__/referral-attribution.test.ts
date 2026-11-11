import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import {
  bonusCreditsPhrase,
  capturePendingReferral,
  claimPendingReferral,
  formatReferralPercent,
  getPendingReferral,
  getLatestReferralClaimRecord,
  inviteClaimLine,
  normalizeReferralCode,
  readReferralProgram,
  retryPendingReferralVisit,
  saveTypedInviteCode,
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

  // A shared post's invite is captured silently; an invite link the person
  // opens after it is a choice they made, so it replaces the shared link's.
  // Nothing replaces an invite link (review of 2026-11-10).
  it('lets an invite link replace a shared link\'s invite, and never the other way round', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');

    await capturePendingReferral(api as never, 'sharer-code', { storage, now, kind: 'shared_link' });
    expect(api.recordReferralVisit).toHaveBeenLastCalledWith({ code: 'sharer-code', source: 'mobile', kind: 'shared_link' });

    const invited = await capturePendingReferral(api as never, 'friend-code', { storage, now: now + 1_000 });
    expect(invited).toMatchObject({ keptEarlierInvite: false, pending: { code: 'friend-code', kind: 'invite' } });
    expect(api.recordReferralVisit).toHaveBeenLastCalledWith({ code: 'friend-code', source: 'mobile', kind: 'invite' });

    const sharedAgain = await capturePendingReferral(api as never, 'sharer-code', { storage, now: now + 2_000, kind: 'shared_link' });
    const secondInvite = await capturePendingReferral(api as never, 'other-code', { storage, now: now + 3_000 });
    expect([sharedAgain.pending.code, secondInvite.pending.code]).toEqual(['friend-code', 'friend-code']);
    expect(api.recordReferralVisit).toHaveBeenCalledTimes(2);
  });

  it('records an invite saved offline when asked again, and leaves a recorded one alone', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    api.recordReferralVisit.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(capturePendingReferral(api as never, 'sharer-code', { storage, now, kind: 'shared_link' })).rejects.toThrow();

    await retryPendingReferralVisit(api as never, { storage, now: now + 1_000 });
    expect(api.recordReferralVisit).toHaveBeenCalledTimes(2);
    expect(api.recordReferralVisit).toHaveBeenLastCalledWith({ code: 'sharer-code', source: 'mobile', kind: 'shared_link' });

    await retryPendingReferralVisit(api as never, { storage, now: now + 2_000 });
    expect(api.recordReferralVisit).toHaveBeenCalledTimes(2);

    // Never throws, offline or not.
    api.recordReferralVisit.mockRejectedValue(new Error('Network request failed'));
    await expect(retryPendingReferralVisit(api as never, { storage: memoryStorage(), now })).resolves.toBeUndefined();
  });

  it('claims with both token and code, clears pending state, and records a short-lived result', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    await capturePendingReferral(api as never, 'invite-1', { storage, now });

    await expect(claimPendingReferral(api as never, { storage, now: now + 1_000, userId: 'creator-1' })).resolves.toEqual({
      success: true,
      claimed: true,
    });

    expect(api.claimReferral).toHaveBeenCalledWith({ code: 'invite-1', visitToken: 'visit-token-1' });
    await expect(getPendingReferral(storage, now + 2_000)).resolves.toBeNull();
    await expect(getLatestReferralClaimRecord('creator-1', storage, now + 2_000)).resolves.toMatchObject({
      code: 'invite-1',
      response: { claimed: true },
    });
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

describe('the program terms the referral screens print (03-7)', () => {
  // Not today's 5 / 5 / 30, so a number the screens made up would show.
  const program = { inviterPercent: 7, inviteeFirstPurchasePercent: 3, attributionWindowDays: 45 };

  it('keeps the terms the visit answer carried with the pending invite', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    api.recordReferralVisit.mockResolvedValueOnce({
      success: true as const,
      code: 'invite-1',
      visitToken: 'visit-token-1',
      expiresAt: '2026-08-01T00:00:00.000Z',
      program,
    } as never);

    await expect(capturePendingReferral(api as never, 'invite-1', { storage, now })).resolves.toMatchObject({
      pending: { code: 'invite-1', visitToken: 'visit-token-1', program },
    });
    // A later launch does not record the visit again, and still has them.
    await expect(capturePendingReferral(api as never, 'invite-1', { storage, now: now + 1_000 })).resolves.toMatchObject({
      pending: { program },
    });
    await expect(getPendingReferral(storage, now + 2_000)).resolves.toMatchObject({ program });
    expect(api.recordReferralVisit).toHaveBeenCalledTimes(1);
  });

  it('carries them to the recent claim the landing reads after sign-up', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    api.recordReferralVisit.mockResolvedValueOnce({
      success: true as const,
      code: 'invite-1',
      visitToken: 'visit-token-1',
      expiresAt: '2026-08-01T00:00:00.000Z',
      program,
    } as never);
    await capturePendingReferral(api as never, 'invite-1', { storage, now });
    await claimPendingReferral(api as never, { storage, now: now + 1_000, userId: 'creator-1' });

    await expect(getLatestReferralClaimRecord('creator-1', storage, now + 2_000)).resolves.toEqual({
      code: 'invite-1',
      userId: 'creator-1',
      claimedAt: new Date(now + 1_000).toISOString(),
      response: { success: true, claimed: true },
      program,
    });
  });

  it('knows no terms from an older server, or from an answer without them', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');

    await expect(capturePendingReferral(api as never, 'invite-1', { storage, now })).resolves.toMatchObject({
      pending: { program: null },
    });
    expect(readReferralProgram(null)).toBeNull();
    // The server prints a missing value as 0.
    expect(readReferralProgram({ inviterPercent: 5, inviteeFirstPurchasePercent: 0, attributionWindowDays: 30 })).toBeNull();
    expect(readReferralProgram({ inviterPercent: '5', inviteeFirstPurchasePercent: 5, attributionWindowDays: 30 })).toBeNull();
    expect(readReferralProgram(program)).toEqual(program);
  });

  it('prints the percent the server sent, or no number at all', () => {
    expect(formatReferralPercent(7)).toBe('7%');
    expect(formatReferralPercent(2.5)).toBe('2.5%');
    expect(formatReferralPercent(null)).toBeNull();
    expect(formatReferralPercent(0)).toBeNull();
    expect(bonusCreditsPhrase(3)).toBe('3% bonus credits');
    expect(bonusCreditsPhrase(undefined)).toBe('bonus credits');
  });
});

describe('how long an invite is kept on this device', () => {
  const day = 24 * 60 * 60 * 1000;

  it("keeps a recorded visit for the program's own window, longer than 30 days included", async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    api.recordReferralVisit.mockResolvedValueOnce({
      success: true as const,
      code: 'invite-1',
      visitToken: 'visit-token-1',
      expiresAt: new Date(now + 45 * day).toISOString(),
      program: { inviterPercent: 7, inviteeFirstPurchasePercent: 3, attributionWindowDays: 45 },
    } as never);
    await capturePendingReferral(api as never, 'invite-1', { storage, now });

    await expect(getPendingReferral(storage, now + 40 * day)).resolves.toMatchObject({ code: 'invite-1' });
    await expect(getPendingReferral(storage, now + 46 * day)).resolves.toBeNull();
  });

  it('drops a code the server never verified after 30 days', async () => {
    const storage = memoryStorage();
    const api = referralApi();
    const now = Date.parse('2026-07-12T00:00:00.000Z');
    api.recordReferralVisit.mockRejectedValueOnce(new Error('offline'));
    await expect(capturePendingReferral(api as never, 'invite-1', { storage, now })).rejects.toThrow('offline');

    await expect(getPendingReferral(storage, now + 29 * day)).resolves.toMatchObject({ code: 'invite-1' });
    await expect(getPendingReferral(storage, now + 31 * day)).resolves.toBeNull();
  });
});

describe('a code typed on the sign-in page (owner, 2026-11-11)', () => {
  function codeApi() {
    return {
      recordReferralVisit: vi.fn(async ({ code }: { code: string; source: 'mobile'; kind?: string }) => ({
        success: true as const,
        code: code === 'K7P2QX' ? 'a43ea71e6475' : 'b1c2d3e4f5a6',
        shortCode: code === 'K7P2QX' ? 'K7P2QX' : 'M8N9PQ',
        visitToken: `visit-${code}`,
        expiresAt: '2099-01-01T00:00:00.000Z',
      })),
      claimReferral: vi.fn(),
    };
  }

  it('replaces an invite a link left, and keeps the invite’s link code and short code', async () => {
    const storage = memoryStorage();
    const api = codeApi();
    await capturePendingReferral(api, 'b1c2d3e4f5a6', { storage, kind: 'invite' });

    const typed = await capturePendingReferral(api, 'k7p2-qx', { storage, kind: 'code' });

    // The held visit goes with the code, for the server to tell the same invite from another.
    expect(api.recordReferralVisit).toHaveBeenLastCalledWith({ code: 'K7P2QX', source: 'mobile', kind: 'code', visitToken: 'visit-b1c2d3e4f5a6' });
    expect(typed.keptEarlierInvite).toBe(false);
    // Kept as an invite's on the phone, which a bundle from before typed codes can still read.
    expect(await getPendingReferral(storage)).toMatchObject({ code: 'a43ea71e6475', shortCode: 'K7P2QX', kind: 'invite', visitToken: 'visit-K7P2QX' });
  });

  it('keeps the visit the server keeps when the held invite’s own code is typed', async () => {
    const storage = memoryStorage();
    const api = codeApi();
    await capturePendingReferral(api, 'a43ea71e6475', { storage, kind: 'shared_link' });
    const held = await getPendingReferral(storage);
    api.recordReferralVisit.mockResolvedValueOnce({
      success: true as const,
      code: 'a43ea71e6475',
      shortCode: 'K7P2QX',
      visitToken: held!.visitToken!,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    await capturePendingReferral(api, 'k7p2qx', { storage, kind: 'code' });

    expect(api.recordReferralVisit).toHaveBeenLastCalledWith(expect.objectContaining({ visitToken: held!.visitToken }));
    // The same visit, now a typed choice: a later invite link no longer replaces it.
    expect(await getPendingReferral(storage)).toMatchObject({ visitToken: held!.visitToken, kind: 'invite', capturedAt: held!.capturedAt });
    const later = await capturePendingReferral(api, 'b1c2d3e4f5a6', { storage, kind: 'invite' });
    expect(later.keptEarlierInvite).toBe(true);
  });

  it('keeps a typed code a link capture still on the network would have written over', async () => {
    const storage = memoryStorage();
    const api = codeApi();
    let answerLink!: () => void;
    api.recordReferralVisit.mockImplementationOnce(({ code }) => new Promise((resolve) => {
      answerLink = () => resolve({
        success: true as const,
        code,
        shortCode: 'M8N9PQ',
        visitToken: 'visit-link',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }));
    const linkCapture = capturePendingReferral(api, 'b1c2d3e4f5a6', { storage, kind: 'invite' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await capturePendingReferral(api, 'K7P2QX', { storage, kind: 'code' });
    answerLink();
    await linkCapture;

    expect(await getPendingReferral(storage)).toMatchObject({ code: 'a43ea71e6475', visitToken: 'visit-K7P2QX' });
  });

  it('is not replaced by an invite link opened after it', async () => {
    const storage = memoryStorage();
    const api = codeApi();
    await capturePendingReferral(api, 'K7P2QX', { storage, kind: 'code' });

    const later = await capturePendingReferral(api, 'b1c2d3e4f5a6', { storage, kind: 'invite' });

    expect(later.keptEarlierInvite).toBe(true);
    expect((await getPendingReferral(storage))?.shortCode).toBe('K7P2QX');
  });

  it('leaves the held invite in place when the server refuses the code', async () => {
    const storage = memoryStorage();
    const api = codeApi();
    await capturePendingReferral(api, 'b1c2d3e4f5a6', { storage, kind: 'invite' });
    api.recordReferralVisit.mockRejectedValueOnce(Object.assign(new Error('Referral code not found.'), { status: 404 }));

    const result = await saveTypedInviteCode(api, 'ZZZZZZ', { storage });

    expect(result).toEqual({ ok: false, message: 'That invite code was not found. Check it with whoever invited you.' });
    expect(await getPendingReferral(storage)).toMatchObject({ code: 'b1c2d3e4f5a6', kind: 'invite' });
  });

  it('asks nothing of the server for text that cannot be a code', async () => {
    const api = codeApi();
    const result = await saveTypedInviteCode(api, 'hello there', { storage: memoryStorage() });
    expect(result.ok).toBe(false);
    expect(api.recordReferralVisit).not.toHaveBeenCalled();
  });

  it('reads the latest claim for the welcome card without taking it from the landing', async () => {
    const storage = memoryStorage();
    storage.values.set('magicbooklet.referral.recentClaim.v1', JSON.stringify({
      code: 'a43ea71e6475',
      userId: 'creator-1',
      claimedAt: new Date(1_000).toISOString(),
      response: { success: true, claimed: true, held: true },
    }));

    // Never another account's claim on the same phone.
    expect(await getLatestReferralClaimRecord('creator-2', storage, 2_000)).toBeNull();
    expect(await getLatestReferralClaimRecord(null, storage, 2_000)).toBeNull();
    const record = await getLatestReferralClaimRecord('creator-1', storage, 2_000);
    expect(inviteClaimLine(record)).toEqual({
      tone: 'info',
      text: 'Invite received: its bonus is on hold while we check it. Contact support if you think this is a mistake.',
    });
    expect(storage.values.has('magicbooklet.referral.recentClaim.v1')).toBe(true);
    expect(await getLatestReferralClaimRecord('creator-1', storage, 1_000 + 16 * 60 * 1000)).toBeNull();
    expect(inviteClaimLine(null)).toBeNull();
  });

  // The record is the phone's and iOS keeps SecureStore through an uninstall:
  // a fresh install's guest opening the same invite was told "Invite applied"
  // (iPhone 16e, 0.1.9 (61), 2026-11-11).
  it("answers the invite's landing only for the account that made the claim, and never takes it away", async () => {
    const storage = memoryStorage();
    const record = {
      code: 'a43ea71e6475',
      userId: 'creator-1',
      claimedAt: new Date(1_000).toISOString(),
      response: { success: true, claimed: true },
    };
    storage.values.set('magicbooklet.referral.recentClaim.v1', JSON.stringify(record));

    expect(await getLatestReferralClaimRecord(null, storage, 2_000)).toBeNull();
    expect(await getLatestReferralClaimRecord('creator-2', storage, 2_000)).toBeNull();
    // Neither look takes the record from the account it belongs to.
    expect(await getLatestReferralClaimRecord('creator-1', storage, 2_000)).toMatchObject({
      code: 'a43ea71e6475',
      userId: 'creator-1',
      response: { claimed: true },
    });
    // A record that names no account answers no one.
    storage.values.set('magicbooklet.referral.recentClaim.v1', JSON.stringify({ ...record, userId: undefined }));
    expect(await getLatestReferralClaimRecord('creator-1', storage, 2_000)).toBeNull();
    expect(storage.values.has('magicbooklet.referral.recentClaim.v1')).toBe(true);
  });
});
