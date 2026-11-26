import 'server-only';

import { NextResponse } from 'next/server';

import { isGuestUser } from '@/lib/account-identity';
import {
  API_CACHE_CONTROL,
  applyApiResponseHeaders,
  applyPrivateNoStoreApiResponseHeaders,
} from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import {
  BackendRateLimitError,
  SUPPORT_HUB_REACTION_RATE_LIMIT,
  SUPPORT_HUB_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';
import {
  isSupportHubId,
  listSupportRoadmap,
  listSupportUpdates,
  normalizeSupportUpdatesLimit,
  setSupportRoadmapReaction,
  setSupportUpdateReaction,
} from '@/lib/support-hub-service';

import { readSupportHubReactionRequest } from '../../ugc-mobile/lib/support-hub-policy/support-hub-policy';

/**
 * Help & Support's Updates and Roadmap (plan:
 * docs/plans/help-support-updates-roadmap-plan-2026-11-26.md).
 *
 * - `GET /api/support/updates?cursor=&limit=`: the updates people can see,
 *   newest first, with their reactions and, for a reader with a token, the
 *   reader's own.
 * - `GET /api/support/roadmap`: the roadmap, the same way.
 * - `POST /api/support/updates/:postId/reaction` and
 *   `POST /api/support/roadmap/:itemId/reaction`: `{ emoji }` sets the
 *   account's reaction, `{ emoji: null }` clears it.
 *
 * The paths are registered-only in route-identity-policy.ts, and their GETs
 * are listed in GUEST_READABLE_REGISTERED_ROUTES: everyone reads them, as the
 * comments under a post. A reaction is an account's: a guest's token is
 * refused at the proxy and again here. The web asks the lists of a visitor
 * with no session at all as `scope=public`, and that answer, read for no one,
 * may be kept by the CDN for a minute, as the comments thread's is.
 */

export const SUPPORT_HUB_SCOPE_PARAM = 'scope';
export const SUPPORT_HUB_PUBLIC_SCOPE = 'public';

const REACTION_BODY_MAX_BYTES = 1024;

type SupportHubRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  listSupportUpdates?: typeof listSupportUpdates;
  listSupportRoadmap?: typeof listSupportRoadmap;
  setSupportUpdateReaction?: typeof setSupportUpdateReaction;
  setSupportRoadmapReaction?: typeof setSupportRoadmapReaction;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  readBoundedJsonBody?: typeof readBoundedJsonBody;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: SupportHubRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    listSupportUpdates: dependencies?.listSupportUpdates ?? listSupportUpdates,
    listSupportRoadmap: dependencies?.listSupportRoadmap ?? listSupportRoadmap,
    setSupportUpdateReaction: dependencies?.setSupportUpdateReaction ?? setSupportUpdateReaction,
    setSupportRoadmapReaction: dependencies?.setSupportRoadmapReaction ?? setSupportRoadmapReaction,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    readBoundedJsonBody: dependencies?.readBoundedJsonBody ?? readBoundedJsonBody,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

type Resolved = ReturnType<typeof resolveDependencies>;
type UpdateReactionContext = { params: Promise<{ postId: string }> };
type RoadmapReactionContext = { params: Promise<{ itemId: string }> };

/** The reader a token names, if the request carries one: a guest reads with their own id, and has no reaction. */
async function readViewerUserId(request: Request, dependencies: Resolved): Promise<string | null> {
  if (!request.headers.get('Authorization')) return null;
  const supabase = dependencies.createUserClient(request);
  const { data: { user } } = await getVerifiedAuthUserResult(supabase);
  return user?.id ?? null;
}

/** The registered account behind the request, or null (no token, a refused one, or a guest's). */
/**
 * The account a reaction is for: a registered one. No account answers 401
 * UNAUTHORIZED and a guest 403 REGISTRATION_REQUIRED, the proxy's own answers,
 * which it gives first (this is the backstop).
 */
async function readReactingUser(
  request: Request,
  dependencies: Resolved,
): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
  const supabase = dependencies.createUserClient(request);
  const { data: { user }, error } = await getVerifiedAuthUserResult(supabase);
  if (error || !user) {
    return { ok: false, response: NextResponse.json({ error: 'Sign in to react.', code: 'UNAUTHORIZED' }, { status: 401 }) };
  }
  if (isGuestUser(user)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Create an account to react.', code: 'REGISTRATION_REQUIRED' }, { status: 403 }),
    };
  }
  return { ok: true, userId: user.id };
}

/** A Supabase session cookie of any project, whole or in chunks, as the comments thread reads it. */
function carriesSupabaseAuthCookie(request: Request) {
  return (request.headers.get('cookie') ?? '').split(';').some((part) => {
    const name = part.trim().split('=', 1)[0] ?? '';
    return name.startsWith('sb-') && name.includes('-auth-token');
  });
}

/** A read for no one that the CDN may keep: `scope=public` and no session of any kind. */
function isSharedPublicRead(request: Request) {
  return new URL(request.url).searchParams.get(SUPPORT_HUB_SCOPE_PARAM) === SUPPORT_HUB_PUBLIC_SCOPE
    && !request.headers.has('authorization')
    && !carriesSupabaseAuthCookie(request);
}

async function limit(
  dependencies: Resolved,
  rule: typeof SUPPORT_HUB_READ_RATE_LIMIT | typeof SUPPORT_HUB_REACTION_RATE_LIMIT,
  key: string,
): Promise<NextResponse | null> {
  try {
    await dependencies.enforceBackendRateLimit(dependencies.createServiceClient(), { ...rule, key });
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) return createBackendRateLimitResponse(error);
    throw error;
  }
}

function withReadHeaders(response: NextResponse, request: Request, sharedPublicRead: boolean) {
  return sharedPublicRead && response.status === 200
    ? applyApiResponseHeaders(response, request, API_CACHE_CONTROL.publicMinuteEdge, { vary: ['Authorization'] })
    : applyPrivateNoStoreApiResponseHeaders(response, request, { vary: ['Authorization'] });
}

async function handleUpdatesGET(request: Request, dependencies: Resolved, sharedPublicRead: boolean) {
  const viewerUserId = sharedPublicRead ? null : await readViewerUserId(request, dependencies);
  const limited = await limit(dependencies, SUPPORT_HUB_READ_RATE_LIMIT, viewerUserId ?? dependencies.getFeedNetworkKeyHash(request));
  if (limited) return limited;

  const searchParams = new URL(request.url).searchParams;
  try {
    const page = await dependencies.listSupportUpdates({
      adminSupabase: dependencies.createServiceClient(),
      viewerUserId,
      cursor: searchParams.get('cursor'),
      limit: normalizeSupportUpdatesLimit(searchParams.get('limit')),
    });
    return NextResponse.json(page);
  } catch (error) {
    dependencies.logError('Failed to load the support updates:', error);
    return NextResponse.json({ error: 'Updates could not be loaded.' }, { status: 500 });
  }
}

async function handleRoadmapGET(request: Request, dependencies: Resolved, sharedPublicRead: boolean) {
  const viewerUserId = sharedPublicRead ? null : await readViewerUserId(request, dependencies);
  const limited = await limit(dependencies, SUPPORT_HUB_READ_RATE_LIMIT, viewerUserId ?? dependencies.getFeedNetworkKeyHash(request));
  if (limited) return limited;

  try {
    const roadmap = await dependencies.listSupportRoadmap({
      adminSupabase: dependencies.createServiceClient(),
      viewerUserId,
    });
    return NextResponse.json(roadmap);
  } catch (error) {
    dependencies.logError('Failed to load the support roadmap:', error);
    return NextResponse.json({ error: 'The roadmap could not be loaded.' }, { status: 500 });
  }
}

async function readReactionBody(request: Request, dependencies: Resolved) {
  const body = await dependencies.readBoundedJsonBody(request, REACTION_BODY_MAX_BYTES);
  if (!body.ok) return null;
  return readSupportHubReactionRequest(body.value);
}

async function handleReactionPOST(
  request: Request,
  dependencies: Resolved,
  targetId: string,
  set: (userId: string, emoji: Parameters<Resolved['setSupportUpdateReaction']>[0]['emoji']) => ReturnType<Resolved['setSupportUpdateReaction']>,
) {
  const reacting = await readReactingUser(request, dependencies);
  if (!reacting.ok) return reacting.response;
  const { userId } = reacting;
  if (!isSupportHubId(targetId)) return NextResponse.json({ error: 'Not found.', code: 'NOT_FOUND' }, { status: 404 });

  const reaction = await readReactionBody(request, dependencies);
  if (!reaction) {
    return NextResponse.json({ error: 'Choose one of the quick reactions.', code: 'INVALID_REACTION' }, { status: 400 });
  }

  const limited = await limit(dependencies, SUPPORT_HUB_REACTION_RATE_LIMIT, userId);
  if (limited) return limited;

  try {
    const result = await set(userId, reaction.emoji);
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    return NextResponse.json(result.value);
  } catch (error) {
    dependencies.logError('Failed to save a support hub reaction:', error);
    return NextResponse.json({ error: 'Your reaction was not saved.' }, { status: 500 });
  }
}

export function createSupportUpdatesRouteHandlers({ dependencies }: { dependencies?: SupportHubRouteDependencies } = {}) {
  const resolved = resolveDependencies(dependencies);
  return {
    async GET(request: Request) {
      const sharedPublicRead = isSharedPublicRead(request);
      return withReadHeaders(await handleUpdatesGET(request, resolved, sharedPublicRead), request, sharedPublicRead);
    },
  };
}

export function createSupportRoadmapRouteHandlers({ dependencies }: { dependencies?: SupportHubRouteDependencies } = {}) {
  const resolved = resolveDependencies(dependencies);
  return {
    async GET(request: Request) {
      const sharedPublicRead = isSharedPublicRead(request);
      return withReadHeaders(await handleRoadmapGET(request, resolved, sharedPublicRead), request, sharedPublicRead);
    },
  };
}

export function createSupportUpdateReactionRouteHandlers({ dependencies }: { dependencies?: SupportHubRouteDependencies } = {}) {
  const resolved = resolveDependencies(dependencies);
  return {
    async POST(request: Request, context: UpdateReactionContext) {
      const { postId } = await context.params;
      const response = await handleReactionPOST(request, resolved, postId, (userId, emoji) => resolved.setSupportUpdateReaction({
        adminSupabase: resolved.createServiceClient(),
        userId,
        postId,
        emoji,
      }));
      return applyPrivateNoStoreApiResponseHeaders(response, request);
    },
  };
}

export function createSupportRoadmapReactionRouteHandlers({ dependencies }: { dependencies?: SupportHubRouteDependencies } = {}) {
  const resolved = resolveDependencies(dependencies);
  return {
    async POST(request: Request, context: RoadmapReactionContext) {
      const { itemId } = await context.params;
      const response = await handleReactionPOST(request, resolved, itemId, (userId, emoji) => resolved.setSupportRoadmapReaction({
        adminSupabase: resolved.createServiceClient(),
        userId,
        itemId,
        emoji,
      }));
      return applyPrivateNoStoreApiResponseHeaders(response, request);
    },
  };
}
