import 'server-only';

import { after, NextResponse } from 'next/server';

import { createPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SEARCH_OPENED_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { logBackendEvent, logBackendRouteError } from '@/lib/backend-logger';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import {
  PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH,
  normalizeCreatorSearchQuery,
  publicSearchQueryLength,
} from '@/lib/public-search';
import { isSearchQueryLogDisabled } from '@/lib/public-search-query-log';
import { recordSearchOpen } from '@/lib/search-open-log';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';
import { readSearchOpenBody } from '../../ugc-mobile/lib/public-search-policy/search-open-log';

/**
 * `POST /api/search/opened`: a client says which result a person pressed from a search, so the
 * anonymous search log holds what was chosen beside what was asked (`src/lib/search-open-log.ts`).
 *
 * What it answers, and why none of it says whether an id exists or may be seen:
 *
 *   204, no body   every well-formed report: written, dropped because the log is switched off,
 *                  or lost to a failed write. The id is stored as sent and never looked up, so
 *                  an id of a private post, of a deleted one and of nothing at all are the same
 *                  request with the same answer and the same work behind it;
 *   400            a body that is not the shape `searchOpenBody` builds (a syntax check alone);
 *   401            a token that does not verify, as `/api/search` answers one, so a signed-in
 *                  client's report is never quietly keyed on its network instead;
 *   413            a body past 2 KB;
 *   429            past the route's own limit, counted on the key `/api/search` counts on.
 *
 * Admitted as `/api/search` is (a public route: no token is a visitor, a guest's token is a guest,
 * an agent's is refused at the proxy), and keyed as it is: the user id, or the hashed network
 * address. That key is what makes the open's per-day visitor code equal its search's, so a client
 * must send the same Authorization header (or none) with both.
 */

/** A report is seven short fields; this is several times the longest one. */
export const SEARCH_OPENED_MAX_BODY_BYTES = 2 * 1024;

type Environment = Record<string, string | undefined>;

type SearchOpenedRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  logError?: typeof logBackendRouteError;
  /** The log's failure line. */
  logEvent?: typeof logBackendEvent;
  /** Where the insert goes once the answer is out; Next's `after` by default. */
  runAfterResponse?: RunAfterResponse;
  /** Where the kill switch is read from; `process.env` by default. */
  env?: Environment;
};

/** Next's `after`, which takes a task only inside a request; outside one the task runs at once. */
function runAfterResponseByDefault(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

function resolveDependencies(dependencies?: SearchOpenedRouteDependencies) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    logError: dependencies?.logError ?? logBackendRouteError,
    logEvent: dependencies?.logEvent ?? logBackendEvent,
    runAfterResponse: dependencies?.runAfterResponse ?? runAfterResponseByDefault,
    env: dependencies?.env ?? process.env,
  };
}

/** As `/api/search` resolves its viewer: no token is a visitor, and one that does not verify is refused. */
async function resolveViewerUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!request.headers.get('Authorization')) return { ok: true as const, viewerUserId: null };
  try {
    const client = dependencies.createUserClient(request);
    const { data: { user }, error } = await getVerifiedAuthUserResult(client);
    if (error || !user?.id) return { ok: false as const, viewerUserId: null };
    return { ok: true as const, viewerUserId: user.id };
  } catch {
    return { ok: false as const, viewerUserId: null };
  }
}

function refusal(request: Request, status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: createPrivateNoStoreApiResponseHeaders(request) });
}

/** The one answer of every well-formed report. */
function accepted(request: Request) {
  return new NextResponse(null, { status: 204, headers: createPrivateNoStoreApiResponseHeaders(request) });
}

export async function postSearchOpenedRouteResponse({
  dependencies: overrides,
  request,
}: {
  dependencies?: SearchOpenedRouteDependencies;
  request: Request;
}) {
  const dependencies = resolveDependencies(overrides);
  const requestedAt = new Date();
  try {
    const body = await readBoundedJsonBody(request, SEARCH_OPENED_MAX_BODY_BYTES);
    if (!body.ok) {
      return body.reason === 'too_large'
        ? refusal(request, 413, 'The request body is too large.')
        : refusal(request, 400, 'The body must be a JSON object.');
    }
    const reading = readSearchOpenBody(body.value);
    if (!reading.ok) return refusal(request, 400, reading.error);
    // The shortest query a search runs on: no result was ever shown for less.
    if (
      publicSearchQueryLength(normalizeCreatorSearchQuery(reading.open.query))
      < PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH
    ) {
      return refusal(request, 400, `q must contain at least ${PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH} characters.`);
    }

    // Switched off: the answer every report gets, before a token is verified or a row is read.
    if (isSearchQueryLogDisabled(dependencies.env)) return accepted(request);

    const actor = await resolveViewerUserId(request, dependencies);
    if (!actor.ok) return refusal(request, 401, 'Authentication required.');

    const viewerKey = actor.viewerUserId ?? dependencies.getFeedNetworkKeyHash(request);
    try {
      await dependencies.enforceBackendRateLimit(dependencies.createServiceClient(), {
        ...SEARCH_OPENED_RATE_LIMIT,
        key: viewerKey,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        const response = createBackendRateLimitResponse(error);
        for (const [name, value] of Object.entries(createPrivateNoStoreApiResponseHeaders(request))) {
          response.headers.set(name, value);
        }
        return response;
      }
      // The limit could not be counted, so nothing is written: an unbounded log is worse than a
      // missing row, and the person who pressed a result is owed no error for it.
      dependencies.logError('Search opened rate limit failed:', error);
      return accepted(request);
    }

    recordSearchOpen({
      createClient: dependencies.createServiceClient,
      runAfterResponse: dependencies.runAfterResponse,
      logEvent: dependencies.logEvent,
      env: dependencies.env,
    }, { open: reading.open, viewerKey, requestedAt });
    return accepted(request);
  } catch (error) {
    dependencies.logError('Search opened failed:', error);
    return accepted(request);
  }
}
