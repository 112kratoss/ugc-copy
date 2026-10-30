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
import { findCreatorActiveRun, parseCreatorActiveRunTool } from '@/lib/creator-active-run-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

/**
 * GET /api/generations/active?tool=image|video|motion: `{ run }`, the caller's
 * newest run of that creator still at work, or null.
 *
 * A guest reads its own; an account reads its own together with every guest
 * identity linked to it, whose runs keep the guest's id. The route policy
 * admits both (`route-identity-policy.ts`).
 */

// Read once each time a creator page opens, in as many tabs as are open; it
// stops a runaway client, not a person moving between creators.
export const CREATOR_ACTIVE_RUN_READ_RATE_LIMIT = {
  scope: 'creator-active-run:read',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

type CreatorActiveRunRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  findCreatorActiveRun?: typeof findCreatorActiveRun;
  logError?: typeof logBackendRouteError;
  requireIdentity?: typeof requireIdentity;
  resolveLinkedAccountIds?: typeof resolveLinkedAccountIds;
};

function resolveDependencies(dependencies: CreatorActiveRunRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    findCreatorActiveRun: dependencies?.findCreatorActiveRun ?? findCreatorActiveRun,
    logError: dependencies?.logError ?? logBackendRouteError,
    requireIdentity: dependencies?.requireIdentity ?? requireIdentity,
    resolveLinkedAccountIds: dependencies?.resolveLinkedAccountIds ?? resolveLinkedAccountIds,
  };
}

async function handleCreatorActiveRunGET(
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

    const tool = parseCreatorActiveRunTool(new URL(request.url).searchParams.get('tool'));
    if (!tool) {
      return NextResponse.json(
        { error: 'tool must be image, video or motion.', code: 'INVALID_TOOL' },
        { status: 400 },
      );
    }

    const { userId, isGuest } = identity.identity;
    try {
      await dependencies.enforceBackendRateLimit(getAdmin(), {
        ...CREATOR_ACTIVE_RUN_READ_RATE_LIMIT,
        key: userId,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      dependencies.logError('Creator active run rate limit check failed:', error);
      return NextResponse.json({ error: 'Failed to check active run read limits.' }, { status: 500 });
    }

    // Nothing is ever linked to a guest (only a registered account can be a link's
    // target), so a guest's set is itself and costs no lookup.
    const userIds = isGuest
      ? [userId]
      : await dependencies.resolveLinkedAccountIds(getAdmin(), userId);

    const run = await dependencies.findCreatorActiveRun({ client: getAdmin(), userIds, tool });
    return NextResponse.json({ run });
  } catch (error) {
    dependencies.logError('Failed to load the creator active run:', error);
    return NextResponse.json(
      { error: 'Could not check for a run in progress.' },
      { status: 500 },
    );
  }
}

export async function getCreatorActiveRunRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: CreatorActiveRunRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleCreatorActiveRunGET(request, resolveDependencies(dependencies)),
    request,
  );
}

export function createCreatorActiveRunRouteHandlers({
  dependencies,
}: {
  dependencies?: CreatorActiveRunRouteDependencies;
} = {}) {
  return {
    GET(request: Request) {
      return getCreatorActiveRunRouteResponse({ dependencies, request });
    },
  };
}
