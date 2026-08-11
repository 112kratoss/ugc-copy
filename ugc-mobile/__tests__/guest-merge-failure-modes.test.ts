import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resolveMergeRedeemAction,
  resolveMergeRedeemFailureAction,
} from '@/lib/guest-merge';

const store = new Map<string, string>();
const failures = { get: false, set: false, delete: false };

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    if (failures.get) throw new Error('keychain unavailable');
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (failures.set) throw new Error('keychain write denied');
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    if (failures.delete) throw new Error('keychain delete failed');
    store.delete(key);
  }),
}));

const {
  clearGuestMergeTicket,
  readGuestMergeTicket,
  storeGuestMergeTicket,
} = await import('@/lib/guest-merge-ticket-storage');

const TICKET = 'b'.repeat(64);

describe('guest merge failure modes', () => {
  beforeEach(() => {
    store.clear();
    failures.get = false;
    failures.set = false;
    failures.delete = false;
  });

  describe('app termination between sign-in and redemption', () => {
    it('reads the ticket back after the process is gone', async () => {
      // The entire reason a ticket exists instead of reusing the guest access
      // token: the token dies with the process, so a user who killed the app
      // right after signing up would have lost their purchased credits with no
      // way to prove they were theirs.
      await storeGuestMergeTicket(TICKET);

      // Simulate a cold start — nothing in memory, only what survived on disk.
      await expect(readGuestMergeTicket()).resolves.toBe(TICKET);
    });
  });

  describe('network interruption', () => {
    it('keeps the ticket and stays pending so the next launch retries', () => {
      const action = resolveMergeRedeemFailureAction();

      expect(action.clearTicket).toBe(false);
      expect(action.nextState).toBe('pending');
      // Nothing to tell the user yet: it is still on its way.
      expect(action.outcome).toBeNull();
    });

    it('survives a failed request without losing the stored ticket', async () => {
      await storeGuestMergeTicket(TICKET);
      const action = resolveMergeRedeemFailureAction();

      if (action.clearTicket) await clearGuestMergeTicket();

      await expect(readGuestMergeTicket()).resolves.toBe(TICKET);
    });
  });

  describe('server outcomes', () => {
    it('clears only after the data actually arrived', async () => {
      for (const status of ['merged', 'already_merged'] as const) {
        store.clear();
        await storeGuestMergeTicket(TICKET);
        const action = resolveMergeRedeemAction(status);

        expect(action.clearTicket).toBe(true);
        expect(action.nextState).toBe('idle');
        expect(action.outcome).toBeNull();

        await clearGuestMergeTicket();
        await expect(readGuestMergeTicket()).resolves.toBeNull();
      }
    });

    it('never clears on not_eligible', async () => {
      // The most dangerous status to mishandle. It looks like a failure, so the
      // instinct is to clean up — but the server left the ticket redeemable
      // precisely because this can be transient, and the secret exists nowhere
      // else. Clearing it strands the credits permanently.
      await storeGuestMergeTicket(TICKET);
      const action = resolveMergeRedeemAction('not_eligible');

      expect(action.clearTicket).toBe(false);
      expect(action.nextState).toBe('pending');

      await expect(readGuestMergeTicket()).resolves.toBe(TICKET);
    });

    it('reports expiry and conflict as failures the user must see', async () => {
      for (const status of ['expired', 'conflict'] as const) {
        const action = resolveMergeRedeemAction(status);

        // Spent server-side, so keeping it buys nothing...
        expect(action.clearTicket).toBe(true);
        // ...but the balance is smaller than expected and only support can fix
        // it, so this must never pass silently.
        expect(action.nextState).toBe('failed');
        expect(action.outcome).toBe(status);
      }
    });
  });

  describe('secure storage failure', () => {
    it('refuses to report a ticket as stored when the write failed', async () => {
      // prepareGuestMerge() turns this throw into an aborted sign-in. That is
      // deliberate: replacing the guest session with nothing held back would
      // orphan the balance, and a sign-in the user can retry is the far cheaper
      // failure.
      failures.set = true;

      await expect(storeGuestMergeTicket(TICKET)).rejects.toThrow();
    });

    it('refuses to store a malformed ticket at all', async () => {
      await expect(storeGuestMergeTicket('not-a-ticket')).rejects.toThrow(/malformed/i);
      expect(store.size).toBe(0);
    });

    it('degrades to no-ticket rather than crashing startup on a read failure', async () => {
      // This runs on every launch. Throwing here would break the app for
      // everyone, including the overwhelming majority who have no ticket.
      failures.get = true;

      await expect(readGuestMergeTicket()).resolves.toBeNull();
    });

    it('tolerates a failed delete', async () => {
      // A ticket that cannot be deleted is harmless: it is already consumed
      // server-side, so the next redemption returns already_merged or conflict.
      await storeGuestMergeTicket(TICKET);
      failures.delete = true;

      await expect(clearGuestMergeTicket()).resolves.toBeUndefined();
    });
  });
});
