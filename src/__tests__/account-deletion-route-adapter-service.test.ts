import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { deleteAccountRouteResponse } from '@/lib/account-deletion-route-adapter-service';
import {
  APPLE_ACCOUNT_DELETION_ENDPOINTS,
  AppleAccountDeletionError,
  authorizeAppleAccountDeletion,
} from '@/lib/apple-account-deletion-service';
import {
  registerIdentityAdmissionContext,
  signIdentityAdmission,
} from '@/lib/identity-admission-assertion';

function request(
  body: unknown,
  authorization = 'Bearer token',
  extraHeaders: Record<string, string> = {},
) {
  return new Request('https://magicbooklet.test/api/account', {
    method: 'DELETE',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

const RECENT_SIGN_IN = '2026-07-14T12:00:00.000Z';
const NOW = new Date('2026-07-14T12:05:00.000Z');
const USER_ID = '87c4b811-7a50-4e1a-9c38-7ab2693c1182';

afterEach(() => {
  vi.unstubAllEnvs();
});

function authenticatedUser(lastSignInAt = RECENT_SIGN_IN) {
  return { id: USER_ID, last_sign_in_at: lastSignInAt };
}

async function requireIdentityForRouteTest(userClient: {
  auth: {
    getUser: () => Promise<{
      data: { user: { id: string; last_sign_in_at?: string; is_anonymous?: boolean } | null };
      error: unknown;
    }>;
  };
}) {
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) {
    return { ok: false as const, status: 401, code: 'UNAUTHORIZED' as const, error: 'Unauthorized' };
  }
  const isGuest = user.is_anonymous === true;
  return {
    ok: true as const,
    identity: { user, userId: user.id, kind: isGuest ? 'guest' as const : 'registered' as const, isGuest },
  };
}

function allowRateLimit() {
  return vi.fn(async () => ({
    allowed: true,
    limit: 3,
    remaining: 2,
    retryAfterSeconds: 0,
    resetAt: new Date().toISOString(),
  }));
}

function recentUserClient() {
  return (() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authenticatedUser() }, error: null })) },
  })) as never;
}

/** Collects what the route hands to after(), so a test can run it once the answer is read. */
function deferredWork() {
  const tasks: Array<() => Promise<unknown>> = [];
  return {
    runAfterResponse: vi.fn((task: () => Promise<unknown>) => {
      tasks.push(task);
    }),
    tasks,
    async runAll() {
      while (tasks.length > 0) await tasks.shift()!();
    },
  };
}

type DeletionClientOptions = {
  /** The account as the Auth admin API returns it; a registered one by default. */
  authUser?: Record<string, unknown>;
  deleteUserError?: unknown;
  listError?: unknown;
  /** Whose files the prepared manifest lists (the account by default). */
  ownerUserIds?: string[];
  prepare?: { data: unknown; error: unknown };
  showcaseMediaPaths?: string[];
  signOutError?: unknown;
  templateAssetPrefixes?: string[];
  wallets?: Array<Record<string, unknown>>;
};

/**
 * A service client for the whole deletion flow. The real fingerprint and
 * wallet recorders run inside it; with no credit grants and no wallets they
 * find nothing to record unless a test says so.
 */
function deletionServiceClient(options: DeletionClientOptions = {}) {
  const calls: string[] = [];
  const removed: Array<{ bucket: string; paths: string[] }> = [];
  const walletRecords: Array<{ rows: unknown; options: unknown }> = [];
  const deletedIdentityRecords: Array<{ rows: unknown; options: unknown }> = [];
  const selectIn = (rows: unknown[]) => {
    const query = {
      select: vi.fn(),
      in: vi.fn(async () => ({ data: rows, error: null })),
    };
    query.select.mockReturnValue(query);
    return query;
  };
  const client = {
    from: vi.fn((table: string) => {
      if (table === 'credit_grants') return selectIn([]);
      if (table === 'creator_resource_wallets') return selectIn(options.wallets ?? []);
      if (table === 'account_deletion_wallet_records') {
        return {
          upsert: vi.fn(async (rows: unknown, upsertOptions: unknown) => {
            calls.push('insert:account_deletion_wallet_records');
            walletRecords.push({ rows, options: upsertOptions });
            return { data: null, error: null };
          }),
        };
      }
      // Kept apart from `calls`: the tests that read the order of the flow
      // name the steps they care about.
      if (table === 'deleted_account_identity_fingerprints') {
        return {
          upsert: vi.fn(async (rows: unknown, upsertOptions: unknown) => {
            deletedIdentityRecords.push({ rows, options: upsertOptions });
            return { data: null, error: null };
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
    auth: {
      admin: {
        getUserById: vi.fn(async (userId: string) => ({
          data: { user: options.authUser ?? { id: userId, email: 'account@example.com', identities: [] } },
          error: null,
        })),
        deleteUser: vi.fn(async (userId: string) => {
          calls.push(`delete:${userId}`);
          return { data: null, error: options.deleteUserError ?? null };
        }),
        signOut: vi.fn(async (_token: string, scope: string) => {
          calls.push(`sign-out:${scope}`);
          return { data: null, error: options.signOutError ?? null };
        }),
      },
    },
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push(`rpc:${name}:${String(args.p_status ?? '')}`);
      if (name === 'prepare_account_deletion' || name === 'prepare_guest_account_deletion') {
        return options.prepare ?? {
          data: {
            status: 'prepared',
            storage_manifest: {
              owner_user_ids: options.ownerUserIds ?? [USER_ID],
              user_prefix_buckets: [
                'profiles',
                'uploads',
                'generated_images',
                'generated_videos',
                'generated_audio',
                'generation_inputs',
                'post_resource_files',
                'template_inputs',
              ],
              showcase_media_paths: options.showcaseMediaPaths ?? [],
              template_asset_prefixes: options.templateAssetPrefixes ?? [],
            },
          },
          error: null,
        };
      }
      if (name === 'list_creator_purchased_revisions_for_retention') {
        return { data: [], error: null };
      }
      if (name === 'mark_account_deleted_upload_reservations') {
        return { data: { status: 'ok', marked: 1 }, error: null };
      }
      return { data: { status: args.p_status }, error: null };
    }),
    storage: {
      from: (bucket: string) => ({
        listV2: vi.fn(async (listOptions: { prefix?: string }) => {
          const prefix = (listOptions.prefix ?? '').replace(/\/$/u, '');
          calls.push(`list:${bucket}:${prefix}`);
          return options.listError
            ? { data: null, error: options.listError }
            : { data: { hasNext: false, folders: [], objects: [] }, error: null };
        }),
        remove: vi.fn(async (paths: string[]) => {
          calls.push(`remove:${bucket}`);
          removed.push({ bucket, paths });
          return { data: [], error: null };
        }),
      }),
    },
  };
  const stages = () => calls
    .filter((call) => call.startsWith('rpc:mark_account_deletion_stage:'))
    .map((call) => call.slice('rpc:mark_account_deletion_stage:'.length));
  return { calls, client, deletedIdentityRecords, removed, stages, walletRecords };
}

describe('account deletion route', () => {
  it('requires an authenticated user', async () => {
    const deleteUser = vi.fn();
    const createServiceClient = vi.fn(() => ({ auth: { admin: { deleteUser } } }));
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: new Error('invalid') })) },
        })) as never,
        createServiceClient: createServiceClient as never,
      },
    });

    expect(response.status).toBe(401);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('requires an explicit permanent deletion confirmation', async () => {
    const deleteUser = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'delete' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
        })) as never,
        createServiceClient: (() => ({ auth: { admin: { deleteUser } } })) as never,
      },
    });

    expect(response.status).toBe(400);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('answers 202 once the account is locked and signed out, then sweeps storage and deletes Auth after the answer', async () => {
    const invalidateShowcaseFeedCache = vi.fn();
    const deferred = deferredWork();
    const deletion = deletionServiceClient({
      showcaseMediaPaths: ['showcase/80000000-0000-4000-8000-000000000008/output.webp'],
      templateAssetPrefixes: ['2b2f4bb5-6ea8-4c44-a394-14cc777dcf52'],
    });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: recentUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        invalidateShowcaseFeedCache,
        now: () => NOW,
        runAfterResponse: deferred.runAfterResponse,
      },
    });

    expect(response.status).toBe(202);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      success: true,
      deleted: false,
      deletionScheduled: true,
    });
    // Answered after prepare, the durable stage and the global sign-out, and
    // before anything slow or destructive.
    expect(deletion.calls).toEqual([
      'rpc:prepare_account_deletion:',
      'rpc:mark_account_deletion_stage:storage_deleting',
      'sign-out:global',
    ]);
    expect(deletion.client.auth.admin.signOut).toHaveBeenCalledWith('token', 'global');
    expect(deferred.runAfterResponse).toHaveBeenCalledOnce();
    // The cached pages showing the account drop it as soon as it is locked, not
    // after the storage sweep: the creator page answers not-found from here.
    expect(invalidateShowcaseFeedCache).toHaveBeenCalledOnce();

    await deferred.runAll();

    expect(deletion.stages()).toEqual([
      'storage_deleting',
      'storage_deleted',
      'auth_deleting',
      'completed',
    ]);
    expect(deletion.calls.indexOf(`delete:${USER_ID}`)).toBeLessThan(
      deletion.calls.indexOf('rpc:mark_account_deletion_stage:completed'),
    );
    expect(deletion.removed).toContainEqual({
      bucket: 'showcase_media',
      paths: ['showcase/80000000-0000-4000-8000-000000000008/output.webp'],
    });
    expect(deletion.calls).toContain('list:template_assets:2b2f4bb5-6ea8-4c44-a394-14cc777dcf52');
    // Again once the sweep has removed the account's posts and files.
    expect(invalidateShowcaseFeedCache).toHaveBeenCalledTimes(2);
  });

  it('records the seller wallet behind the answer before the Auth delete cascades it away', async () => {
    const deferred = deferredWork();
    const wallet = {
      user_id: USER_ID,
      available_token_subunits: 412500,
      held_token_subunits: 0,
      lifetime_earned_token_subunits: 500000,
      lifetime_refunded_token_subunits: 87500,
      lifetime_paid_out_token_subunits: 0,
    };
    const deletion = deletionServiceClient({ wallets: [wallet] });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: recentUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        invalidateShowcaseFeedCache: vi.fn(),
        now: () => NOW,
        runAfterResponse: deferred.runAfterResponse,
      },
    });

    expect(response.status).toBe(202);
    expect(deletion.walletRecords).toEqual([]);

    await deferred.runAll();

    expect(deletion.walletRecords).toEqual([{
      rows: [{ job_id: USER_ID, ...wallet }],
      options: { onConflict: 'user_id,job_id', ignoreDuplicates: true },
    }]);
    expect(deletion.calls.indexOf('insert:account_deletion_wallet_records')).toBeGreaterThan(-1);
    expect(deletion.calls.indexOf('insert:account_deletion_wallet_records')).toBeLessThan(
      deletion.calls.indexOf(`delete:${USER_ID}`),
    );
  });

  // Invite & Earn is for new accounts: the sign-in that had this account is
  // remembered, as a digest, so the same person back again is not counted new.
  it('records the account’s identity digest behind the answer, before Auth is deleted', async () => {
    const deferred = deferredWork();
    const deletion = deletionServiceClient();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: recentUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        invalidateShowcaseFeedCache: vi.fn(),
        now: () => NOW,
        runAfterResponse: deferred.runAfterResponse,
      },
    });

    expect(response.status).toBe(202);
    expect(deletion.deletedIdentityRecords).toEqual([]);

    await deferred.runAll();

    expect(deletion.client.auth.admin.getUserById).toHaveBeenCalledWith(USER_ID);
    expect(deletion.deletedIdentityRecords).toEqual([{
      rows: [{ fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      options: { onConflict: 'fingerprint', ignoreDuplicates: true },
    }]);
    expect(deletion.client.auth.admin.getUserById.mock.invocationCallOrder[0]).toBeLessThan(
      deletion.client.auth.admin.deleteUser.mock.invocationCallOrder[0],
    );
  });

  it('marks the job failed when the sweep behind the answer fails, so the scheduler resumes it', async () => {
    const deferred = deferredWork();
    const logError = vi.fn();
    const invalidateShowcaseFeedCache = vi.fn();
    const deletion = deletionServiceClient({
      listError: { status: 500, message: 'storage unavailable' },
    });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: recentUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        invalidateShowcaseFeedCache,
        logError,
        now: () => NOW,
        runAfterResponse: deferred.runAfterResponse,
      },
    });

    expect(response.status).toBe(202);
    await deferred.runAll();

    expect(deletion.stages()).toEqual(['storage_deleting', 'failed']);
    expect(deletion.client.rpc).toHaveBeenCalledWith('mark_account_deletion_stage', {
      p_user_id: USER_ID,
      p_status: 'failed',
      p_error_message: 'Could not inspect profiles account files.',
    });
    expect(deletion.client.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith('Account deletion failed:', expect.any(Error));
    // Only the invalidation made when the account was locked: the scheduler's
    // resumed sweep invalidates once it finishes (`backend-job-executions.ts`).
    expect(invalidateShowcaseFeedCache).toHaveBeenCalledOnce();
  });

  it('hands the sweep to the scheduler when the work cannot be deferred', async () => {
    const logError = vi.fn();
    const deletion = deletionServiceClient();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: recentUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        invalidateShowcaseFeedCache: vi.fn(),
        logError,
        now: () => NOW,
        runAfterResponse: () => {
          throw new Error('after() was called outside a request scope');
        },
      },
    });

    // The account is locked and signed out either way; the job is durable.
    expect(response.status).toBe(202);
    expect(deletion.stages()).toEqual(['storage_deleting', 'failed']);
    expect(deletion.client.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith('Account deletion failed:', expect.any(Error));
  });

  it('answers 500 with deletionScheduled false when prepare fails and nothing changed', async () => {
    const deferred = deferredWork();
    const deletion = deletionServiceClient({
      prepare: { data: null, error: { message: 'prepare unavailable' } },
    });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: recentUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        logError: vi.fn(),
        now: () => NOW,
        runAfterResponse: deferred.runAfterResponse,
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Account deletion could not be completed. Please try again.',
      code: 'ACCOUNT_DELETION_NOT_STARTED',
      deletionScheduled: false,
    });
    expect(deletion.client.auth.admin.signOut).not.toHaveBeenCalled();
    expect(deferred.runAfterResponse).not.toHaveBeenCalled();
  });

  it('answers 500 with deletionScheduled true when the global sign-out fails after prepare', async () => {
    const deferred = deferredWork();
    const deletion = deletionServiceClient({
      signOutError: { status: 500, message: 'Auth service unavailable' },
    });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: recentUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        logError: vi.fn(),
        now: () => NOW,
        runAfterResponse: deferred.runAfterResponse,
      },
    });

    // prepare_account_deletion already locked the identity for good, and the
    // failed stage is what the scheduler resumes.
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Your account is being deleted and will be removed automatically.',
      code: 'ACCOUNT_DELETION_RETRY_SCHEDULED',
      deletionScheduled: true,
    });
    expect(deletion.stages()).toEqual(['storage_deleting', 'failed']);
    expect(deletion.client.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(deferred.runAfterResponse).not.toHaveBeenCalled();
  });

  it('answers 500 with deletionScheduled false when the rate limit cannot be checked', async () => {
    const rpc = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: recentUserClient(),
        createServiceClient: (() => ({ rpc })) as never,
        enforceBackendRateLimit: vi.fn(async () => {
          throw new Error('rate limit store unavailable');
        }),
        logError: vi.fn(),
        now: () => NOW,
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 'ACCOUNT_DELETION_NOT_STARTED',
      deletionScheduled: false,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('requires a recent sign-in before preparing destructive deletion work', async () => {
    const rpc = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: (() => ({
          auth: {
            getUser: vi.fn(async () => ({
              data: { user: authenticatedUser('2026-07-14T10:00:00.000Z') },
              error: null,
            })),
          },
        })) as never,
        createServiceClient: (() => ({ rpc })) as never,
        now: () => NOW,
      },
    });

    expect(response.status).toBe(403);
    // The legacy code stays: installed apps open their sign-in card on it.
    await expect(response.json()).resolves.toEqual({
      error: 'Please sign in again before permanently deleting your account.',
      code: 'RECENT_AUTH_REQUIRED',
      reason: 'reauthentication_required',
      reauthenticate: true,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('accepts a fresh Apple deletion authorization for a stale Supabase session', async () => {
    const calls: string[] = [];
    const authorizeAppleAccountDeletion = vi.fn(async () => {
      calls.push('authorize-apple');
    });
    const rpc = vi.fn(async (name: string) => {
      calls.push(`rpc:${name}`);
      if (name !== 'prepare_account_deletion') throw new Error(`Unexpected rpc: ${name}`);
      return { data: { status: 'already_completed', storage_manifest: {} }, error: null };
    });
    const response = await deleteAccountRouteResponse({
      request: request({
        confirmation: 'DELETE',
        appleAuthorizationCode: 'fresh-one-time-apple-code',
      }),
      dependencies: {
        authorizeAppleAccountDeletion,
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: (() => ({
          auth: {
            getUser: vi.fn(async () => ({
              data: {
                user: {
                  ...authenticatedUser('2026-07-14T10:00:00.000Z'),
                  identities: [{ provider: 'apple', provider_id: 'apple-user-1' }],
                },
              },
              error: null,
            })),
          },
        })) as never,
        createServiceClient: (() => ({ rpc })) as never,
        enforceBackendRateLimit: vi.fn(async () => {
          calls.push('rate-limit');
          return {
            allowed: true,
            limit: 3,
            remaining: 2,
            retryAfterSeconds: 0,
            resetAt: new Date().toISOString(),
          };
        }),
        invalidateShowcaseFeedCache: vi.fn(),
        now: () => NOW,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      deleted: true,
    });
    expect(authorizeAppleAccountDeletion).toHaveBeenCalledWith({
      authorizationCode: 'fresh-one-time-apple-code',
      expectedAppleSubject: 'apple-user-1',
    });
    expect(rpc).toHaveBeenCalledWith('prepare_account_deletion', { p_user_id: USER_ID });
    expect(calls).toEqual([
      'rate-limit',
      'authorize-apple',
      'rpc:prepare_account_deletion',
    ]);
  });

  it('reloads provider identity omitted by the proxy assertion before Apple deletion', async () => {
    const authorization = 'Bearer middleware-verified-token';
    const admissionSecret = 'test-identity-admission-secret-at-least-32-bytes';
    vi.stubEnv('IDENTITY_ADMISSION_SECRET', admissionSecret);
    const fullAppleUser = {
      ...authenticatedUser('2026-07-14T10:00:00.000Z'),
      aud: 'authenticated',
      role: 'authenticated',
      email: 'private-relay@example.test',
      phone: '',
      is_anonymous: false,
      app_metadata: { provider: 'apple', providers: ['apple'] },
      user_metadata: {},
      created_at: '2026-07-01T00:00:00.000Z',
      identities: [{
        id: 'apple-user-1',
        provider: 'apple',
        identity_data: { sub: 'apple-user-1' },
      }],
    };
    const assertion = await signIdentityAdmission({
      authorization,
      method: 'DELETE',
      pathname: '/api/account',
      state: 'active',
      user: fullAppleUser as never,
      secret: admissionSecret,
    });
    expect(assertion).toBeTruthy();

    const routeRequest = request({
      confirmation: 'DELETE',
      appleAuthorizationCode: 'fresh-one-time-apple-code',
    }, authorization, {
      'x-magicbooklet-identity-admission': assertion as string,
    });
    const getUser = vi.fn(async () => ({
      data: { user: fullAppleUser },
      error: null,
    }));
    const userClient = { auth: { getUser } };
    const authorizeAppleAccountDeletion = vi.fn();
    const rpc = vi.fn(async (name: string) => {
      if (name !== 'prepare_account_deletion') throw new Error(`Unexpected rpc: ${name}`);
      return { data: { status: 'already_completed', storage_manifest: {} }, error: null };
    });

    const response = await deleteAccountRouteResponse({
      request: routeRequest,
      dependencies: {
        authorizeAppleAccountDeletion,
        createUserClient: ((incomingRequest: Request) => {
          registerIdentityAdmissionContext(userClient, incomingRequest);
          return userClient;
        }) as never,
        createServiceClient: (() => ({ rpc })) as never,
        enforceBackendRateLimit: allowRateLimit(),
        invalidateShowcaseFeedCache: vi.fn(),
        now: () => NOW,
      },
    });

    expect(response.status).toBe(200);
    expect(getUser).toHaveBeenCalledOnce();
    expect(authorizeAppleAccountDeletion).toHaveBeenCalledWith({
      authorizationCode: 'fresh-one-time-apple-code',
      expectedAppleSubject: 'apple-user-1',
    });
  });

  it('requires Apple authorization even while the Supabase session is recent', async () => {
    const authorizeAppleAccountDeletion = vi.fn();
    const rpc = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        authorizeAppleAccountDeletion,
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: (() => ({
          auth: {
            getUser: vi.fn(async () => ({
              data: {
                user: {
                  ...authenticatedUser(),
                  identities: [{
                    provider: 'apple',
                    identity_data: { sub: 'apple-user-1' },
                  }],
                },
              },
              error: null,
            })),
          },
        })) as never,
        createServiceClient: (() => ({ rpc })) as never,
        now: () => NOW,
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Continue with Apple before permanently deleting your account.',
      code: 'APPLE_REAUTH_REQUIRED',
      reason: 'reauthentication_required',
      reauthenticate: true,
    });
    expect(authorizeAppleAccountDeletion).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('asks for a fresh Apple sign-in when Apple refuses the authorization code', async () => {
    const rpc = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({
        confirmation: 'DELETE',
        appleAuthorizationCode: 'expired-apple-code',
      }),
      dependencies: {
        authorizeAppleAccountDeletion: vi.fn(async () => {
          throw new AppleAccountDeletionError(
            'Apple could not verify this deletion request. Continue with Apple again and retry.',
            'APPLE_REAUTH_FAILED',
            403,
            true,
          );
        }),
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: (() => ({
          auth: {
            getUser: vi.fn(async () => ({
              data: {
                user: {
                  ...authenticatedUser(),
                  identities: [{ provider: 'apple', provider_id: 'apple-user-1' }],
                },
              },
              error: null,
            })),
          },
        })) as never,
        createServiceClient: (() => ({ rpc })) as never,
        enforceBackendRateLimit: allowRateLimit(),
        now: () => NOW,
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Apple could not verify this deletion request. Continue with Apple again and retry.',
      code: 'APPLE_REAUTH_FAILED',
      reason: 'reauthentication_required',
      reauthenticate: true,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps the account intact when Apple authorizes a different identity', async () => {
    const rpc = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({
        confirmation: 'DELETE',
        appleAuthorizationCode: 'fresh-one-time-apple-code',
      }),
      dependencies: {
        authorizeAppleAccountDeletion: vi.fn(async () => {
          throw new AppleAccountDeletionError(
            'You continued with a different Apple account. Your Magicbooklet account was not deleted.',
            'ACCOUNT_REAUTH_MISMATCH',
            403,
            false,
          );
        }),
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: (() => ({
          auth: {
            getUser: vi.fn(async () => ({
              data: {
                user: {
                  ...authenticatedUser(),
                  identities: [{ provider: 'apple', provider_id: 'apple-user-1' }],
                },
              },
              error: null,
            })),
          },
        })) as never,
        createServiceClient: (() => ({ rpc })) as never,
        enforceBackendRateLimit: allowRateLimit(),
        now: () => NOW,
      },
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'ACCOUNT_REAUTH_MISMATCH' });
    // Signing in again with the same mismatched account cannot clear this one.
    expect(body).not.toHaveProperty('reason');
    expect(rpc).not.toHaveBeenCalled();
  });

  // The website's Continue with Apple, end to end through the real Apple service with
  // Apple's endpoints faked: any account with an Apple identity, wherever it was made.
  describe('a code from the website’s Continue with Apple', () => {
    const SERVICES_ID = 'com.magicbooklet.mobile.web';
    const appleEnvironment = {
      APPLE_TEAM_ID: 'TEAM123456',
      IOS_BUNDLE_ID: 'com.magicbooklet.mobile',
      NEXT_PUBLIC_APPLE_SERVICES_ID: SERVICES_ID,
      APPLE_SIGN_IN_KEY_ID: 'KEY1234567',
      APPLE_SIGN_IN_PRIVATE_KEY: 'unused-by-test-double',
    };

    function websiteDeletion(identities: unknown[], appleSubject = 'apple-user-1') {
      const appleRequests: Array<{ url: string; body: Record<string, string> }> = [];
      const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        appleRequests.push({ url, body: Object.fromEntries(new URLSearchParams(String(init.body))) });
        return url === APPLE_ACCOUNT_DELETION_ENDPOINTS.token
          ? new Response(JSON.stringify({
              access_token: 'apple-access-token',
              refresh_token: 'apple-refresh-token',
              id_token: 'apple-id-token',
            }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          : new Response(null, { status: 200 });
      });
      const verifyIdentityToken = vi.fn(async () => appleSubject);
      const rpc = vi.fn(async (name: string) => {
        if (name !== 'prepare_account_deletion') throw new Error(`Unexpected rpc: ${name}`);
        return { data: { status: 'already_completed', storage_manifest: {} }, error: null };
      });
      const respond = () => deleteAccountRouteResponse({
        request: request({
          confirmation: 'DELETE',
          appleAuthorizationCode: 'website-one-time-code',
          appleAuthorizationClient: 'web',
        }),
        dependencies: {
          authorizeAppleAccountDeletion: (input) => authorizeAppleAccountDeletion(input, {
            createClientSecret: async ({ clientId }) => `client-secret-for-${clientId}`,
            environment: appleEnvironment,
            fetcher: fetcher as never,
            now: () => NOW,
            verifyIdentityToken,
          }),
          requireIdentity: requireIdentityForRouteTest as never,
          createUserClient: (() => ({
            auth: {
              getUser: vi.fn(async () => ({
                // A stale sign-in: Apple's code is the fresh proof.
                data: { user: { ...authenticatedUser('2026-07-14T10:00:00.000Z'), identities } },
                error: null,
              })),
            },
          })) as never,
          createServiceClient: (() => ({ rpc })) as never,
          enforceBackendRateLimit: allowRateLimit(),
          invalidateShowcaseFeedCache: vi.fn(),
          now: () => NOW,
        },
      });
      return { appleRequests, respond, rpc, verifyIdentityToken };
    }

    it.each([
      ['an account made with Apple on the website', [
        { id: 'apple-user-1', provider: 'apple', identity_data: { sub: 'apple-user-1' } },
      ]],
      ['a Google account that Supabase linked an Apple sign-in to by its email', [
        { id: 'google-user-1', provider: 'google', identity_data: { sub: 'google-user-1' } },
        { id: 'apple-user-1', provider: 'apple', identity_data: { sub: 'apple-user-1' } },
      ]],
    ])('deletes %s, redeeming and revoking the code as the Services ID', async (_label, identities) => {
      const deletion = websiteDeletion(identities);

      const response = await deletion.respond();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ success: true, deleted: true });
      expect(deletion.appleRequests).toEqual([
        {
          url: APPLE_ACCOUNT_DELETION_ENDPOINTS.token,
          body: {
            client_id: SERVICES_ID,
            client_secret: `client-secret-for-${SERVICES_ID}`,
            code: 'website-one-time-code',
            grant_type: 'authorization_code',
            redirect_uri: 'https://magicbooklet.com/delete-account',
          },
        },
        {
          url: APPLE_ACCOUNT_DELETION_ENDPOINTS.revoke,
          body: {
            client_id: SERVICES_ID,
            client_secret: `client-secret-for-${SERVICES_ID}`,
            token: 'apple-refresh-token',
            token_type_hint: 'refresh_token',
          },
        },
      ]);
      expect(deletion.verifyIdentityToken).toHaveBeenCalledWith('apple-id-token', SERVICES_ID);
      expect(deletion.rpc).toHaveBeenCalledWith('prepare_account_deletion', { p_user_id: USER_ID });
    });

    it('keeps a linked Google account when the website code names another Apple user', async () => {
      const deletion = websiteDeletion([
        { id: 'google-user-1', provider: 'google', identity_data: { sub: 'google-user-1' } },
        { id: 'apple-user-1', provider: 'apple', identity_data: { sub: 'apple-user-1' } },
      ], 'apple-user-2');

      const response = await deletion.respond();

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_REAUTH_MISMATCH' });
      // Redeemed to read its user, never revoked.
      expect(deletion.appleRequests.map(({ url }) => url)).toEqual([APPLE_ACCOUNT_DELETION_ENDPOINTS.token]);
      expect(deletion.rpc).not.toHaveBeenCalled();
    });
  });

  // Installed apps name no client; the website names its own. Any other name is refused before
  // Apple is asked, so no code is spent on a client the server would redeem it as by mistake.
  it("redeems a code as the app's native client unless the request names the website, and refuses other names", async () => {
    const authorizeAppleAccountDeletion = vi.fn();
    const logError = vi.fn();
    const respond = (body: Record<string, unknown>) => deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE', appleAuthorizationCode: 'fresh-one-time-apple-code', ...body }),
      dependencies: {
        authorizeAppleAccountDeletion,
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: (() => ({
          auth: {
            getUser: vi.fn(async () => ({
              data: { user: { ...authenticatedUser(), identities: [{ provider: 'apple', provider_id: 'apple-user-1' }] } },
              error: null,
            })),
          },
        })) as never,
        createServiceClient: (() => ({
          rpc: vi.fn(async () => ({ data: { status: 'already_completed', storage_manifest: {} }, error: null })),
        })) as never,
        enforceBackendRateLimit: allowRateLimit(),
        invalidateShowcaseFeedCache: vi.fn(),
        logError,
        now: () => NOW,
      },
    });

    expect((await respond({})).status).toBe(200);
    expect((await respond({ appleAuthorizationClient: 'native' })).status).toBe(200);
    expect((await respond({ appleAuthorizationClient: 'web' })).status).toBe(200);
    const refused = await respond({ appleAuthorizationClient: 'android' });

    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toEqual({ error: 'Unknown Apple client for this deletion request.' });
    expect(authorizeAppleAccountDeletion.mock.calls.map(([input]) => input.client)).toEqual([undefined, undefined, 'web']);
    expect(logError).not.toHaveBeenCalled();
  });

  // A website failure while the app's work is the Services ID's setup: the log says which client,
  // and what Apple or the configuration refused, never the code.
  it("logs which client Apple's failure came from, and what failed", async () => {
    const logError = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({
        confirmation: 'DELETE',
        appleAuthorizationCode: 'website-one-time-code',
        appleAuthorizationClient: 'web',
      }),
      dependencies: {
        authorizeAppleAccountDeletion: vi.fn(async () => {
          throw new AppleAccountDeletionError(
            'Apple account verification is temporarily unavailable. Your account is still active; please try again later.',
            'APPLE_REVOCATION_UNAVAILABLE',
            503,
            false,
            'token endpoint 400 invalid_client',
          );
        }),
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: (() => ({
          auth: {
            getUser: vi.fn(async () => ({
              data: { user: { ...authenticatedUser(), identities: [{ provider: 'apple', provider_id: 'apple-user-1' }] } },
              error: null,
            })),
          },
        })) as never,
        createServiceClient: (() => ({ rpc: vi.fn() })) as never,
        enforceBackendRateLimit: allowRateLimit(),
        logError,
        now: () => NOW,
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Apple account verification is temporarily unavailable. Your account is still active; please try again later.',
      code: 'APPLE_REVOCATION_UNAVAILABLE',
    });
    expect(logError).toHaveBeenCalledWith(
      'Apple account deletion authorization failed (web: token endpoint 400 invalid_client):',
      expect.any(AppleAccountDeletionError),
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain('website-one-time-code');
  });

  const appleUserClient = () => (() => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { ...authenticatedUser(), identities: [{ provider: 'apple', provider_id: 'apple-user-1' }] } },
        error: null,
      })),
    },
  })) as never;

  // The website asks Apple for a fresh code only when this one is no use: a refusal after
  // Apple took it says so, since sending it again would only spend one of the hour's attempts.
  it.each([
    ['after Apple took the code', true],
    ['before Apple took the code', false],
  ])("says whether Apple's code is spent when Apple fails %s", async (_label, codeSpent) => {
    const response = await deleteAccountRouteResponse({
      request: request({
        confirmation: 'DELETE',
        appleAuthorizationCode: 'website-one-time-code',
        appleAuthorizationClient: 'web',
      }),
      dependencies: {
        authorizeAppleAccountDeletion: vi.fn(async () => {
          throw new AppleAccountDeletionError(
            'Apple account verification is temporarily unavailable. Your account is still active; please try again later.',
            'APPLE_REVOCATION_UNAVAILABLE',
            503,
            false,
            codeSpent ? 'revoke endpoint 500' : 'token endpoint 502',
            codeSpent,
          );
        }),
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: appleUserClient(),
        createServiceClient: (() => ({ rpc: vi.fn() })) as never,
        enforceBackendRateLimit: allowRateLimit(),
        logError: vi.fn(),
        now: () => NOW,
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Apple account verification is temporarily unavailable. Your account is still active; please try again later.',
      code: 'APPLE_REVOCATION_UNAVAILABLE',
      ...(codeSpent ? { appleCodeSpent: true } : {}),
    });
  });

  // A refusal that sends the person back to Apple is logged too: a Services ID whose
  // tokens never verify would otherwise loop people through Apple without a trace.
  it('logs a refusal that sends the person back to Apple, with what failed', async () => {
    const logError = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({
        confirmation: 'DELETE',
        appleAuthorizationCode: 'website-one-time-code',
        appleAuthorizationClient: 'web',
      }),
      dependencies: {
        authorizeAppleAccountDeletion: vi.fn(async () => {
          throw new AppleAccountDeletionError(
            'Apple could not verify this deletion request. Continue with Apple again and retry.',
            'APPLE_REAUTH_FAILED',
            403,
            true,
            'id token unverifiable (ERR_JWS_SIGNATURE_VERIFICATION_FAILED)',
            true,
          );
        }),
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: appleUserClient(),
        createServiceClient: (() => ({ rpc: vi.fn() })) as never,
        enforceBackendRateLimit: allowRateLimit(),
        logError,
        now: () => NOW,
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Apple could not verify this deletion request. Continue with Apple again and retry.',
      code: 'APPLE_REAUTH_FAILED',
      reason: 'reauthentication_required',
      reauthenticate: true,
      appleCodeSpent: true,
    });
    expect(logError).toHaveBeenCalledWith(
      'Apple account deletion authorization failed (web: id token unverifiable (ERR_JWS_SIGNATURE_VERIFICATION_FAILED)):',
      expect.any(AppleAccountDeletionError),
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain('website-one-time-code');
  });

  // Apple's step went through, so its authorization is already revoked: a retry needs a new code.
  it('says the Apple code is spent when the deletion does not start after Apple', async () => {
    const deletion = deletionServiceClient({
      prepare: { data: null, error: { message: 'prepare unavailable' } },
    });
    const response = await deleteAccountRouteResponse({
      request: request({
        confirmation: 'DELETE',
        appleAuthorizationCode: 'website-one-time-code',
        appleAuthorizationClient: 'web',
      }),
      dependencies: {
        authorizeAppleAccountDeletion: vi.fn(async () => undefined),
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: appleUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        logError: vi.fn(),
        now: () => NOW,
        runAfterResponse: deferredWork().runAfterResponse,
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Account deletion could not be completed. Please try again.',
      code: 'ACCOUNT_DELETION_NOT_STARTED',
      deletionScheduled: false,
      appleCodeSpent: true,
    });
  });

  it('answers 200 deleted only for a deletion that had already completed', async () => {
    const deferred = deferredWork();
    const invalidateShowcaseFeedCache = vi.fn();
    const deletion = deletionServiceClient({
      prepare: { data: { status: 'already_completed', storage_manifest: {} }, error: null },
    });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: recentUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        invalidateShowcaseFeedCache,
        now: () => NOW,
        runAfterResponse: deferred.runAfterResponse,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      deleted: true,
      cleanupPending: false,
      alreadyDeleted: true,
    });
    expect(deletion.calls).toEqual(['rpc:prepare_account_deletion:']);
    expect(deferred.runAfterResponse).not.toHaveBeenCalled();
    expect(invalidateShowcaseFeedCache).toHaveBeenCalledOnce();
  });

  it('invalidates the feed behind the answer when auth deletion reports the user is already missing', async () => {
    const deferred = deferredWork();
    const invalidateShowcaseFeedCache = vi.fn();
    const deletion = deletionServiceClient({
      deleteUserError: { status: 404, message: 'User not found' },
    });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: recentUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        invalidateShowcaseFeedCache,
        now: () => NOW,
        runAfterResponse: deferred.runAfterResponse,
      },
    });

    expect(response.status).toBe(202);
    await deferred.runAll();

    expect(deletion.client.auth.admin.deleteUser).toHaveBeenCalledWith(USER_ID);
    expect(deletion.stages()).toEqual([
      'storage_deleting',
      'storage_deleted',
      'auth_deleting',
      'completed',
    ]);
    // Once as the account was locked, once after the sweep.
    expect(invalidateShowcaseFeedCache).toHaveBeenCalledTimes(2);
  });

  it('rate limits repeated permanent deletion attempts before changing account data', async () => {
    const deleteUser = vi.fn();
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: recentUserClient(),
        createServiceClient: (() => ({ auth: { admin: { deleteUser } } })) as never,
        enforceBackendRateLimit: vi.fn(async () => {
          throw new BackendRateLimitError({
            allowed: false,
            limit: 3,
            remaining: 0,
            retryAfterSeconds: 60,
            resetAt,
          });
        }),
        now: () => NOW,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(deleteUser).not.toHaveBeenCalled();
  });
});

// D5 (2026-10-15): a guest deletes its own data through the same route.
describe('guest self-deletion', () => {
  const GUEST_ID = '0b5d0c3e-6f1a-4c2b-9d7e-3a1f2e4d5c6b';
  // Months old: an account this stale would be sent to sign in again.
  const guestUser = {
    id: GUEST_ID,
    is_anonymous: true,
    last_sign_in_at: '2026-03-01T00:00:00.000Z',
    identities: [],
  };

  function guestUserClient() {
    return (() => ({
      auth: { getUser: vi.fn(async () => ({ data: { user: guestUser }, error: null })) },
    })) as never;
  }

  it('deletes a guest with no fresh sign-in, through the guest guard and then the account pipeline', async () => {
    const deferred = deferredWork();
    const invalidateShowcaseFeedCache = vi.fn();
    const authorizeAppleAccountDeletion = vi.fn();
    const deletion = deletionServiceClient({
      ownerUserIds: [GUEST_ID],
      authUser: { id: GUEST_ID, is_anonymous: true, email: null, identities: [] },
    });
    const response = await deleteAccountRouteResponse({
      // The body the app sends today.
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        authorizeAppleAccountDeletion,
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: guestUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        invalidateShowcaseFeedCache,
        now: () => NOW,
        runAfterResponse: deferred.runAfterResponse,
      },
    });

    // The same answer an account gets.
    expect(response.status).toBe(202);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      success: true,
      deleted: false,
      deletionScheduled: true,
    });
    expect(deletion.client.rpc).toHaveBeenCalledWith('prepare_guest_account_deletion', {
      p_user_id: GUEST_ID,
    });
    expect(deletion.client.rpc).not.toHaveBeenCalledWith('prepare_account_deletion', expect.anything());
    expect(deletion.calls).toEqual([
      'rpc:prepare_guest_account_deletion:',
      'rpc:mark_account_deletion_stage:storage_deleting',
      'sign-out:global',
    ]);
    expect(deletion.client.auth.admin.signOut).toHaveBeenCalledWith('token', 'global');
    expect(authorizeAppleAccountDeletion).not.toHaveBeenCalled();

    await deferred.runAll();

    expect(deletion.stages()).toEqual([
      'storage_deleting',
      'storage_deleted',
      'auth_deleting',
      'completed',
    ]);
    // Its own files, under its own id, then the guest itself.
    expect(deletion.calls).toContain(`list:uploads:${GUEST_ID}`);
    expect(deletion.calls).toContain(`list:generated_images:${GUEST_ID}`);
    expect(deletion.calls).toContain(`list:generation_inputs:${GUEST_ID}`);
    expect(deletion.client.auth.admin.deleteUser).toHaveBeenCalledTimes(1);
    expect(deletion.client.auth.admin.deleteUser).toHaveBeenCalledWith(GUEST_ID);
    // A guest has no sign-in to come back with: no identity digest is kept.
    expect(deletion.deletedIdentityRecords).toEqual([]);
    // Once as the guest was locked, once after the sweep.
    expect(invalidateShowcaseFeedCache).toHaveBeenCalledTimes(2);
  });

  it('never asks a guest for Apple, even when a code arrives with the request', async () => {
    const authorizeAppleAccountDeletion = vi.fn();
    const deletion = deletionServiceClient({ ownerUserIds: [GUEST_ID] });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE', appleAuthorizationCode: 'stray-code' }),
      dependencies: {
        authorizeAppleAccountDeletion,
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: guestUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        invalidateShowcaseFeedCache: vi.fn(),
        now: () => NOW,
        runAfterResponse: vi.fn(),
      },
    });

    expect(response.status).toBe(202);
    expect(authorizeAppleAccountDeletion).not.toHaveBeenCalled();
  });

  it('still asks a guest to type DELETE', async () => {
    const deletion = deletionServiceClient({ ownerUserIds: [GUEST_ID] });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'delete' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: guestUserClient(),
        createServiceClient: (() => deletion.client) as never,
        now: () => NOW,
      },
    });

    expect(response.status).toBe(400);
    expect(deletion.client.rpc).not.toHaveBeenCalled();
  });

  it('refuses a guest linked to an account with SESSION_MERGED and changes nothing', async () => {
    const deferred = deferredWork();
    const logError = vi.fn();
    const deletion = deletionServiceClient({
      prepare: { data: { status: 'merged' }, error: null },
    });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: guestUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        invalidateShowcaseFeedCache: vi.fn(),
        logError,
        now: () => NOW,
        runAfterResponse: deferred.runAfterResponse,
      },
    });

    // What identity admission answers a linked guest's session, so the app
    // leaves it the way it already does.
    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      error: 'This guest session has been linked to an account. Sign in to continue.',
      code: 'SESSION_MERGED',
    });
    // Refused inside the guard: no stage, no sign-out, no sweep, no failed job.
    expect(deletion.calls).toEqual(['rpc:prepare_guest_account_deletion:']);
    expect(deletion.client.auth.admin.signOut).not.toHaveBeenCalled();
    expect(deletion.client.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(deferred.runAfterResponse).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('refuses a linked guest at identity admission, before any deletion work', async () => {
    const rpc = vi.fn();
    const maybeSingle = vi.fn(async () => ({ data: { identity_state: 'merged' }, error: null }));
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        // The real admission check, reading the identity's lifecycle state.
        createUserClient: guestUserClient(),
        createServiceClient: (() => ({ from: vi.fn(() => query), rpc })) as never,
        now: () => NOW,
      },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_MERGED' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('tells a guest the guard no longer sees as one to try again, with nothing started', async () => {
    const deletion = deletionServiceClient({
      prepare: { data: { status: 'not_a_guest' }, error: null },
    });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: guestUserClient(),
        createServiceClient: (() => deletion.client) as never,
        enforceBackendRateLimit: allowRateLimit(),
        logError: vi.fn(),
        now: () => NOW,
        runAfterResponse: vi.fn(),
      },
    });

    // A retry is asked again from the identity it then has: an account is
    // sent to sign in again like any other.
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Account deletion could not be completed. Please try again.',
      code: 'ACCOUNT_DELETION_NOT_STARTED',
      deletionScheduled: false,
    });
    expect(deletion.client.auth.admin.signOut).not.toHaveBeenCalled();
  });

  it('keeps an account on its own rules: the account guard, and a fresh sign-in', async () => {
    const deletion = deletionServiceClient();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        requireIdentity: requireIdentityForRouteTest as never,
        createUserClient: (() => ({
          auth: {
            getUser: vi.fn(async () => ({
              data: { user: { ...authenticatedUser('2026-07-14T10:00:00.000Z'), is_anonymous: false } },
              error: null,
            })),
          },
        })) as never,
        createServiceClient: (() => deletion.client) as never,
        now: () => NOW,
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'RECENT_AUTH_REQUIRED' });
    expect(deletion.client.rpc).not.toHaveBeenCalled();
  });
});
