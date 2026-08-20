import { createHash, randomBytes } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  requireIdentity,
  requireRegisteredUser,
  type IdentityFailure,
} from '@/lib/account-identity';
import { logBackendError } from '@/lib/backend-logger';
import {
  ACCOUNT_MERGE_RATE_LIMIT,
  BackendRateLimitError,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';

type RouteBody = Record<string, unknown>;

/** How long a guest has to complete a link before the ticket stops working. */
export const ACCOUNT_MERGE_TICKET_TTL_DAYS = 30;

/**
 * `merged` — the link succeeded and the balance moved.
 * `already_merged` — a replay of the same redemption; treat as success.
 * `conflict` — this guest was already linked to a different account.
 * `expired` — the ticket outlived its window; the guest data still exists but
 *   needs support to attach.
 * `not_eligible` — refused, and deliberately *not* terminal: the ticket stays
 *   spendable so a later retry can succeed.
 */
export type AccountMergeStatus =
  | 'merged'
  | 'already_merged'
  | 'conflict'
  | 'expired'
  | 'not_eligible';

export interface AccountMergeResult {
  status: AccountMergeStatus;
  creditsMoved: number;
  promotionalCreditsMoved: number;
  credits: number | null;
}

export interface AccountMergeTicketResult {
  ticket: string;
  expiresAt: string;
}

export type AccountMergeRouteResult<T> =
  | { ok: true; body: T }
  | { ok: false; body: RouteBody; status: number; rateLimitError?: BackendRateLimitError };

export interface AccountMergeRouteInput {
  getAdminSupabase: () => unknown;
  readRequestBody?: () => Promise<unknown>;
  requestBody?: unknown;
  userSupabase: unknown;
}

type AdminSupabaseClient = Parameters<typeof enforceBackendRateLimit>[0] & SupabaseClient;

function failure(result: IdentityFailure): AccountMergeRouteResult<never> {
  return {
    ok: false,
    body: { error: result.error, code: result.code },
    status: result.status,
  };
}

function toNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The ticket the client keeps, and the only form the server stores.
 *
 * A raw 32-byte secret goes to the client once; the database holds nothing but
 * its SHA-256. A dump of `account_merge_tickets` is therefore useless for
 * redeeming — the same reason password hashes exist.
 */
export function hashAccountMergeTicket(ticket: string) {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

export function isWellFormedAccountMergeTicket(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

async function readRequestBody(input: AccountMergeRouteInput) {
  if ('requestBody' in input) return input.requestBody;
  return input.readRequestBody ? input.readRequestBody() : {};
}

async function rateLimit(admin: AdminSupabaseClient, key: string) {
  try {
    await enforceBackendRateLimit(admin, { ...ACCOUNT_MERGE_RATE_LIMIT, key });
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return {
        ok: false as const,
        body: { error: error.message },
        status: error.status,
        rateLimitError: error,
      };
    }
    logBackendError('account_merge_rate_limit_check_failed', { error });
    return {
      ok: false as const,
      body: { error: 'Failed to check merge limits.' },
      status: 500,
    };
  }
}

/**
 * Mint a redemption ticket for the calling guest.
 *
 * Called *before* the sign-in that will replace this session, because this is
 * the last moment the guest can prove who it is. The client persists the ticket
 * in Keychain/Keystore, so a crash, a network failure, or the user killing the
 * app between sign-in and redemption costs nothing but a retry.
 */
export async function prepareAccountMergeTicketForRoute(
  input: AccountMergeRouteInput,
): Promise<AccountMergeRouteResult<AccountMergeTicketResult>> {
  const userSupabase = input.userSupabase as SupabaseClient;
  let admin: AdminSupabaseClient | null = null;
  const getAdmin = () => {
    admin ??= input.getAdminSupabase() as AdminSupabaseClient;
    return admin;
  };

  const identity = await requireIdentity(userSupabase, getAdmin);
  if (!identity.ok) return failure(identity);
  const resolvedAdmin = getAdmin();

  // Only a guest has anything to hand over. A registered caller asking for one
  // is a client bug, and minting it would create a ticket that can only ever
  // resolve to 'not_eligible'.
  if (!identity.identity.isGuest) {
    return {
      ok: false,
      body: { error: 'Only a guest session can prepare a merge ticket.', code: 'NOT_A_GUEST' },
      status: 400,
    };
  }

  const limited = await rateLimit(resolvedAdmin, identity.identity.userId);
  if (limited) return limited;

  const ticket = randomBytes(32).toString('hex');
  const expiresAt = new Date(
    Date.now() + ACCOUNT_MERGE_TICKET_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { error } = await resolvedAdmin.from('account_merge_tickets').insert({
    ticket_hash: hashAccountMergeTicket(ticket),
    guest_user_id: identity.identity.userId,
    expires_at: expiresAt,
  });

  if (error) {
    // Never log the ticket itself, here or anywhere.
    logBackendError('account_merge_ticket_create_failed', {
      error,
      guestUserId: identity.identity.userId,
    });
    return {
      ok: false,
      body: { error: 'Could not prepare the account link.' },
      status: 500,
    };
  }

  return { ok: true, body: { ticket, expiresAt } };
}

/**
 * Redeem a ticket and link the guest identity to the caller's account.
 *
 * The caller must be registered: the whole point is to name the account that
 * will own the guest's credits, and a guest naming another guest would chain
 * links that nothing downstream models.
 */
export async function mergeGuestAccountForRoute(
  input: AccountMergeRouteInput,
): Promise<AccountMergeRouteResult<AccountMergeResult>> {
  const userSupabase = input.userSupabase as SupabaseClient;
  let admin: AdminSupabaseClient | null = null;
  const getAdmin = () => {
    admin ??= input.getAdminSupabase() as AdminSupabaseClient;
    return admin;
  };

  const identity = await requireRegisteredUser(userSupabase, getAdmin);
  if (!identity.ok) return failure(identity);
  const resolvedAdmin = getAdmin();

  const limited = await rateLimit(resolvedAdmin, identity.identity.userId);
  if (limited) return limited;

  const body = await readRequestBody(input);
  const ticket = (body as { ticket?: unknown } | null)?.ticket;
  if (!isWellFormedAccountMergeTicket(ticket)) {
    return {
      ok: false,
      body: { error: 'A merge ticket is required.', code: 'INVALID_TICKET' },
      status: 400,
    };
  }

  const { data, error } = await resolvedAdmin.rpc('redeem_account_merge_ticket', {
    p_ticket_hash: hashAccountMergeTicket(ticket),
    p_target_user_id: identity.identity.userId,
    p_source_surface: 'mobile',
  });

  if (error) {
    logBackendError('account_merge_failed', { error, targetUserId: identity.identity.userId });
    return {
      ok: false,
      body: { error: 'Could not link your guest data.' },
      status: 500,
    };
  }

  const payload = (data ?? {}) as Record<string, unknown>;

  return {
    ok: true,
    body: {
      status: String(payload.status ?? 'not_eligible') as AccountMergeStatus,
      creditsMoved: toNumber(payload.credits_moved),
      promotionalCreditsMoved: toNumber(payload.promotional_credits_moved),
      credits: typeof payload.credits === 'number' ? payload.credits : null,
    },
  };
}
