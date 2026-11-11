import type { CreatorPayoutRequestSummary, CreatorPayoutStateResponse } from './api-client';
import {
  CREATOR_PAYOUT_ARRIVAL_DAYS,
  CREATOR_PAYOUT_CREATOR_SHARE_PERCENT,
  creatorPayoutRailsLine,
  creatorPayoutStatusLabel,
  formatCreatorPayoutMethod,
  type CreatorPayoutMethod,
} from './creator-payout-policy/creator-payout-policy';
import { formatUsdCents } from './home-view-model';
import { UNKNOWN_AMOUNT_LABEL } from './pricing';
import { WALLET_UNAVAILABLE_CAPTION } from './profile-view-model';

/** Token subunits per US cent: 100 tokens to the dollar, 100 subunits to the token. */
const TOKEN_SUBUNITS_PER_CENT = 100;

/**
 * What the Recipe Sales payout card draws (owner, 2026-11-11: withdraw in the
 * app). The rules are the web Earnings tile's (`src/app/marketplace/sell/PayoutPanel.tsx`),
 * one for one: a failed read wins over a balance an earlier read left behind,
 * a payout in progress replaces Withdraw, and a turned-down request says why
 * until something replaces it.
 */
export type CreatorPayoutCard =
  | { kind: 'loading'; balance: string; caption: null }
  | { kind: 'unavailable'; balance: string; caption: string }
  | {
      kind: 'progress' | 'ready' | 'pending';
      balance: string;
      caption: string;
      /** 0 to 1 toward the floor; drawn under the balance while below it. */
      progress: number | null;
      /** Under the progress bar: where payouts go, and from what amount. */
      railsLine: string;
      /** "Withdraw $110.00" when the button shows. */
      withdrawLabel: string;
      pending: { title: string; body: string } | null;
      rejection: { title: string; body: string } | null;
      history: CreatorPayoutHistoryRow[];
    };

export type CreatorPayoutHistoryRow = {
  id: string;
  /** "$110.00 · Paid" */
  title: string;
  /** The day it was settled, or asked for while it is open. */
  date: string;
  /** Why it was turned down, or the bank's reference for a paid one. */
  note: string | null;
  noteTone: 'danger' | 'faint';
};

export function formatPayoutDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTokenSubunits(subunits: number): string {
  return formatUsdCents(Math.floor(subunits / TOKEN_SUBUNITS_PER_CENT));
}

export function payoutHistoryRows(history: CreatorPayoutRequestSummary[]): CreatorPayoutHistoryRow[] {
  return history.map((entry) => {
    const note = entry.status === 'rejected' && entry.resolutionNote
      ? entry.resolutionNote
      : entry.status === 'paid' && entry.externalReference
        ? `Ref ${entry.externalReference}`
        : null;
    return {
      id: entry.id,
      title: `${entry.amountUsd} · ${creatorPayoutStatusLabel(entry.status)}`,
      date: formatPayoutDate(entry.resolvedAt ?? entry.requestedAt),
      note,
      noteTone: entry.status === 'rejected' ? 'danger' : 'faint',
    };
  });
}

export function getCreatorPayoutCard(payout: {
  data?: CreatorPayoutStateResponse;
  isError: boolean;
}): CreatorPayoutCard {
  if (payout.isError) {
    return { kind: 'unavailable', balance: UNKNOWN_AMOUNT_LABEL, caption: WALLET_UNAVAILABLE_CAPTION };
  }
  const state = payout.data;
  if (!state) {
    return { kind: 'loading', balance: UNKNOWN_AMOUNT_LABEL, caption: null };
  }

  const lifetime = state.lifetimeEarnedTokenSubunits > 0
    ? formatTokenSubunits(state.lifetimeEarnedTokenSubunits)
    : null;
  const canWithdraw = state.canRequest && !state.pendingRequest;
  const lastRequest = state.history[0];
  const rejected = !state.pendingRequest && lastRequest?.status === 'rejected' ? lastRequest : null;
  const progress = state.minimumTokenSubunits > 0
    ? Math.min(1, Math.max(0, state.availableTokenSubunits / state.minimumTokenSubunits))
    : null;

  const kind = state.pendingRequest ? 'pending' : canWithdraw ? 'ready' : 'progress';
  const caption = kind === 'pending'
    ? (lifetime ? `Lifetime ${lifetime}` : 'A payout is on its way')
    : kind === 'ready'
      ? (lifetime ? `Ready to withdraw · lifetime ${lifetime}` : 'Ready to withdraw')
      : lifetime
        ? `Lifetime ${lifetime}`
        : `You keep ${CREATOR_PAYOUT_CREATOR_SHARE_PERCENT}% of every sale`;

  return {
    kind,
    balance: state.availableUsd,
    caption,
    progress,
    railsLine: creatorPayoutRailsLine(state.minimumUsd),
    withdrawLabel: `Withdraw ${state.availableUsd}`,
    pending: state.pendingRequest
      ? {
          title: `${state.pendingRequest.amountUsd} payout in progress`,
          body: `Requested ${formatPayoutDate(state.pendingRequest.requestedAt)} via ${formatCreatorPayoutMethod(state.pendingRequest.payoutMethod)}. It arrives within ${CREATOR_PAYOUT_ARRIVAL_DAYS} days of the request.`,
        }
      : null,
    rejection: rejected
      ? {
          title: `Your ${rejected.amountUsd} payout wasn’t sent.`,
          body: rejected.resolutionNote ?? 'The balance is back here to request again.',
        }
      : null,
    history: payoutHistoryRows(state.history),
  };
}

/** The question before a request: it moves the whole balance at once. */
export function payoutConfirmation(amountUsd: string, method: CreatorPayoutMethod, details: string) {
  return {
    title: `Withdraw ${amountUsd}?`,
    message: `We’ll send it by ${formatCreatorPayoutMethod(method)} to ${details.trim()} within ${CREATOR_PAYOUT_ARRIVAL_DAYS} days.`,
    confirmLabel: 'Request payout',
  };
}

/** The server's own codes for a payout it refused; their words are written for the creator. */
const PAYOUT_REFUSAL_CODES = new Set([
  'BELOW_MINIMUM',
  'ALREADY_PENDING',
  'INVALID_METHOD',
  'METHOD_UNAVAILABLE',
  'INVALID_DETAILS',
  'RATE_LIMITED',
]);

/**
 * What a refused or failed request says. A payout refusal carries the server's
 * words; an ended session or anything else (no network, a timeout, a server
 * error) gets plain ones, never a bare "Unauthorized". The screen reads the
 * balance again after every failure, since a request that timed out may still
 * have been taken.
 */
export function payoutRequestFailure(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: unknown }).status
    : undefined;
  if (status === 401 || code === 'UNAUTHORIZED') {
    return 'Your session ended. Sign in again, then request the payout.';
  }
  if (typeof code === 'string' && PAYOUT_REFUSAL_CODES.has(code) && error instanceof Error && error.message) {
    return error.message;
  }
  return 'Couldn’t request the payout. Check your connection, then try again.';
}
