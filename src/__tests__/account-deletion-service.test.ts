import { describe, expect, it, vi } from 'vitest';

import {
  executeInitialAccountDeletion,
  hasDueAccountDeletionInitialRetries,
  parseAccountDeletionStorageManifest,
  processAccountDeletionCleanup,
  processAccountDeletionInitialRetries,
  processAccountDeletionResweeps,
} from '@/lib/account-deletion-service';

const USER_ID = '87c4b811-7a50-4e1a-9c38-7ab2693c1182';
const LEASE_TOKEN = '4892f4fe-967b-4d70-8994-e36e4146ac63';

const storageManifest = {
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
  showcase_media_paths: ['showcase/generation-1/output.webp'],
  template_asset_prefixes: ['2b2f4bb5-6ea8-4c44-a394-14cc777dcf52'],
};

function storageMock(options: {
  listError?: unknown;
  listFiles?: Record<string, Array<{ id?: string; name: string; metadata?: unknown }>>;
} = {}) {
  const removed: Array<{ bucket: string; paths: string[] }> = [];
  return {
    removed,
    storage: {
      from: (bucket: string) => ({
        list: vi.fn(async (prefix: string) => ({
          data: options.listFiles?.[`${bucket}:${prefix}`] ?? [],
          error: options.listError ?? null,
        })),
        remove: vi.fn(async (paths: string[]) => {
          removed.push({ bucket, paths });
          return { data: [], error: null };
        }),
      }),
    },
  };
}

describe('account deletion cleanup service', () => {
  it('rejects unsafe or incomplete persisted storage manifests', () => {
    expect(parseAccountDeletionStorageManifest(storageManifest)).toMatchObject({
      userPrefixBuckets: expect.arrayContaining(['profiles', 'generated_videos']),
      showcaseMediaPaths: ['showcase/generation-1/output.webp'],
    });
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      user_prefix_buckets: ['uploads'],
    })).toBeNull();
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      showcase_media_paths: ['../another-user/private.webp'],
    })).toBeNull();
  });

  it('runs the immediate idempotent sweep, deletes Auth, and leaves durable resweep pending', async () => {
    const calls: string[] = [];
    const mockStorage = storageMock();
    const admin = {
      storage: mockStorage.storage,
      auth: {
        admin: {
          deleteUser: vi.fn(async (userId: string) => {
            calls.push(`delete:${userId}`);
            return { data: null, error: null };
          }),
        },
      },
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push(`${name}:${String(args.p_status ?? '')}`);
        if (name === 'prepare_account_deletion') {
          return {
            data: { status: 'prepared', storage_manifest: storageManifest },
            error: null,
          };
        }
        if (name === 'mark_account_deletion_stage' && args.p_status === 'completed') {
          return { data: { status: 'resweep_pending' }, error: null };
        }
        return { data: { status: args.p_status }, error: null };
      }),
    };

    await expect(executeInitialAccountDeletion({
      admin: admin as never,
      userId: USER_ID,
    })).resolves.toMatchObject({
      alreadyCompleted: false,
      authUserAlreadyMissing: false,
      cleanupPending: true,
    });
    expect(calls).toEqual([
      'prepare_account_deletion:',
      'mark_account_deletion_stage:storage_deleting',
      'mark_account_deletion_stage:storage_deleted',
      'mark_account_deletion_stage:auth_deleting',
      `delete:${USER_ID}`,
      'mark_account_deletion_stage:completed',
    ]);
  });

  it('only treats stale or failed initial jobs with an available lease as due', async () => {
    const builder = {
      select: vi.fn(),
      in: vi.fn(),
      lte: vi.fn(),
      or: vi.fn(),
      limit: vi.fn(),
      then: (
        onFulfilled: (result: { data: Array<{ user_id: string }>; error: null }) => unknown,
      ) => Promise.resolve({ data: [{ user_id: USER_ID }], error: null }).then(onFulfilled),
    };
    builder.select.mockReturnValue(builder);
    builder.in.mockReturnValue(builder);
    builder.lte.mockReturnValue(builder);
    builder.or.mockReturnValue(builder);
    builder.limit.mockReturnValue(builder);
    const admin = { from: vi.fn(() => builder) };
    const now = new Date('2026-07-26T12:00:00.000Z');

    await expect(hasDueAccountDeletionInitialRetries(
      admin as never,
      now,
    )).resolves.toBe(true);
    expect(builder.or).toHaveBeenNthCalledWith(
      1,
      'status.eq.failed,updated_at.lte.2026-07-26T11:58:00.000Z',
    );
    expect(builder.or).toHaveBeenNthCalledWith(
      2,
      'lease_token.is.null,lease_expires_at.is.null,lease_expires_at.lte.2026-07-26T12:00:00.000Z',
    );
  });

  it('resumes a failed initial deletion from its claimed stage and schedules the delayed sweep', async () => {
    const mockStorage = storageMock();
    let claims = 0;
    const transitions: string[] = [];
    const deleteUser = vi.fn(async () => ({ data: null, error: null }));
    const admin = {
      storage: mockStorage.storage,
      auth: { admin: { deleteUser } },
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'claim_account_deletion_initial') {
          claims += 1;
          return claims === 1
            ? {
                data: {
                  status: 'claimed',
                  job_status: 'storage_deleting',
                  user_id: USER_ID,
                  lease_token: LEASE_TOKEN,
                  storage_manifest: storageManifest,
                },
                error: null,
              }
            : { data: { status: 'no_work' }, error: null };
        }
        if (name === 'transition_account_deletion_initial') {
          transitions.push(String(args.p_status));
          return {
            data: {
              status: args.p_status === 'resweep_waiting'
                ? 'resweep_pending'
                : args.p_status,
            },
            error: null,
          };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    await expect(processAccountDeletionInitialRetries({
      admin: admin as never,
      workerId: 'account-deletion-worker:test',
    })).resolves.toEqual({
      claimed: 1,
      storageSwept: 1,
      resweepScheduled: 1,
      alreadyCompleted: 0,
      retryScheduled: 0,
      transitionConflicts: 0,
      objectsRemoved: 1,
    });
    expect(deleteUser).toHaveBeenCalledWith(USER_ID);
    expect(transitions).toEqual([
      'storage_deleted',
      'auth_deleting',
      'resweep_waiting',
    ]);
  });

  it('durably reschedules failed initial cleanup and fails the managed batch for alerting', async () => {
    let claims = 0;
    const admin = {
      storage: storageMock({ listError: new Error('storage unavailable') }).storage,
      auth: { admin: { deleteUser: vi.fn() } },
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'claim_account_deletion_initial') {
          claims += 1;
          return claims === 1
            ? {
                data: {
                  status: 'claimed',
                  job_status: 'storage_deleting',
                  user_id: USER_ID,
                  lease_token: LEASE_TOKEN,
                  storage_manifest: storageManifest,
                },
                error: null,
              }
            : { data: { status: 'no_work' }, error: null };
        }
        if (name === 'transition_account_deletion_initial') {
          expect(args.p_status).toBe('failed');
          return { data: { status: 'retry_scheduled' }, error: null };
        }
        if (name === 'claim_account_deletion_resweep') {
          return { data: { status: 'no_work' }, error: null };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    await expect(processAccountDeletionCleanup({
      admin: admin as never,
      workerId: 'account-deletion-worker:test',
    })).rejects.toThrow('1 retry scheduled');
  });

  it('reclaims a delayed resweep, deletes files created by old upload tokens, and finalizes it', async () => {
    const mockStorage = storageMock({
      listFiles: {
        [`uploads:${USER_ID}`]: [{ id: 'late-file', name: 'late-upload.png' }],
      },
    });
    let claims = 0;
    const finalize = vi.fn(async (args: Record<string, unknown>) => {
      void args;
      return { data: { status: 'completed' }, error: null };
    });
    const admin = {
      storage: mockStorage.storage,
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'claim_account_deletion_resweep') {
          claims += 1;
          return claims === 1
            ? {
                data: {
                  status: 'claimed',
                  user_id: USER_ID,
                  lease_token: LEASE_TOKEN,
                  storage_manifest: storageManifest,
                },
                error: null,
              }
            : { data: { status: 'no_work' }, error: null };
        }
        if (name === 'finalize_account_deletion_resweep') {
          return finalize(args);
        }
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    await expect(processAccountDeletionResweeps({
      admin: admin as never,
      workerId: 'account-deletion-worker:test',
    })).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
      retryScheduled: 0,
      objectsRemoved: 2,
    });
    expect(mockStorage.removed).toContainEqual({
      bucket: 'uploads',
      paths: [`${USER_ID}/late-upload.png`],
    });
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
      p_user_id: USER_ID,
      p_lease_token: LEASE_TOKEN,
      p_succeeded: true,
    }));
  });

  it('releases a failed resweep lease into a durable retry', async () => {
    let claims = 0;
    const finalize = vi.fn(async (args: Record<string, unknown>) => {
      void args;
      return { data: { status: 'retry_scheduled' }, error: null };
    });
    const admin = {
      storage: storageMock({ listError: new Error('storage unavailable') }).storage,
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'claim_account_deletion_resweep') {
          claims += 1;
          return claims === 1
            ? {
                data: {
                  status: 'claimed',
                  user_id: USER_ID,
                  lease_token: LEASE_TOKEN,
                  storage_manifest: storageManifest,
                },
                error: null,
              }
            : { data: { status: 'no_work' }, error: null };
        }
        if (name === 'finalize_account_deletion_resweep') return finalize(args);
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    await expect(processAccountDeletionResweeps({
      admin: admin as never,
      workerId: 'account-deletion-worker:test',
    })).resolves.toMatchObject({
      claimed: 1,
      completed: 0,
      retryScheduled: 1,
    });
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
      p_succeeded: false,
      p_error_message: 'Could not inspect profiles account files.',
    }));
  });
});
