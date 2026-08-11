import type { Session } from '@supabase/supabase-js';

import { getRegisteredUser, isGuestSession } from './guest-session';
import type { GuestAccountMergeStatus } from './types';

/**
 * Where the account link is in its lifecycle.
 *
 * `pending` is the state that matters: a ticket is stored and unredeemed. It
 * survives app termination, so the UI can tell someone their guest credits are
 * still on their way rather than silently showing a smaller balance.
 */
export type GuestMergeState =
  | 'idle'
  | 'preparing'
  | 'pending'
  | 'merging'
  | 'failed';

/**
 * Statuses that mean the ticket is spent and must be cleared.
 *
 * `not_eligible` is deliberately absent — the server leaves the ticket
 * redeemable for it, because it can be transient (a profile row still being
 * created). Clearing on it would throw away a link that the next attempt would
 * have completed.
 */
const TERMINAL_STATUSES: readonly GuestAccountMergeStatus[] = [
  'merged',
  'already_merged',
  'conflict',
  'expired',
];

/** Outcomes where the guest's data really did arrive. */
const SUCCESS_STATUSES: readonly GuestAccountMergeStatus[] = ['merged', 'already_merged'];

/**
 * Shape check for a ticket, kept here rather than in the storage module so it
 * can be unit tested — importing that module pulls in expo-secure-store, which
 * has no bindings under vitest.
 */
export function isWellFormedMergeTicket(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function isTerminalMergeStatus(status: GuestAccountMergeStatus) {
  return TERMINAL_STATUSES.includes(status);
}

export function isSuccessfulMergeStatus(status: GuestAccountMergeStatus) {
  return SUCCESS_STATUSES.includes(status);
}

/**
 * Whether this sign-in orphaned a guest identity worth linking.
 *
 * Answered from the session that existed *before* authentication, because that
 * is the only thing that still knows a guest was there.
 */
export function shouldPrepareGuestMerge(previousSession: Session | null) {
  return isGuestSession(previousSession) && Boolean(previousSession?.user?.id);
}

/**
 * Whether a stored ticket should be redeemed against the current session.
 *
 * Requires a registered session: a ticket redeemed by a guest would chain links,
 * and the server refuses it anyway. Returns false when there is no ticket, which
 * is the common case on every launch.
 */
export function shouldRedeemGuestMerge(
  ticket: string | null,
  session: Session | null,
) {
  if (!ticket) return false;
  return Boolean(getRegisteredUser(session));
}

export type GuestMergeRedeemAction = {
  /** Only ever true for a settled outcome — the ticket exists nowhere else. */
  clearTicket: boolean;
  nextState: GuestMergeState;
  /** Set only when the user must be told something; null when it just worked. */
  outcome: GuestAccountMergeStatus | null;
};

/**
 * What to do with the stored ticket after the server answers.
 *
 * Lives here rather than in the auth provider so it can be tested directly:
 * this is the decision that determines whether someone's purchased credits
 * survive a bad network, and it should not only be reachable through a rendered
 * component.
 */
export function resolveMergeRedeemAction(
  status: GuestAccountMergeStatus,
): GuestMergeRedeemAction {
  if (isSuccessfulMergeStatus(status)) {
    return { clearTicket: true, nextState: 'idle', outcome: null };
  }

  if (isTerminalMergeStatus(status)) {
    // conflict / expired: the ticket is spent server-side, so keeping it buys
    // nothing — but the user has to be told, because their balance is smaller
    // than they expect and only support can fix it.
    return { clearTicket: true, nextState: 'failed', outcome: status };
  }

  // not_eligible: the server deliberately left the ticket redeemable. Keep it
  // and stay pending so the next launch tries again.
  return { clearTicket: false, nextState: 'pending', outcome: null };
}

/**
 * What to do when the redemption request never got an answer.
 *
 * A dead network, a 500, a killed process. The ticket must survive all of them:
 * it is the only proof the guest data belongs to this person, so discarding it
 * here would strand the credits permanently.
 */
export function resolveMergeRedeemFailureAction(): GuestMergeRedeemAction {
  return { clearTicket: false, nextState: 'pending', outcome: null };
}

/**
 * What the user should be told, given a settled outcome.
 *
 * `conflict` and `expired` never claim the data arrived — that would be a lie
 * the balance immediately contradicts. They name the situation and point at
 * support, because both are recoverable by a human with database access and by
 * nobody else.
 */
export function describeMergeOutcome(status: GuestAccountMergeStatus): {
  tone: 'success' | 'warning';
  message: string;
} {
  switch (status) {
    case 'merged':
    case 'already_merged':
      return {
        tone: 'success',
        message: 'Your credits and creations are now on your account.',
      };
    case 'conflict':
      return {
        tone: 'warning',
        message:
          'These guest credits were already added to a different account. '
          + 'Contact support and we can move them.',
      };
    case 'expired':
      return {
        tone: 'warning',
        message:
          'This device waited too long to link its guest credits. '
          + 'They are safe — contact support and we can attach them.',
      };
    default:
      return {
        tone: 'warning',
        message: 'Your guest credits have not been added yet. We will keep trying.',
      };
  }
}
