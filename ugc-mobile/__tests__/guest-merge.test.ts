import type { Session } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  combineGuestMergeOutcomes,
  describeGuestMergeOutcome,
  describeMergeOutcome,
  guestMergeOutcomeOf,
  isSuccessfulMergeStatus,
  isTerminalMergeStatus,
  keptGuestMergeTicketFor,
  shouldPrepareGuestMerge,
  shouldRedeemGuestMerge,
  isWellFormedMergeTicket,
  ticketsRedeemableFor,
  type StoredGuestMergeTicket,
} from '@/lib/guest-merge';

function sessionFor(user: Record<string, unknown> | null) {
  return (user ? { access_token: 'token-1', user } : null) as unknown as Session | null;
}

const guestSession = sessionFor({ id: 'guest-1', is_anonymous: true });
const registeredSession = sessionFor({ id: 'user-1', is_anonymous: false });
const TICKET = 'a'.repeat(64);

describe('guest merge ticket lifecycle', () => {
  it('prepares a ticket only when a guest is about to be replaced', () => {
    expect(shouldPrepareGuestMerge(guestSession)).toBe(true);
    expect(shouldPrepareGuestMerge(registeredSession)).toBe(false);
    expect(shouldPrepareGuestMerge(null)).toBe(false);
  });

  it('redeems only with a ticket and a registered session', () => {
    // Redeeming as a guest would chain links, which the server refuses anyway;
    // checking here avoids burning a round trip on it.
    expect(shouldRedeemGuestMerge(TICKET, registeredSession)).toBe(true);
    expect(shouldRedeemGuestMerge(TICKET, guestSession)).toBe(false);
    expect(shouldRedeemGuestMerge(null, registeredSession)).toBe(false);
    expect(shouldRedeemGuestMerge(TICKET, null)).toBe(false);
  });

  it('keeps the ticket redeemable after a not_eligible answer', () => {
    // The single most damaging thing this module could get wrong. not_eligible
    // can be transient, and the ticket secret exists nowhere else — clearing it
    // strands the purchased balance permanently.
    expect(isTerminalMergeStatus('not_eligible')).toBe(false);
    expect(isTerminalMergeStatus('merged')).toBe(true);
    expect(isTerminalMergeStatus('already_merged')).toBe(true);
    expect(isTerminalMergeStatus('conflict')).toBe(true);
    expect(isTerminalMergeStatus('expired')).toBe(true);
  });

  it('treats only a real transfer as success', () => {
    expect(isSuccessfulMergeStatus('merged')).toBe(true);
    expect(isSuccessfulMergeStatus('already_merged')).toBe(true);
    expect(isSuccessfulMergeStatus('conflict')).toBe(false);
    expect(isSuccessfulMergeStatus('expired')).toBe(false);
    expect(isSuccessfulMergeStatus('not_eligible')).toBe(false);
  });

  it('never tells the user their data arrived when it did not', () => {
    // conflict and expired are terminal but unsuccessful. Reporting them as a
    // transfer would be contradicted by the balance on the very next screen.
    for (const status of ['conflict', 'expired'] as const) {
      const outcome = describeMergeOutcome(status);
      expect(outcome.tone).toBe('warning');
      expect(outcome.message).toMatch(/support/i);
      expect(outcome.message).not.toMatch(/now on your account/i);
    }

    expect(describeMergeOutcome('merged').tone).toBe('success');
  });

  it('rejects a malformed ticket before it can be stored', () => {
    expect(isWellFormedMergeTicket(TICKET)).toBe(true);
    expect(isWellFormedMergeTicket('short')).toBe(false);
    expect(isWellFormedMergeTicket('A'.repeat(64))).toBe(false);
    expect(isWellFormedMergeTicket(null)).toBe(false);
  });
});

function stored(ticket: Partial<StoredGuestMergeTicket> & { ticket: string }): StoredGuestMergeTicket {
  return { guestUserId: 'guest-1', redeemedForUserId: null, expiresAt: null, ...ticket };
}

// Audit 02-7 / 04-8: a device keeps one ticket per guest, and a ticket sent for
// one account is never sent for another.
describe('which kept tickets a sign-in sends', () => {
  const sentForA = stored({ ticket: 'a'.repeat(64), guestUserId: 'guest-1', redeemedForUserId: 'account-a' });
  const sentForB = stored({ ticket: 'b'.repeat(64), guestUserId: 'guest-2', redeemedForUserId: 'account-b' });
  const unsent = stored({ ticket: 'c'.repeat(64), guestUserId: 'guest-3' });

  it("sends the account's own tickets and the unsent ones, never another account's", () => {
    expect(ticketsRedeemableFor([sentForA, sentForB, unsent], 'account-a')).toEqual([sentForA, unsent]);
    expect(ticketsRedeemableFor([sentForA, sentForB, unsent], 'account-b')).toEqual([sentForB, unsent]);
    expect(ticketsRedeemableFor([sentForA, sentForB], 'account-c')).toEqual([]);
  });
});

describe("a guest's kept ticket", () => {
  const now = Date.parse('2026-10-15T00:00:00.000Z');
  const days = (count: number) => new Date(now + count * 24 * 60 * 60 * 1000).toISOString();

  it("is the guest's own, unsent, with time to spare", () => {
    const fresh = stored({ ticket: 'a'.repeat(64), expiresAt: days(20) });

    expect(keptGuestMergeTicketFor([fresh], 'guest-1', { now, validForMs: 0 })).toBe(fresh);
    expect(keptGuestMergeTicketFor([fresh], 'guest-2', { now, validForMs: 0 })).toBeNull();
    expect(keptGuestMergeTicketFor([{ ...fresh, redeemedForUserId: 'account-a' }], 'guest-1', { now, validForMs: 0 }))
      .toBeNull();
  });

  it('is renewed once it has less than the asked-for time left', () => {
    const ageing = stored({ ticket: 'a'.repeat(64), expiresAt: days(5) });
    const week = 7 * 24 * 60 * 60 * 1000;

    expect(keptGuestMergeTicketFor([ageing], 'guest-1', { now, validForMs: week })).toBeNull();
    expect(keptGuestMergeTicketFor([ageing], 'guest-1', { now, validForMs: 60 * 60 * 1000 })).toBe(ageing);
  });
});

// Audit 02-8: success is told too, and an outcome is kept until dismissed.
describe('what a link is told as', () => {
  const at = 1_700_000_000_000;

  it('tells credits that moved, and nothing for a link that moved none or repeats an earlier answer', () => {
    expect(guestMergeOutcomeOf({ status: 'merged', creditsMoved: 250 }, at)).toEqual({ status: 'merged', creditsMoved: 250, at });
    expect(guestMergeOutcomeOf({ status: 'merged', creditsMoved: 0 }, at)).toBeNull();
    expect(guestMergeOutcomeOf({ status: 'already_merged', creditsMoved: 250 }, at)).toBeNull();
  });

  it('tells every way the credits did not arrive', () => {
    for (const status of ['conflict', 'expired', 'not_eligible'] as const) {
      expect(guestMergeOutcomeOf({ status, creditsMoved: 0 }, at)).toEqual({ status, creditsMoved: 0, at });
    }
  });

  it('adds up two successes, and lets credits that cannot arrive outrank the rest', () => {
    const added = { status: 'merged' as const, creditsMoved: 100, at };
    const conflict = { status: 'conflict' as const, creditsMoved: 0, at: at + 1 };
    const notYet = { status: 'not_eligible' as const, creditsMoved: 0, at: at + 2 };

    expect(combineGuestMergeOutcomes(added, { ...added, creditsMoved: 50, at: at + 3 }))
      .toEqual({ status: 'merged', creditsMoved: 150, at: at + 3 });
    expect(combineGuestMergeOutcomes(added, conflict)).toBe(conflict);
    expect(combineGuestMergeOutcomes(conflict, added)).toBe(conflict);
    // A not-yet is retried at every launch, and comes back once the person has
    // read that credits did arrive.
    expect(combineGuestMergeOutcomes(added, notYet)).toBe(added);
    expect(combineGuestMergeOutcomes(notYet, added)).toBe(added);
    expect(combineGuestMergeOutcomes(null, notYet)).toBe(notYet);
    expect(combineGuestMergeOutcomes(notYet, null)).toBe(notYet);
  });

  it('draws "Guest credits added: N" for a success, and the reason otherwise', () => {
    expect(describeGuestMergeOutcome({ status: 'merged', creditsMoved: 1250, at })).toEqual({
      tone: 'success',
      title: 'Guest credits added: 1,250',
      message: 'Your credits and creations are now on your account.',
    });
    expect(describeGuestMergeOutcome({ status: 'merged', creditsMoved: 0, at })).toBeNull();

    const conflict = describeGuestMergeOutcome({ status: 'conflict', creditsMoved: 0, at });
    expect(conflict).toMatchObject({ tone: 'warning', title: 'Guest credits not added' });
    expect(conflict?.message).toMatch(/different account/);
    const expired = describeGuestMergeOutcome({ status: 'expired', creditsMoved: 0, at });
    expect(expired).toMatchObject({ tone: 'warning', title: 'Guest credits not added' });
    expect(expired?.message).toMatch(/waited too long/);
    const notYet = describeGuestMergeOutcome({ status: 'not_eligible', creditsMoved: 0, at });
    expect(notYet).toMatchObject({ tone: 'warning', title: 'Guest credits not added yet' });
    expect(notYet?.message).toMatch(/keep trying/);
    expect(notYet?.message).toMatch(/support/);
  });
});
