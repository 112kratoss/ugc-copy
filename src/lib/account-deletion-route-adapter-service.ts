import {
  IDENTITY_CHECK_UNAVAILABLE,
  SESSION_MERGED,
  isGuestUser,
  requireIdentity,
} from '@/lib/account-identity';
import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { after, NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  ACCOUNT_DELETION_RATE_LIMIT,
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  AccountDeletionNotStartedError,
  finishInitialAccountDeletion,
  GuestAccountLinkedError,
  markAccountDeletionStage,
  startInitialAccountDeletion,
  type InitialAccountDeletionStart,
} from '@/lib/account-deletion-service';
import {
  AppleAccountDeletionError,
  authorizeAppleAccountDeletion,
} from '@/lib/apple-account-deletion-service';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import { getAuthoritativeAuthUserResult } from '@/lib/server-auth-user';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';

const RECENT_AUTH_MAX_AGE_MS = 15 * 60 * 1000;
const RECENT_AUTH_FUTURE_SKEW_MS = 60 * 1000;

// Every refusal that a fresh sign-in clears says so in one field the website
// and the app both read. It sits beside `code` rather than replacing it,
// because installed apps open their sign-in-again card on the legacy codes.
const REAUTHENTICATION_REQUIRED = 'reauthentication_required';

// The same refusal identity admission gives a linked guest's session
// (account-identity.ts), so the app takes the one path it already has for it.
const GUEST_SESSION_MERGED_MESSAGE =
  'This guest session has been linked to an account. Sign in to continue.';

type AccountDeletionDependencies = {
  authorizeAppleAccountDeletion?: typeof authorizeAppleAccountDeletion;
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  invalidateShowcaseFeedCache?: typeof invalidateShowcaseFeedCache;
  logError?: typeof logBackendRouteError;
  now?: () => Date;
  requireIdentity?: typeof requireIdentity;
  runAfterResponse?: RunAfterResponse;
};

function hasRecentAuthentication(lastSignInAt: string | undefined, now: Date) {
  if (!lastSignInAt) return false;
  const signedInAtMs = Date.parse(lastSignInAt);
  if (!Number.isFinite(signedInAtMs)) return false;
  const ageMs = now.getTime() - signedInAtMs;
  return ageMs >= -RECENT_AUTH_FUTURE_SKEW_MS && ageMs <= RECENT_AUTH_MAX_AGE_MS;
}

async function parseDeletionRequest(request: Request) {
  try {
    const body = await request.json() as {
      appleAuthorizationCode?: unknown;
      confirmation?: unknown;
    };
    return {
      appleAuthorizationCode:
        typeof body.appleAuthorizationCode === 'string'
          ? body.appleAuthorizationCode
          : undefined,
      confirmed: body.confirmation === 'DELETE',
    };
  } catch {
    return { appleAuthorizationCode: undefined, confirmed: false };
  }
}

function getAppleIdentity(user: {
  identities?: Array<{
    id?: unknown;
    identity_data?: Record<string, unknown>;
    provider?: unknown;
    provider_id?: unknown;
  }> | null;
}) {
  const identity = user.identities?.find((candidate) => candidate.provider === 'apple');
  if (!identity) return null;
  const subjectCandidates = [
    identity.provider_id,
    identity.identity_data?.provider_id,
    identity.identity_data?.sub,
    identity.id,
  ];
  const subject = subjectCandidates.find(
    (candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()),
  );
  return { subject: subject?.trim() ?? '' };
}

function getBearerAccessToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization')?.trim() ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return undefined;
  const token = authorization.slice(7).trim();
  return token || undefined;
}

// A 500 always says whether the account is untouched (`deletionScheduled:
// false`, safe to retry) or already locked with a job the scheduler finishes.
function deletionFailureResponse(request: Request, deletionScheduled: boolean) {
  return applyPrivateNoStoreApiResponseHeaders(
    NextResponse.json(
      deletionScheduled
        ? {
            error: 'Your account is being deleted and will be removed automatically.',
            code: 'ACCOUNT_DELETION_RETRY_SCHEDULED',
            deletionScheduled: true,
          }
        : {
            error: 'Account deletion could not be completed. Please try again.',
            code: 'ACCOUNT_DELETION_NOT_STARTED',
            deletionScheduled: false,
          },
      { status: 500 },
    ),
    request,
  );
}

/**
 * `DELETE /api/account`: an account's permanent deletion, and since D5
 * (2026-10-15) a guest's deletion of its own data.
 *
 * An account proves it is still its owner first: Apple's one-time code for an
 * account with an Apple identity, otherwise a sign-in in the last 15 minutes.
 * A guest has no provider identity and no password, so there is nothing it
 * could sign in again with; its token is the whole identity, and admission has
 * just verified it as an active guest. What a guest has to show instead is
 * that the identity is still its own: prepare_guest_account_deletion refuses a
 * guest linked to an account (409 SESSION_MERGED, nothing changed), because
 * the account now acts for what the guest made. Past that check a guest goes
 * down the account pipeline and gets the same answers.
 */
export async function deleteAccountRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: AccountDeletionDependencies;
  request: Request;
}) {
  const resolved = {
    authorizeAppleAccountDeletion:
      dependencies?.authorizeAppleAccountDeletion ?? authorizeAppleAccountDeletion,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    invalidateShowcaseFeedCache: dependencies?.invalidateShowcaseFeedCache ?? invalidateShowcaseFeedCache,
    logError: dependencies?.logError ?? logBackendRouteError,
    now: dependencies?.now ?? (() => new Date()),
    requireIdentity: dependencies?.requireIdentity ?? requireIdentity,
    runAfterResponse: dependencies?.runAfterResponse ?? ((task) => after(task)),
  };
  const userClient = resolved.createUserClient(request);
  let adminClient: ReturnType<typeof resolved.createServiceClient> | null = null;
  const getAdmin = () => {
    adminClient ??= resolved.createServiceClient();
    return adminClient;
  };
  // An active guest or an account. A linked guest's session (409
  // SESSION_MERGED) and an identity already being deleted (409
  // ACCOUNT_DELETING) stop here, as they do at the proxy.
  const identity = await resolved.requireIdentity(userClient, getAdmin);

  if (!identity.ok) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json(
        { error: identity.error, code: identity.code },
        { status: identity.status },
      ),
      request,
    );
  }

  // `requireIdentity` normally reuses the proxy's signed identity admission
  // assertion. That assertion deliberately contains only the user fields
  // needed by the majority of routes; it omits provider identities and
  // `last_sign_in_at`. Account deletion needs both to choose and verify the
  // correct reauthentication path (and whether there is one: a guest has
  // none), so perform a fresh authoritative Auth lookup for this destructive
  // operation instead of making that assertion carry sensitive provider data
  // for every request.
  let user;
  try {
    const { data, error } = await getAuthoritativeAuthUserResult(userClient);
    if (error || !data.user || data.user.id !== identity.identity.userId) {
      throw error ?? new Error('Authoritative account identity did not match the admitted user.');
    }
    user = data.user;
  } catch (error) {
    resolved.logError('Account deletion authoritative identity lookup failed:', error);
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({
        error: 'Identity verification is temporarily unavailable. Please try again.',
        code: IDENTITY_CHECK_UNAVAILABLE,
      }, { status: 503 }),
      request,
    );
  }

  const admin = getAdmin();
  const deletionRequest = await parseDeletionRequest(request);

  if (!deletionRequest.confirmed) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Type DELETE to confirm permanent account deletion.' }, { status: 400 }),
      request,
    );
  }

  // Read from the fresh Auth record, not the admission assertion: an identity
  // linked to a provider since its token was minted is an account.
  const guest = isGuestUser(user);
  const appleIdentity = guest ? null : getAppleIdentity(user);
  if (appleIdentity && !deletionRequest.appleAuthorizationCode?.trim()) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({
        error: 'Continue with Apple before permanently deleting your account.',
        code: 'APPLE_REAUTH_REQUIRED',
        reason: REAUTHENTICATION_REQUIRED,
        reauthenticate: true,
      }, { status: 403 }),
      request,
    );
  }

  if (
    !guest
    && !appleIdentity
    && !hasRecentAuthentication(user.last_sign_in_at, resolved.now())
  ) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({
        error: 'Please sign in again before permanently deleting your account.',
        code: 'RECENT_AUTH_REQUIRED',
        reason: REAUTHENTICATION_REQUIRED,
        reauthenticate: true,
      }, { status: 403 }),
      request,
    );
  }

  try {
    await resolved.enforceBackendRateLimit(admin, {
      ...ACCOUNT_DELETION_RATE_LIMIT,
      key: user.id,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return applyPrivateNoStoreApiResponseHeaders(
        createBackendRateLimitResponse(error),
        request,
      );
    }

    resolved.logError('Account deletion rate limit check failed:', error);
    return deletionFailureResponse(request, false);
  }

  if (appleIdentity) {
    try {
      await resolved.authorizeAppleAccountDeletion({
        authorizationCode: deletionRequest.appleAuthorizationCode as string,
        expectedAppleSubject: appleIdentity.subject,
      });
    } catch (error) {
      if (error instanceof AppleAccountDeletionError) {
        if (error.status >= 500) {
          resolved.logError('Apple account deletion authorization failed:', error);
        }
        return applyPrivateNoStoreApiResponseHeaders(
          NextResponse.json({
            error: error.message,
            code: error.code,
            ...(error.reauthenticate
              ? { reason: REAUTHENTICATION_REQUIRED, reauthenticate: true }
              : {}),
          }, { status: error.status }),
          request,
        );
      }
      resolved.logError('Apple account deletion authorization failed:', error);
      return applyPrivateNoStoreApiResponseHeaders(
        NextResponse.json({
          error: 'Apple account verification is temporarily unavailable. Your account is still active; please try again later.',
          code: 'APPLE_REVOCATION_UNAVAILABLE',
        }, { status: 503 }),
        request,
      );
    }
  }

  const userId = user.id;
  // A `failed` stage puts the job in front of the scheduler's next run.
  const persistDeletionFailure = async (error: unknown) => {
    try {
      await markAccountDeletionStage(admin, userId, 'failed', error);
    } catch (stageError) {
      resolved.logError('Account deletion failure stage could not be persisted:', stageError);
    }
    resolved.logError('Account deletion failed:', error);
  };

  let start: InitialAccountDeletionStart;
  try {
    start = await startInitialAccountDeletion({
      accessToken: getBearerAccessToken(request),
      admin,
      userId,
      identityKind: guest ? 'guest' : 'registered',
    });
  } catch (error) {
    if (error instanceof GuestAccountLinkedError) {
      // Refused before anything changed: there is no job to mark failed.
      return applyPrivateNoStoreApiResponseHeaders(
        NextResponse.json(
          { error: GUEST_SESSION_MERGED_MESSAGE, code: SESSION_MERGED },
          { status: 409 },
        ),
        request,
      );
    }
    await persistDeletionFailure(error);
    return deletionFailureResponse(request, !(error instanceof AccountDeletionNotStartedError));
  }

  if (start.status === 'already_deleted') {
    resolved.invalidateShowcaseFeedCache();
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({
        success: true,
        deleted: true,
        cleanupPending: start.result.cleanupPending,
        alreadyDeleted: true,
      }),
      request,
    );
  }

  // The account can no longer be used and every session is gone, so nobody
  // waits on the storage sweep: a slow one outlasted the app's request timeout
  // and was reported as "not deleted" while it went on.
  const { manifest } = start;
  const finishDeletion = async () => {
    try {
      await finishInitialAccountDeletion({
        admin,
        userId,
        manifest,
        onNonFatalError: resolved.logError,
      });
    } catch (error) {
      await persistDeletionFailure(error);
      return;
    }
    resolved.invalidateShowcaseFeedCache();
  };
  try {
    resolved.runAfterResponse(finishDeletion);
  } catch (error) {
    // Nothing runs the sweep behind this answer; the scheduler takes it over.
    await persistDeletionFailure(error);
  }

  return applyPrivateNoStoreApiResponseHeaders(
    NextResponse.json(
      { success: true, deleted: false, deletionScheduled: true },
      { status: 202 },
    ),
    request,
  );
}
