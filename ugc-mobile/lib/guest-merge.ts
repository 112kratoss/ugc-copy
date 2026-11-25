import type { Session } from '@supabase/auth-js';

import { getRegisteredUser, isGuestSession } from './guest-session';
import { formatCreditAmount } from './pricing';
import type { GuestAccountMergeResponse, GuestAccountMergeStatus } from './types';

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
 * A merge ticket as this device keeps it (audit 02-7, 04-8).
 *
 * Several can be kept at once: one per guest identity that held something worth
 * carrying to an account, whose session may since have ended.
 */
export interface StoredGuestMergeTicket {
  ticket: string;
  /**
   * The guest the ticket was minted for. Null only for the one ticket a build
   * from before tickets were kept per guest left behind.
   */
  guestUserId: string | null;
  /**
   * The account the ticket was first sent for. It is never sent for another:
   * the server binds a ticket to its guest only, so on a shared phone the next
   * account to sign in would otherwise take the first one's guest credits.
   */
  redeemedForUserId: string | null;
  /** When the server stops honouring it (ISO); null when not known. */
  expiresAt: string | null;
}

/**
 * What the person is told about a link: a server status, or `refused` for a
 * refusal the server calls final whose reason this build has no words of its
 * own for (2026-11-25).
 */
export type GuestMergeOutcomeStatus = GuestAccountMergeStatus | 'refused';

/**
 * What the person is told about a link, kept on the device until they dismiss
 * it (audit 02-8).
 */
export interface GuestMergeOutcome {
  status: GuestMergeOutcomeStatus;
  /** The credits the link moved onto the account; 0 unless it moved some. */
  creditsMoved: number;
  /** When the answer came, in epoch milliseconds. */
  at: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A guest's kept ticket is replaced by a fresh one once it has less than this
 * left. The server honours a ticket for 30 days, and a guest can hold credits
 * for longer than that.
 */
export const GUEST_MERGE_TICKET_RENEW_WITHIN_MS = 7 * DAY_MS;

/**
 * A sign-in whose fresh ticket could not be minted goes ahead on a kept one
 * with at least this left: it is redeemed straight after the sign-in.
 */
export const GUEST_MERGE_TICKET_MIN_VALIDITY_MS = 60 * 60 * 1000;

/**
 * Statuses that mean the ticket is spent and must be cleared.
 *
 * `not_eligible` is deliberately absent — the server leaves the ticket
 * redeemable for it, because it can be transient (a profile row still being
 * created). Clearing on it would throw away a link that the next attempt would
 * have completed. Only a refusal the server itself calls final is cleared
 * (`isFinalMergeRefusal`).
 */
const TERMINAL_STATUSES: readonly GuestAccountMergeStatus[] = [
  'merged',
  'already_merged',
  'conflict',
  'expired',
];

/** Outcomes where the guest's data really did arrive. */
const SUCCESS_STATUSES: readonly GuestMergeOutcomeStatus[] = ['merged', 'already_merged'];

/** The server's answer to one redemption, as far as the decisions below read it. */
export type GuestMergeAnswer = Pick<GuestAccountMergeResponse, 'status' | 'reason' | 'retryable'>;

/** The kept ticket an answer was for, as far as the decisions below read it. */
export interface GuestMergeTicketContext {
  /** When the server stops honouring the ticket (ISO); null when not known. */
  expiresAt: string | null;
  /** Now, in epoch milliseconds. */
  now: number;
}

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

export function isSuccessfulMergeStatus(status: GuestMergeOutcomeStatus) {
  return SUCCESS_STATUSES.includes(status);
}

/**
 * A refusal the server says no later attempt with this ticket can pass
 * (2026-11-25): it names no ticket it has, or a guest that is gone, is this
 * account, or belongs to another. Only an explicit `retryable: false` counts —
 * an older server sends no such field, and its refusals keep being retried.
 */
export function isFinalMergeRefusal(answer: GuestMergeAnswer) {
  return answer.status === 'not_eligible' && answer.retryable === false;
}

function ticketHadExpired(ticket: GuestMergeTicketContext | undefined) {
  if (!ticket?.expiresAt) return false;
  const expiresAt = Date.parse(ticket.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= ticket.now;
}

/**
 * What the person is told of a final refusal, or null when there is nothing
 * to tell because no credits could have been waiting:
 *
 * - `same_account`: the guest became this account in place, its credits with it.
 * - `guest_gone`: the guest was deleted, and what it held with it.
 * - `unknown_ticket`: the server has no such ticket. Told as `expired` when
 *   this device knows the ticket had passed its expiry, since the server
 *   prunes a ticket 30 days after it and the guest's credits may still be
 *   there for support to attach; otherwise nothing, as for a ticket minted on
 *   another server (the iPhone simulator of 2026-11-25) or one whose guest was
 *   deleted.
 * - `guest_registered`, `guest_linked`: the guest's credits are on another
 *   account, which is what `conflict` says.
 * - anything else, a reason a newer server added included: `refused`, which
 *   points at support. Credits that may be waiting are never passed over in
 *   silence.
 */
export function finalMergeRefusalOutcome(
  reason: GuestMergeAnswer['reason'],
  ticket?: GuestMergeTicketContext,
): GuestMergeOutcomeStatus | null {
  switch (reason) {
    case 'same_account':
    case 'guest_gone':
      return null;
    case 'unknown_ticket':
      return ticketHadExpired(ticket) ? 'expired' : null;
    case 'guest_registered':
    case 'guest_linked':
      return 'conflict';
    default:
      return 'refused';
  }
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

/**
 * The kept tickets a sign-in to `accountUserId` sends: the ones already sent
 * for it, and the ones not yet sent for anyone. A ticket sent for another
 * account is never sent again (audit 04-8).
 */
export function ticketsRedeemableFor(
  tickets: readonly StoredGuestMergeTicket[],
  accountUserId: string,
) {
  return tickets.filter((stored) => (
    stored.redeemedForUserId === null || stored.redeemedForUserId === accountUserId
  ));
}

/**
 * The ticket kept for `guestUserId` that no account has been sent yet, and that
 * the server will still honour `validForMs` from now; null when there is none.
 * A ticket whose expiry is not known counts as honoured.
 */
export function keptGuestMergeTicketFor(
  tickets: readonly StoredGuestMergeTicket[],
  guestUserId: string,
  { now, validForMs }: { now: number; validForMs: number },
) {
  return tickets.find((stored) => {
    if (stored.guestUserId !== guestUserId || stored.redeemedForUserId !== null) return false;
    if (stored.expiresAt === null) return true;
    const expiresAt = Date.parse(stored.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt - now > validForMs;
  }) ?? null;
}

export type GuestMergeRedeemAction = {
  /** Only ever true for a settled outcome — the ticket exists nowhere else. */
  clearTicket: boolean;
  nextState: GuestMergeState;
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
  answer: GuestMergeAnswer,
  ticket?: GuestMergeTicketContext,
): GuestMergeRedeemAction {
  if (isSuccessfulMergeStatus(answer.status)) {
    return { clearTicket: true, nextState: 'idle' };
  }

  if (isTerminalMergeStatus(answer.status)) {
    // conflict / expired: the ticket is spent server-side, so keeping it buys
    // nothing — but the user has to be told (guestMergeOutcomeOf), because
    // their balance is smaller than they expect and only support can fix it.
    return { clearTicket: true, nextState: 'failed' };
  }

  if (isFinalMergeRefusal(answer)) {
    // The server says no attempt with this ticket can ever pass, so sending it
    // again at every launch only re-tells "not added yet" (2026-11-25). Failed
    // only when there is something to tell (guestMergeOutcomeOf).
    return {
      clearTicket: true,
      nextState: finalMergeRefusalOutcome(answer.reason, ticket) ? 'failed' : 'idle',
    };
  }

  // not_eligible that a retry can cure, or from a server that does not say:
  // the server deliberately left the ticket redeemable. Keep it and stay
  // pending so the next launch tries again.
  return { clearTicket: false, nextState: 'pending' };
}

/**
 * What to do when the redemption request never got an answer.
 *
 * A dead network, a 500, a killed process. The ticket must survive all of them:
 * it is the only proof the guest data belongs to this person, so discarding it
 * here would strand the credits permanently.
 */
export function resolveMergeRedeemFailureAction(): GuestMergeRedeemAction {
  return { clearTicket: false, nextState: 'pending' };
}

/**
 * What one answer gives the person to read, or null when there is nothing to
 * say: a link that moved no credits, `already_merged`, which repeats an
 * earlier answer (counting its credits again would add them twice), and a
 * final refusal that no credits could have been waiting behind
 * (`finalMergeRefusalOutcome`).
 */
export function guestMergeOutcomeOf(
  answer: GuestMergeAnswer & Pick<GuestAccountMergeResponse, 'creditsMoved'>,
  at: number,
  ticket?: GuestMergeTicketContext,
): GuestMergeOutcome | null {
  switch (answer.status) {
    case 'merged':
      return answer.creditsMoved > 0 ? { status: 'merged', creditsMoved: answer.creditsMoved, at } : null;
    case 'conflict':
    case 'expired':
      return { status: answer.status, creditsMoved: 0, at };
    case 'not_eligible': {
      if (!isFinalMergeRefusal(answer)) return { status: 'not_eligible', creditsMoved: 0, at };
      const status = finalMergeRefusalOutcome(answer.reason, ticket);
      return status ? { status, creditsMoved: 0, at } : null;
    }
    default:
      return null;
  }
}

/**
 * Credits that cannot arrive outrank credits that did, which outrank credits
 * not added yet: a not-yet is retried at every launch and comes back once the
 * person has read the rest.
 */
function outcomeRank(status: GuestMergeOutcomeStatus) {
  if (status === 'conflict' || status === 'expired' || status === 'refused') return 3;
  if (isSuccessfulMergeStatus(status)) return 2;
  return 1;
}

/**
 * The outcome to keep once `next` arrives beside the one already kept: the
 * credits of two successes add up, and otherwise the weightier of the two
 * stands (the later on a tie). Returns `kept` itself when nothing changes.
 */
export function combineGuestMergeOutcomes(
  kept: GuestMergeOutcome | null,
  next: GuestMergeOutcome | null,
): GuestMergeOutcome | null {
  if (!next) return kept;
  if (!kept) return next;
  if (isSuccessfulMergeStatus(kept.status) && isSuccessfulMergeStatus(next.status)) {
    return { status: 'merged', creditsMoved: kept.creditsMoved + next.creditsMoved, at: next.at };
  }
  return outcomeRank(next.status) >= outcomeRank(kept.status) ? next : kept;
}

/**
 * The outcome to keep after a redemption run for one account: `next` folded
 * into `kept` as above, except that a "not added yet" is dropped once nothing
 * is left waiting for the account (2026-11-25). It promises another try, and
 * with no ticket left to send there is none; kept, it stayed on Home until
 * dismissed. Returns `kept` itself when nothing changes.
 */
export function settleGuestMergeOutcome(
  kept: GuestMergeOutcome | null,
  next: GuestMergeOutcome | null,
  { waiting }: { waiting: boolean },
): GuestMergeOutcome | null {
  const combined = combineGuestMergeOutcomes(kept, next);
  if (!waiting && combined?.status === 'not_eligible') return null;
  return combined;
}

/**
 * What the user should be told, given a settled outcome.
 *
 * `conflict` and `expired` never claim the data arrived — that would be a lie
 * the balance immediately contradicts. They name the situation and point at
 * support, because both are recoverable by a human with database access and by
 * nobody else.
 */
export function describeMergeOutcome(status: GuestMergeOutcomeStatus): {
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
    case 'refused':
      return {
        tone: 'warning',
        message:
          'These guest credits could not be added to this account. '
          + 'If you had credits as a guest, contact support and we can sort it out.',
      };
    default:
      return {
        tone: 'warning',
        message:
          'Your guest credits have not been added to this account yet. '
          + 'We will keep trying; if they do not arrive, contact support.',
      };
  }
}

/**
 * The merge banner's words for a kept outcome (audit 02-8), or null when it
 * has nothing to say.
 */
export function describeGuestMergeOutcome(outcome: GuestMergeOutcome): {
  tone: 'success' | 'warning';
  title: string;
  message: string;
} | null {
  const { tone, message } = describeMergeOutcome(outcome.status);
  if (isSuccessfulMergeStatus(outcome.status)) {
    if (outcome.creditsMoved <= 0) return null;
    return { tone, title: `Guest credits added: ${formatCreditAmount(outcome.creditsMoved)}`, message };
  }
  return {
    tone,
    title: outcome.status === 'not_eligible' ? 'Guest credits not added yet' : 'Guest credits not added',
    message,
  };
}
