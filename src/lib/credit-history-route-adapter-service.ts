import 'server-only';

import { NextResponse } from 'next/server';

import { requireIdentity, resolveLinkedAccountIds } from '@/lib/account-identity';
import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import {
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { listCreditHistory, parseCreditHistoryQuery } from '@/lib/credit-history-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

/**
 * GET /api/credits/history (contract C4): one page of what added credits to the
 * caller's balance and what took them, newest first.
 *
 * A guest reads its own; an account reads its own together with every guest
 * identity linked to it, because a guest's purchases and spends keep the guest's
 * id forever while their credits moved to the account. The route policy admits
 * both (`route-identity-policy.ts`); a linked guest session is refused 409
 * `SESSION_MERGED` by `requireIdentity`, as on every other route.
 */

// A person opening the list and scrolling it, several devices at once; it stops a
// runaway client, not reading.
export const CREDIT_HISTORY_READ_RATE_LIMIT = {
  scope: 'credit-history:read',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

type CreditHistoryRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  listCreditHistory?: typeof listCreditHistory;
  logError?: typeof logBackendRouteError;
  requireIdentity?: typeof requireIdentity;
  resolveLinkedAccountIds?: typeof resolveLinkedAccountIds;
};

function resolveDependencies(dependencies: CreditHistoryRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    listCreditHistory: dependencies?.listCreditHistory ?? listCreditHistory,
    logError: dependencies?.logError ?? logBackendRouteError,
    requireIdentity: dependencies?.requireIdentity ?? requireIdentity,
    resolveLinkedAccountIds: dependencies?.resolveLinkedAccountIds ?? resolveLinkedAccountIds,
  };
}

async function handleCreditHistoryGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
): Promise<Response> {
  try {
    const supabase = dependencies.createUserClient(request);
    let admin: ReturnType<typeof dependencies.createServiceClient> | null = null;
    const getAdmin = () => {
      admin ??= dependencies.createServiceClient();
      return admin;
    };

    const identity = await dependencies.requireIdentity(supabase, getAdmin);
    if (!identity.ok) {
      return NextResponse.json(
        { error: identity.error, code: identity.code },
        { status: identity.status },
      );
    }

    const parsed = parseCreditHistoryQuery(new URL(request.url).searchParams);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
    }

    const { userId, isGuest } = identity.identity;
    try {
      await dependencies.enforceBackendRateLimit(getAdmin(), {
        ...CREDIT_HISTORY_READ_RATE_LIMIT,
        key: userId,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      dependencies.logError('Credit history rate limit check failed:', error);
      return NextResponse.json({ error: 'Failed to check credit history read limits.' }, { status: 500 });
    }

    // Nothing is ever linked to a guest (only a registered account can be a link's
    // target), so a guest's set is itself and costs no lookup.
    const userIds = isGuest
      ? [userId]
      : await dependencies.resolveLinkedAccountIds(getAdmin(), userId);

    const page = await dependencies.listCreditHistory({
      client: getAdmin(),
      userIds,
      cursor: parsed.query.cursor,
      limit: parsed.query.limit,
    });

    return NextResponse.json(page);
  } catch (error) {
    dependencies.logError('Failed to load credit history:', error);
    return NextResponse.json(
      { error: 'Could not load your credit history. Please try again.' },
      { status: 500 },
    );
  }
}

export async function getCreditHistoryRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: CreditHistoryRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleCreditHistoryGET(request, resolveDependencies(dependencies)),
    request,
  );
}

export function createCreditHistoryRouteHandlers({
  dependencies,
}: {
  dependencies?: CreditHistoryRouteDependencies;
} = {}) {
  return {
    GET(request: Request) {
      return getCreditHistoryRouteResponse({ dependencies, request });
    },
  };
}
