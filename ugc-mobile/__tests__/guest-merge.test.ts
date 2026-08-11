import type { Session } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  describeMergeOutcome,
  isSuccessfulMergeStatus,
  isTerminalMergeStatus,
  shouldPrepareGuestMerge,
  shouldRedeemGuestMerge,
  isWellFormedMergeTicket,
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
