import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { deleteAccountRouteResponse } from '@/lib/account-deletion-route-adapter-service';

function request(body: unknown, authorization = 'Bearer token') {
  return new Request('https://magicbooklet.test/api/account', {
    method: 'DELETE',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const RECENT_SIGN_IN = '2026-07-14T12:00:00.000Z';
const NOW = new Date('2026-07-14T12:05:00.000Z');

function authenticatedUser(lastSignInAt = RECENT_SIGN_IN) {
  return { id: 'user-1', last_sign_in_at: lastSignInAt };
}

describe('account deletion route', () => {
  it('requires an authenticated user', async () => {
    const deleteUser = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: new Error('invalid') })) },
        })) as never,
        createServiceClient: (() => ({ auth: { admin: { deleteUser } } })) as never,
      },
    });

    expect(response.status).toBe(401);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('requires an explicit permanent deletion confirmation', async () => {
    const deleteUser = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'delete' }),
      dependencies: {
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
        })) as never,
        createServiceClient: (() => ({ auth: { admin: { deleteUser } } })) as never,
      },
    });

    expect(response.status).toBe(400);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('removes user-prefixed storage before deleting the auth account', async () => {
    const calls: string[] = [];
    const removed: Array<{ bucket: string; paths: string[] }> = [];
    const invalidateShowcaseFeedCache = vi.fn();
    const signOut = vi.fn(async () => ({ data: null, error: null }));
    const deleteUser = vi.fn(async (userId: string) => {
      calls.push(`delete:${userId}`);
      return { data: null, error: null };
    });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: authenticatedUser() }, error: null })) },
        })) as never,
        createServiceClient: (() => ({
          auth: { admin: { deleteUser, signOut } },
          rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
            calls.push(`rpc:${name}:${String(args.p_status ?? '')}`);
            if (name === 'prepare_account_deletion') {
              return {
                data: {
                  status: 'prepared',
                  storage_manifest: {
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
                    showcase_media_paths: ['showcase/gen-1/output.webp'],
                    template_asset_prefixes: ['2b2f4bb5-6ea8-4c44-a394-14cc777dcf52'],
                  },
                },
                error: null,
              };
            }
            if (name === 'list_creator_purchased_revisions_for_retention') {
              return { data: [], error: null };
            }
            return { data: { status: args.p_status }, error: null };
          }),
          storage: {
            from: (bucket: string) => ({
              list: vi.fn(async (prefix: string) => {
                calls.push(`list:${bucket}:${prefix}`);
                return { data: [], error: null };
              }),
              remove: vi.fn(async (paths: string[]) => {
                calls.push(`remove:${bucket}`);
                removed.push({ bucket, paths });
                return { data: [], error: null };
              }),
            }),
          },
        })) as never,
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 3,
          remaining: 2,
          retryAfterSeconds: 0,
          resetAt: new Date().toISOString(),
        })),
        invalidateShowcaseFeedCache,
        now: () => NOW,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      deleted: true,
      cleanupPending: true,
    });
    expect(calls.indexOf('delete:user-1')).toBeLessThan(calls.indexOf('rpc:mark_account_deletion_stage:completed'));
    expect(deleteUser).toHaveBeenCalledWith('user-1');
    expect(signOut).toHaveBeenCalledWith('token', 'global');
    expect(calls.filter((call) => call.startsWith('rpc:mark_account_deletion_stage:'))).toEqual([
      'rpc:mark_account_deletion_stage:storage_deleting',
      'rpc:mark_account_deletion_stage:storage_deleted',
      'rpc:mark_account_deletion_stage:auth_deleting',
      'rpc:mark_account_deletion_stage:completed',
    ]);
    expect(removed).toContainEqual({
      bucket: 'showcase_media',
      paths: ['showcase/gen-1/output.webp'],
    });
    expect(calls).toContain('list:template_assets:2b2f4bb5-6ea8-4c44-a394-14cc777dcf52');
    expect(invalidateShowcaseFeedCache).toHaveBeenCalledOnce();
  });

  it('requires a recent sign-in before preparing destructive deletion work', async () => {
    const rpc = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
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
    await expect(response.json()).resolves.toMatchObject({
      code: 'RECENT_AUTH_REQUIRED',
      reauthenticate: true,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('treats a durably completed concurrent deletion as idempotent success', async () => {
    const deleteUser = vi.fn();
    const invalidateShowcaseFeedCache = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: authenticatedUser() }, error: null })) },
        })) as never,
        createServiceClient: (() => ({
          auth: { admin: { deleteUser } },
          rpc: vi.fn(async (name: string) => {
            if (name !== 'prepare_account_deletion') throw new Error(`Unexpected rpc: ${name}`);
            return { data: { status: 'already_completed', storage_manifest: {} }, error: null };
          }),
        })) as never,
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 3,
          remaining: 2,
          retryAfterSeconds: 0,
          resetAt: new Date().toISOString(),
        })),
        invalidateShowcaseFeedCache,
        now: () => NOW,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      deleted: true,
      cleanupPending: false,
      alreadyDeleted: true,
    });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(invalidateShowcaseFeedCache).toHaveBeenCalledOnce();
  });

  it('invalidates the feed when auth deletion reports the user is already missing', async () => {
    const invalidateShowcaseFeedCache = vi.fn();
    const deleteUser = vi.fn(async () => ({
      data: null,
      error: { status: 404, message: 'User not found' },
    }));
    const signOut = vi.fn(async () => ({ data: null, error: null }));
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: authenticatedUser() }, error: null })) },
        })) as never,
        createServiceClient: (() => ({
          auth: { admin: { deleteUser, signOut } },
          rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
            if (name === 'prepare_account_deletion') {
              return {
                data: {
                  status: 'prepared',
                  storage_manifest: {
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
                    showcase_media_paths: [],
                    template_asset_prefixes: [],
                  },
                },
                error: null,
              };
            }
            if (name === 'list_creator_purchased_revisions_for_retention') {
              return { data: [], error: null };
            }
            return { data: { status: args.p_status }, error: null };
          }),
          storage: {
            from: () => ({
              list: vi.fn(async () => ({ data: [], error: null })),
              remove: vi.fn(async () => ({ data: [], error: null })),
            }),
          },
        })) as never,
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 3,
          remaining: 2,
          retryAfterSeconds: 0,
          resetAt: new Date().toISOString(),
        })),
        invalidateShowcaseFeedCache,
        now: () => NOW,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      deleted: true,
      cleanupPending: true,
    });
    expect(deleteUser).toHaveBeenCalledWith('user-1');
    expect(invalidateShowcaseFeedCache).toHaveBeenCalledOnce();
  });

  it('persists a retryable failure when global session revocation fails', async () => {
    const deleteUser = vi.fn();
    const stages: string[] = [];
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: authenticatedUser() }, error: null })) },
        })) as never,
        createServiceClient: (() => ({
          auth: {
            admin: {
              deleteUser,
              signOut: vi.fn(async () => ({
                data: null,
                error: { status: 500, message: 'Auth service unavailable' },
              })),
            },
          },
          rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
            if (name === 'prepare_account_deletion') {
              return {
                data: {
                  status: 'prepared',
                  storage_manifest: {
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
                    showcase_media_paths: [],
                    template_asset_prefixes: [],
                  },
                },
                error: null,
              };
            }
            stages.push(String(args.p_status));
            return { data: { status: args.p_status }, error: null };
          }),
        })) as never,
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 3,
          remaining: 2,
          retryAfterSeconds: 0,
          resetAt: new Date().toISOString(),
        })),
        logError: vi.fn(),
        now: () => NOW,
      },
    });

    expect(response.status).toBe(500);
    expect(stages).toEqual(['storage_deleting', 'failed']);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('rate limits repeated permanent deletion attempts before changing account data', async () => {
    const deleteUser = vi.fn();
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: authenticatedUser() }, error: null })) },
        })) as never,
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
