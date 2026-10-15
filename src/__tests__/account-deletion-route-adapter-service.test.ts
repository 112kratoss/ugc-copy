import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { deleteAccountRouteResponse } from '@/lib/account-deletion-route-adapter-service';
import { AppleAccountDeletionError } from '@/lib/apple-account-deletion-service';
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
      throw new Error(`Unexpected table: ${table}`);
    }),
    auth: {
      admin: {
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
  return { calls, client, removed, stages, walletRecords };
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
    expect(invalidateShowcaseFeedCache).not.toHaveBeenCalled();

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
    expect(invalidateShowcaseFeedCache).toHaveBeenCalledOnce();
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
    expect(invalidateShowcaseFeedCache).not.toHaveBeenCalled();
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
    expect(invalidateShowcaseFeedCache).toHaveBeenCalledOnce();
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
    const deletion = deletionServiceClient({ ownerUserIds: [GUEST_ID] });
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
    expect(invalidateShowcaseFeedCache).toHaveBeenCalledOnce();
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
