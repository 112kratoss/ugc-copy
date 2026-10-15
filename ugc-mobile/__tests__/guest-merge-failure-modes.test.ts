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
  bindGuestMergeTicket,
  clearGuestMergeOutcome,
  forgetGuestMergeTicketsFor,
  GUEST_MERGE_TICKETS_STORAGE_KEY,
  LEGACY_GUEST_MERGE_TICKET_STORAGE_KEY,
  readGuestMergeOutcome,
  readGuestMergeTickets,
  removeGuestMergeTicket,
  storeGuestMergeOutcome,
  storeGuestMergeTicket,
} = await import('@/lib/guest-merge-ticket-storage');

const TICKET = 'b'.repeat(64);
const OTHER_TICKET = 'c'.repeat(64);
const THIRD_TICKET = 'd'.repeat(64);
const EXPIRES_AT = '2026-11-14T06:00:00.000Z';

function keep(ticket = TICKET, guestUserId = 'guest-1') {
  return storeGuestMergeTicket({ guestUserId, ticket, expiresAt: EXPIRES_AT });
}

async function keptTickets() {
  return (await readGuestMergeTickets()).map(({ ticket }) => ticket);
}

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
      await keep();

      // Simulate a cold start — nothing in memory, only what survived on disk.
      await expect(readGuestMergeTickets()).resolves.toEqual([
        { ticket: TICKET, guestUserId: 'guest-1', redeemedForUserId: null, expiresAt: EXPIRES_AT },
      ]);
    });
  });

  describe('network interruption', () => {
    it('keeps the ticket and stays pending so the next launch retries', () => {
      const action = resolveMergeRedeemFailureAction();

      expect(action.clearTicket).toBe(false);
      expect(action.nextState).toBe('pending');
    });

    it('survives a failed request without losing the stored ticket', async () => {
      await keep();
      const action = resolveMergeRedeemFailureAction();

      if (action.clearTicket) await removeGuestMergeTicket(TICKET);

      await expect(keptTickets()).resolves.toEqual([TICKET]);
    });
  });

  describe('server outcomes', () => {
    it('clears only after the data actually arrived', async () => {
      for (const status of ['merged', 'already_merged'] as const) {
        store.clear();
        await keep();
        const action = resolveMergeRedeemAction(status);

        expect(action.clearTicket).toBe(true);
        expect(action.nextState).toBe('idle');

        await removeGuestMergeTicket(TICKET);
        await expect(readGuestMergeTickets()).resolves.toEqual([]);
      }
    });

    it('never clears on not_eligible', async () => {
      // The most dangerous status to mishandle. It looks like a failure, so the
      // instinct is to clean up — but the server left the ticket redeemable
      // precisely because this can be transient, and the secret exists nowhere
      // else. Clearing it strands the credits permanently.
      await keep();
      const action = resolveMergeRedeemAction('not_eligible');

      expect(action.clearTicket).toBe(false);
      expect(action.nextState).toBe('pending');

      await expect(keptTickets()).resolves.toEqual([TICKET]);
    });

    it('clears expiry and conflict, which spend the ticket, as failures', async () => {
      for (const status of ['expired', 'conflict'] as const) {
        const action = resolveMergeRedeemAction(status);

        // Spent server-side, so keeping it buys nothing; what the person is
        // told is guestMergeOutcomeOf's (guest-merge.test.ts).
        expect(action.clearTicket).toBe(true);
        expect(action.nextState).toBe('failed');
      }
    });
  });

  // Audit 02-7 / 04-8: one slot meant the next guest's ticket overwrote a
  // pending one, and whichever account signed in next redeemed it.
  describe('several guests on one device', () => {
    it("keeps each guest's ticket beside the others", async () => {
      await keep(TICKET, 'guest-1');
      await keep(OTHER_TICKET, 'guest-2');

      await expect(readGuestMergeTickets()).resolves.toEqual([
        { ticket: TICKET, guestUserId: 'guest-1', redeemedForUserId: null, expiresAt: EXPIRES_AT },
        { ticket: OTHER_TICKET, guestUserId: 'guest-2', redeemedForUserId: null, expiresAt: EXPIRES_AT },
      ]);
    });

    it('replaces a guest\'s unsent ticket with its fresher one', async () => {
      await keep(TICKET, 'guest-1');
      await keep(OTHER_TICKET, 'guest-1');

      await expect(keptTickets()).resolves.toEqual([OTHER_TICKET]);
    });

    it('records the account a ticket is sent for, and refuses to record another', async () => {
      await keep(TICKET, 'guest-1');
      await bindGuestMergeTicket(TICKET, 'account-a');
      // Sent again for the same account: a retry, allowed.
      await bindGuestMergeTicket(TICKET, 'account-a');

      await expect(bindGuestMergeTicket(TICKET, 'account-b')).rejects.toThrow(/another account/);
      await expect(readGuestMergeTickets()).resolves.toEqual([
        { ticket: TICKET, guestUserId: 'guest-1', redeemedForUserId: 'account-a', expiresAt: EXPIRES_AT },
      ]);
    });

    it('never lets a fresh ticket push out one already sent for an account', async () => {
      await keep(TICKET, 'guest-1');
      await bindGuestMergeTicket(TICKET, 'account-a');
      await keep(OTHER_TICKET, 'guest-1');

      await expect(keptTickets()).resolves.toEqual([TICKET, OTHER_TICKET]);
    });

    it('loses neither of two changes asked for at once', async () => {
      await Promise.all([keep(TICKET, 'guest-1'), keep(OTHER_TICKET, 'guest-2'), keep(THIRD_TICKET, 'guest-3')]);

      await expect(keptTickets()).resolves.toEqual([TICKET, OTHER_TICKET, THIRD_TICKET]);
    });
  });

  describe('a ticket kept by a build from before keyed tickets', () => {
    it('is read, as a ticket no account has been sent', async () => {
      store.set(LEGACY_GUEST_MERGE_TICKET_STORAGE_KEY, TICKET);

      await expect(readGuestMergeTickets()).resolves.toEqual([
        { ticket: TICKET, guestUserId: null, redeemedForUserId: null, expiresAt: null },
      ]);
    });

    it('moves into the list at the first change, and only then leaves its old slot', async () => {
      store.set(LEGACY_GUEST_MERGE_TICKET_STORAGE_KEY, TICKET);
      await bindGuestMergeTicket(TICKET, 'account-a');

      expect(store.has(LEGACY_GUEST_MERGE_TICKET_STORAGE_KEY)).toBe(false);
      await expect(readGuestMergeTickets()).resolves.toEqual([
        { ticket: TICKET, guestUserId: null, redeemedForUserId: 'account-a', expiresAt: null },
      ]);
    });

    it('stays in its old slot when the list could not be written', async () => {
      store.set(LEGACY_GUEST_MERGE_TICKET_STORAGE_KEY, TICKET);
      failures.set = true;

      await expect(bindGuestMergeTicket(TICKET, 'account-a')).rejects.toThrow();
      expect(store.get(LEGACY_GUEST_MERGE_TICKET_STORAGE_KEY)).toBe(TICKET);
    });

    it('goes once the server has settled it', async () => {
      store.set(LEGACY_GUEST_MERGE_TICKET_STORAGE_KEY, TICKET);
      await removeGuestMergeTicket(TICKET);

      await expect(readGuestMergeTickets()).resolves.toEqual([]);
      expect(store.has(LEGACY_GUEST_MERGE_TICKET_STORAGE_KEY)).toBe(false);
    });
  });

  describe('an account deleted on this device', () => {
    it('takes its tickets, and the unsent ones, but leaves another account\'s', async () => {
      await keep(TICKET, 'guest-1');
      await bindGuestMergeTicket(TICKET, 'account-a');
      await keep(OTHER_TICKET, 'guest-2');
      await bindGuestMergeTicket(OTHER_TICKET, 'account-b');
      await keep(THIRD_TICKET, 'guest-3');
      store.set(LEGACY_GUEST_MERGE_TICKET_STORAGE_KEY, 'e'.repeat(64));

      await forgetGuestMergeTicketsFor('account-a');

      await expect(keptTickets()).resolves.toEqual([OTHER_TICKET]);
      expect(store.has(LEGACY_GUEST_MERGE_TICKET_STORAGE_KEY)).toBe(false);
    });

    it('takes every ticket when the list cannot be read', async () => {
      await keep(TICKET, 'guest-1');
      failures.get = true;

      await expect(forgetGuestMergeTicketsFor('account-a')).resolves.toBeUndefined();
      expect(store.has(GUEST_MERGE_TICKETS_STORAGE_KEY)).toBe(false);
    });
  });

  describe('the outcome kept until dismissed', () => {
    it('is read back after a restart, and forgotten once dismissed', async () => {
      const outcome = { accountUserId: 'account-a', status: 'merged' as const, creditsMoved: 250, at: 1_700_000_000_000 };
      await storeGuestMergeOutcome(outcome);

      await expect(readGuestMergeOutcome()).resolves.toEqual(outcome);

      await clearGuestMergeOutcome();
      await expect(readGuestMergeOutcome()).resolves.toBeNull();
    });

    it('never rejects, whatever the keychain does', async () => {
      failures.set = true;
      failures.get = true;
      failures.delete = true;

      await expect(storeGuestMergeOutcome({ accountUserId: 'a', status: 'conflict', creditsMoved: 0, at: 1 }))
        .resolves.toBeUndefined();
      await expect(readGuestMergeOutcome()).resolves.toBeNull();
      await expect(clearGuestMergeOutcome()).resolves.toBeUndefined();
    });
  });

  describe('secure storage failure', () => {
    it('refuses to report a ticket as stored when the write failed', async () => {
      // prepareGuestMerge() turns this throw into an aborted sign-in. That is
      // deliberate: replacing the guest session with nothing held back would
      // orphan the balance, and a sign-in the user can retry is the far cheaper
      // failure.
      failures.set = true;

      await expect(keep()).rejects.toThrow();
    });

    it('refuses to store a malformed ticket at all', async () => {
      await expect(keep('not-a-ticket')).rejects.toThrow(/malformed/i);
      expect(store.size).toBe(0);
    });

    it('never writes over a list it could not read', async () => {
      await keep(TICKET, 'guest-1');
      failures.get = true;

      await expect(keep(OTHER_TICKET, 'guest-2')).rejects.toThrow();
      failures.get = false;
      await expect(keptTickets()).resolves.toEqual([TICKET]);
    });

    it('degrades to no tickets rather than crashing startup on a read failure', async () => {
      // This runs on every launch. Throwing here would break the app for
      // everyone, including the overwhelming majority who have no ticket.
      failures.get = true;

      await expect(readGuestMergeTickets()).resolves.toEqual([]);
    });

    it('tolerates a failed delete', async () => {
      // A ticket that cannot be deleted is harmless: it is already consumed
      // server-side, so the next redemption returns already_merged or conflict.
      await keep();
      failures.delete = true;

      await expect(removeGuestMergeTicket(TICKET)).resolves.toBeUndefined();
    });
  });
});
