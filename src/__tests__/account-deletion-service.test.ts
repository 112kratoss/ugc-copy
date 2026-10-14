import { describe, expect, it, vi } from 'vitest';

import {
  AccountDeletionNotStartedError,
  executeInitialAccountDeletion,
  hasDueAccountDeletionInitialRetries,
  parseAccountDeletionStorageManifest,
  processAccountDeletionCleanup,
  processAccountDeletionInitialRetries,
  processAccountDeletionResweeps,
  recordAccountDeletionWalletBalances,
  removeAccountStorage,
  startInitialAccountDeletion,
} from '@/lib/account-deletion-service';

const USER_ID = '87c4b811-7a50-4e1a-9c38-7ab2693c1182';
const GUEST_ID = '99f5ee80-66c9-4c85-8ada-fcd6d02ef4c1';
const LEASE_TOKEN = '4892f4fe-967b-4d70-8994-e36e4146ac63';
const GENERATION_ID = '80000000-0000-4000-8000-000000000008';

const storageManifest = {
  owner_user_ids: [USER_ID],
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
  showcase_media_paths: [`showcase/${GENERATION_ID}/output.webp`],
  template_asset_prefixes: ['2b2f4bb5-6ea8-4c44-a394-14cc777dcf52'],
};

function storageV2Page(
  prefix: string,
  entries: Array<{ id: string; name: string }>,
) {
  return {
    data: {
      hasNext: false,
      folders: [],
      objects: entries.map((entry) => ({
        ...entry,
        key: `${prefix}/${entry.name}`,
        created_at: '2026-08-22T00:00:00.000Z',
        updated_at: '2026-08-22T00:00:00.000Z',
        metadata: {},
      })),
    },
    error: null,
  };
}

function storageMock(options: {
  listError?: unknown;
  listFiles?: Record<string, Array<{ id?: string; name: string; metadata?: unknown }>>;
  onList?: (bucket: string, prefix: string) => void;
  onRemove?: (bucket: string, paths: string[]) => void;
} = {}) {
  const removed: Array<{ bucket: string; paths: string[] }> = [];
  const removedPaths = new Set<string>();
  return {
    removed,
    storage: {
      from: (bucket: string) => ({
        listV2: vi.fn(async (listOptions: { prefix?: string }) => {
          const prefix = (listOptions.prefix ?? '').replace(/\/$/u, '');
          options.onList?.(bucket, prefix);
          const objects = (options.listFiles?.[`${bucket}:${prefix}`] ?? []).filter(
            (entry) => !removedPaths.has(`${bucket}:${prefix}/${entry.name}`),
          );
          return {
            data: {
              hasNext: false,
              folders: [],
              objects: objects.map((entry, index) => ({
                id: entry.id ?? `object-${index}`,
                key: `${prefix}/${entry.name}`,
                name: entry.name,
                created_at: '2026-08-22T00:00:00.000Z',
                updated_at: '2026-08-22T00:00:00.000Z',
                metadata: (entry.metadata ?? {}) as Record<string, unknown>,
              })),
            },
            error: options.listError ?? null,
          };
        }),
        remove: vi.fn(async (paths: string[]) => {
          options.onRemove?.(bucket, paths);
          removed.push({ bucket, paths });
          for (const path of paths) removedPaths.add(`${bucket}:${path}`);
          return { data: paths.map((name) => ({ name })), error: null };
        }),
      }),
    },
  };
}

const SELLER_WALLET = {
  user_id: USER_ID,
  available_token_subunits: 412500,
  held_token_subunits: 0,
  lifetime_earned_token_subunits: 500000,
  lifetime_refunded_token_subunits: 87500,
  lifetime_paid_out_token_subunits: 0,
};

/** The two Data API tables the wallet ledger touches: wallets read, records written. */
function walletTables(options: {
  wallets?: Array<Record<string, unknown>>;
  readError?: unknown;
  onRead?: (userIds: string[]) => void;
  onRecord?: () => void;
} = {}) {
  const recorded: Array<{ rows: unknown; options: unknown }> = [];
  const from = vi.fn((table: string) => {
    if (table === 'creator_resource_wallets') {
      const query = {
        select: vi.fn(),
        in: vi.fn(async (_column: string, userIds: string[]) => {
          options.onRead?.(userIds);
          return options.readError
            ? { data: null, error: options.readError }
            : { data: options.wallets ?? [], error: null };
        }),
      };
      query.select.mockReturnValue(query);
      return query;
    }
    if (table === 'account_deletion_wallet_records') {
      return {
        upsert: vi.fn(async (rows: unknown, upsertOptions: unknown) => {
          options.onRecord?.();
          recorded.push({ rows, options: upsertOptions });
          return { data: null, error: null };
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return { from, recorded };
}

describe('account deletion cleanup service', () => {
  it('sweeps private copies created after the durable legacy-path manifest', async () => {
    const prefix = `private-posts/${GENERATION_ID}`;
    const manifest = parseAccountDeletionStorageManifest({
      ...storageManifest,
      showcase_media_paths: [`posts/${GENERATION_ID}/original.mp4`],
    })!;
    const mock = storageMock({ listFiles: {
      [`post_media:${prefix}`]: [{ name: 'original.mp4' }, { name: 'display.webp' }],
    } });
    await removeAccountStorage(mock as never, USER_ID, manifest);
    expect(mock.removed).toContainEqual({ bucket: 'post_media', paths: [
      `${prefix}/original.mp4`, `${prefix}/display.webp`,
    ] });
  });

  it('rejects unsafe or incomplete persisted storage manifests', () => {
    expect(parseAccountDeletionStorageManifest(storageManifest)).toMatchObject({
      userPrefixBuckets: expect.arrayContaining(['profiles', 'generated_videos']),
      showcaseMediaPaths: [`showcase/${GENERATION_ID}/output.webp`],
    });
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      user_prefix_buckets: ['uploads'],
    })).toBeNull();
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      showcase_media_paths: ['../another-user/private.webp'],
    })).toBeNull();
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      showcase_media_paths: [`showcase/${GENERATION_ID}/%252fprivate.webp`],
    })).toBeNull();
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      template_asset_prefixes: ['2b2f4bb5-6ea8-4c44-a394-14cc777dcf52%252fother'],
    })).toBeNull();
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      showcase_media_paths: [` showcase/${GENERATION_ID}/output.webp`],
    })).toBeNull();
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      template_asset_prefixes: [' 2b2f4bb5-6ea8-4c44-a394-14cc777dcf52'],
    })).toBeNull();
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      showcase_media_paths: [42],
    })).toBeNull();
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      showcase_media_paths: [`other/${GENERATION_ID}/private.webp`],
    })).toBeNull();
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      showcase_media_paths: ['showcase/not-a-resource-id/private.webp'],
    })).toBeNull();
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      owner_user_ids: [],
    })).toBeNull();
    expect(parseAccountDeletionStorageManifest({
      ...storageManifest,
      owner_user_ids: [` ${USER_ID}`],
    })).toBeNull();
  });

  it('rejects non-canonical storage listing entries before privileged removal', async () => {
    const manifest = parseAccountDeletionStorageManifest(storageManifest);
    if (!manifest) throw new Error('Expected a valid fixture manifest.');
    const remove = vi.fn();
    const admin = {
      storage: {
        from: vi.fn((bucket: string) => ({
          listV2: vi.fn(async (options: { prefix?: string }) => {
            const prefix = (options.prefix ?? '').replace(/\/$/u, '');
            return storageV2Page(
              prefix,
              bucket === 'uploads' && prefix === USER_ID
                ? [{ id: 'unsafe', name: '%252fanother-user/private.webp' }]
                : [],
            );
          }),
          remove,
        })),
      },
    };

    await expect(removeAccountStorage(admin as never, USER_ID, manifest)).rejects.toThrow(
      'Could not inspect uploads account files.',
    );
    expect(remove).not.toHaveBeenCalled();
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
        if (name === 'list_creator_purchased_revisions_for_retention') {
          return { data: [], error: null };
        }
        if (name === 'mark_account_deleted_upload_reservations') {
          return { data: { status: 'ok', marked: 1 }, error: null };
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
      retainPurchasedFiles: vi.fn(async () => {
        calls.push('retain-purchased-files');
        return { revisionsRetained: 1, filesRetained: 2 };
      }),
      recordClaimedFingerprints: vi.fn(async () => {
        calls.push('record-claimed-fingerprints');
        return { usersWithGrants: 0, fingerprintRows: 0 };
      }),
      recordWalletBalances: vi.fn(async () => {
        calls.push('record-wallet-balances');
        return { walletsRecorded: 0 };
      }),
    })).resolves.toMatchObject({
      alreadyCompleted: false,
      authUserAlreadyMissing: false,
      cleanupPending: true,
    });
    // The claim and wallet ledgers are written while the auth rows still exist
    // — after the storage sweep settles, strictly before the destructive Auth
    // stage.
    expect(calls).toEqual([
      'prepare_account_deletion:',
      'mark_account_deletion_stage:storage_deleting',
      'mark_account_deleted_upload_reservations:',
      'retain-purchased-files',
      'mark_account_deletion_stage:storage_deleted',
      'record-claimed-fingerprints',
      'record-wallet-balances',
      'mark_account_deletion_stage:auth_deleting',
      `delete:${USER_ID}`,
      'mark_account_deletion_stage:completed',
    ]);
  });

  it('records the seller wallet through the Data API before the Auth delete that cascades it away', async () => {
    const calls: string[] = [];
    const wallets = walletTables({
      wallets: [SELLER_WALLET],
      onRead: (userIds) => calls.push(`read-wallets:${userIds.join(',')}`),
      onRecord: () => calls.push('insert-wallet-records'),
    });
    const admin = {
      from: wallets.from,
      storage: storageMock().storage,
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
          return { data: { status: 'prepared', storage_manifest: storageManifest }, error: null };
        }
        if (name === 'mark_account_deleted_upload_reservations') {
          return { data: { status: 'ok', marked: 1 }, error: null };
        }
        return { data: { status: args.p_status }, error: null };
      }),
    };

    await executeInitialAccountDeletion({
      admin: admin as never,
      userId: USER_ID,
      retainPurchasedFiles: vi.fn(async () => ({ revisionsRetained: 0, filesRetained: 0 })),
      recordClaimedFingerprints: vi.fn(async () => ({ usersWithGrants: 0, fingerprintRows: 0 })),
    });

    expect(wallets.recorded).toEqual([{
      rows: [{ job_id: USER_ID, ...SELLER_WALLET }],
      options: { onConflict: 'user_id,job_id', ignoreDuplicates: true },
    }]);
    expect(calls.indexOf(`read-wallets:${USER_ID}`)).toBeGreaterThan(
      calls.indexOf('mark_account_deletion_stage:storage_deleted'),
    );
    expect(calls.indexOf('insert-wallet-records')).toBeGreaterThan(calls.indexOf(`read-wallets:${USER_ID}`));
    expect(calls.indexOf('insert-wallet-records')).toBeLessThan(
      calls.indexOf('mark_account_deletion_stage:auth_deleting'),
    );
    expect(calls.indexOf('insert-wallet-records')).toBeLessThan(calls.indexOf(`delete:${USER_ID}`));
  });

  it('keeps Auth when the wallet cannot be read, so the job retries with the balance unrecorded', async () => {
    const deleteUser = vi.fn();
    const stages: string[] = [];
    const wallets = walletTables({ readError: { message: 'wallet read outage' } });
    const admin = {
      from: wallets.from,
      storage: storageMock().storage,
      auth: { admin: { deleteUser } },
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'prepare_account_deletion') {
          return { data: { status: 'prepared', storage_manifest: storageManifest }, error: null };
        }
        if (name === 'mark_account_deleted_upload_reservations') {
          return { data: { status: 'ok', marked: 1 }, error: null };
        }
        stages.push(String(args.p_status));
        return { data: { status: args.p_status }, error: null };
      }),
    };

    await expect(executeInitialAccountDeletion({
      admin: admin as never,
      userId: USER_ID,
      retainPurchasedFiles: vi.fn(async () => ({ revisionsRetained: 0, filesRetained: 0 })),
      recordClaimedFingerprints: vi.fn(async () => ({ usersWithGrants: 0, fingerprintRows: 0 })),
    })).rejects.toThrow('wallet read outage');

    expect(stages).toEqual(['storage_deleting', 'storage_deleted']);
    expect(wallets.recorded).toEqual([]);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('does not sweep source storage or delete Auth when purchased-file retention fails', async () => {
    const mockStorage = storageMock();
    const deleteUser = vi.fn();
    const admin = {
      storage: mockStorage.storage,
      auth: { admin: { deleteUser } },
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'prepare_account_deletion') {
          return { data: { status: 'prepared', storage_manifest: storageManifest }, error: null };
        }
        if (name === 'mark_account_deleted_upload_reservations') {
          return { data: { status: 'ok', marked: 1 }, error: null };
        }
        return { data: { status: args.p_status }, error: null };
      }),
    };

    await expect(executeInitialAccountDeletion({
      admin: admin as never,
      userId: USER_ID,
      retainPurchasedFiles: vi.fn(async () => {
        throw new Error('copy failed');
      }),
    })).rejects.toThrow('copy failed');

    expect(mockStorage.removed).toEqual([]);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalledWith(
      'mark_account_deletion_stage',
      expect.objectContaining({ p_status: 'storage_deleted' }),
    );
  });

  it('retains and sweeps every linked owner, then deletes guests before the target', async () => {
    const events: string[] = [];
    const linkedManifest = {
      ...storageManifest,
      owner_user_ids: [USER_ID, GUEST_ID],
    };
    const mockStorage = storageMock({
      listFiles: {
        [`uploads:${USER_ID}`]: [{ id: 'target-file', name: 'target.png' }],
        [`uploads:${GUEST_ID}`]: [{ id: 'guest-file', name: 'guest.png' }],
      },
      onList: (bucket, prefix) => events.push(`list:${bucket}:${prefix}`),
      onRemove: (bucket, paths) => events.push(`remove:${bucket}:${paths.join(',')}`),
    });
    const deletionOrder: string[] = [];
    const retainedOwners: string[] = [];
    const admin = {
      storage: mockStorage.storage,
      auth: {
        admin: {
          deleteUser: vi.fn(async (userId: string) => {
            deletionOrder.push(userId);
            return { data: null, error: null };
          }),
        },
      },
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'prepare_account_deletion') {
          return { data: { status: 'prepared', storage_manifest: linkedManifest }, error: null };
        }
        if (name === 'mark_account_deleted_upload_reservations') {
          events.push('mark-reservations');
          return { data: { status: 'ok', marked: 2 }, error: null };
        }
        if (name === 'mark_account_deletion_stage' && args.p_status === 'completed') {
          return { data: { status: 'resweep_pending' }, error: null };
        }
        return { data: { status: args.p_status }, error: null };
      }),
    };

    const fingerprintedOwners: string[][] = [];
    const recordWalletBalances = vi.fn(async () => ({ walletsRecorded: 0 }));
    await executeInitialAccountDeletion({
      admin: admin as never,
      userId: USER_ID,
      retainPurchasedFiles: vi.fn(async (_admin, ownerUserId) => {
        events.push(`retain:${ownerUserId}`);
        retainedOwners.push(ownerUserId);
        return { revisionsRetained: 0, filesRetained: 0 };
      }),
      recordClaimedFingerprints: vi.fn(async (_admin, ownerUserIds: string[]) => {
        fingerprintedOwners.push(ownerUserIds);
        return { usersWithGrants: 0, fingerprintRows: 0 };
      }),
      recordWalletBalances,
    });

    // Guests cannot claim, but the ledger pass receives every linked identity
    // and filters by actual grants itself.
    expect(fingerprintedOwners).toEqual([[USER_ID, GUEST_ID]]);
    // Every linked wallet is recorded under the target's deletion job.
    expect(recordWalletBalances).toHaveBeenCalledWith(admin, USER_ID, [USER_ID, GUEST_ID]);

    expect(retainedOwners).toEqual([USER_ID, GUEST_ID]);
    expect(mockStorage.removed).toContainEqual({
      bucket: 'uploads',
      paths: [`${USER_ID}/target.png`],
    });
    expect(mockStorage.removed).toContainEqual({
      bucket: 'uploads',
      paths: [`${GUEST_ID}/guest.png`],
    });
    expect(admin.rpc).toHaveBeenCalledWith('mark_account_deleted_upload_reservations', {
      p_owner_user_ids: [USER_ID, GUEST_ID],
    });
    expect(events.indexOf('mark-reservations')).toBeLessThan(
      events.indexOf(`retain:${USER_ID}`),
    );
    expect(events.indexOf(`retain:${GUEST_ID}`)).toBeLessThan(
      events.indexOf(`list:profiles:${USER_ID}`),
    );
    expect(events.indexOf(`remove:uploads:${USER_ID}/target.png`)).toBeLessThan(
      events.lastIndexOf(`list:uploads:${USER_ID}`),
    );
    expect(events.indexOf(`remove:uploads:${GUEST_ID}/guest.png`)).toBeLessThan(
      events.lastIndexOf(`list:uploads:${GUEST_ID}`),
    );
    expect(deletionOrder).toEqual([GUEST_ID, USER_ID]);
  });

  it('never advances to Auth deletion when Storage reports success but a canonical re-list finds the object', async () => {
    const deleteUser = vi.fn();
    const storageDeletedStage = vi.fn();
    const admin = {
      storage: {
        from: vi.fn((bucket: string) => ({
          listV2: vi.fn(async (options: { prefix?: string }) => {
            const prefix = (options.prefix ?? '').replace(/\/$/u, '');
            return storageV2Page(
              prefix,
              bucket === 'uploads' && prefix === USER_ID
                ? [{ id: 'residual-file', name: 'residual.png' }]
                : [],
            );
          }),
          remove: vi.fn(async (paths: string[]) => ({
            data: paths.map((name) => ({ name })),
            error: null,
          })),
        })),
      },
      auth: { admin: { deleteUser } },
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'prepare_account_deletion') {
          return { data: { status: 'prepared', storage_manifest: storageManifest }, error: null };
        }
        if (name === 'mark_account_deleted_upload_reservations') {
          return { data: { status: 'ok', marked: 1 }, error: null };
        }
        if (name === 'mark_account_deletion_stage' && args.p_status === 'storage_deleted') {
          storageDeletedStage();
        }
        return { data: { status: args.p_status }, error: null };
      }),
    };

    await expect(executeInitialAccountDeletion({
      admin: admin as never,
      userId: USER_ID,
      retainPurchasedFiles: vi.fn(async () => ({ revisionsRetained: 0, filesRetained: 0 })),
    })).rejects.toThrow('Could not verify uploads account files were removed.');

    expect(storageDeletedStage).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('never advances to Auth deletion when reservation tombstoning returns an invalid acknowledgement', async () => {
    const deleteUser = vi.fn();
    const stages: string[] = [];
    const admin = {
      storage: storageMock().storage,
      auth: { admin: { deleteUser } },
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'prepare_account_deletion') {
          return { data: { status: 'prepared', storage_manifest: storageManifest }, error: null };
        }
        if (name === 'mark_account_deleted_upload_reservations') {
          return { data: { status: 'ok', marked: -1 }, error: null };
        }
        if (name === 'mark_account_deletion_stage') {
          stages.push(String(args.p_status));
          return { data: { status: args.p_status }, error: null };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    await expect(executeInitialAccountDeletion({
      admin: admin as never,
      userId: USER_ID,
      retainPurchasedFiles: vi.fn(async () => ({ revisionsRetained: 0, filesRetained: 0 })),
    })).rejects.toThrow('Could not mark deleted-account upload reservations.');

    expect(stages).toEqual(['storage_deleting']);
    expect(deleteUser).not.toHaveBeenCalled();
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
    const events: string[] = [];
    const mockStorage = storageMock({
      onList: (bucket, prefix) => events.push(`list:${bucket}:${prefix}`),
    });
    let claims = 0;
    const transitions: string[] = [];
    const deleteUser = vi.fn(async () => {
      events.push('delete-auth');
      return { data: null, error: null };
    });
    const recordWalletBalances = vi.fn(async () => {
      events.push('record-wallet-balances');
      return { walletsRecorded: 1 };
    });
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
        if (name === 'list_creator_purchased_revisions_for_retention') {
          return { data: [], error: null };
        }
        if (name === 'mark_account_deleted_upload_reservations') {
          events.push('mark-reservations');
          return { data: { status: 'ok', marked: 1 }, error: null };
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
      retainPurchasedFiles: vi.fn(async () => {
        events.push('retain-purchased-files');
        return { revisionsRetained: 0, filesRetained: 0 };
      }),
      recordClaimedFingerprints: vi.fn(async () => ({ usersWithGrants: 0, fingerprintRows: 0 })),
      recordWalletBalances,
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
    // A job whose immediate pass never reached the Auth step still leaves the
    // wallet on record before the cascade.
    expect(recordWalletBalances).toHaveBeenCalledWith(admin, USER_ID, [USER_ID]);
    expect(events.indexOf('record-wallet-balances')).toBeLessThan(events.indexOf('delete-auth'));
    expect(events.indexOf('mark-reservations')).toBeLessThan(
      events.indexOf('retain-purchased-files'),
    );
    expect(events.indexOf('retain-purchased-files')).toBeLessThan(
      events.indexOf(`list:profiles:${USER_ID}`),
    );
    expect(transitions).toEqual([
      'storage_deleted',
      'auth_deleting',
      'resweep_waiting',
    ]);
  });

  it('durably reschedules a misleading Storage 5xx instead of treating its message as absence', async () => {
    let claims = 0;
    const admin = {
      storage: storageMock({
        listError: { status: 500, message: 'Bucket not found' },
      }).storage,
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
        if (name === 'list_creator_purchased_revisions_for_retention') {
          return { data: [], error: null };
        }
        if (name === 'mark_account_deleted_upload_reservations') {
          return { data: { status: 'ok', marked: 1 }, error: null };
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

  it('durably retries a misleading Auth 5xx and never advances to the target deletion fallback', async () => {
    let claims = 0;
    const transitions: string[] = [];
    const deleteUser = vi.fn(async () => ({
      data: null,
      error: { status: 500, message: 'User not found' },
    }));
    const admin = {
      storage: storageMock().storage,
      auth: { admin: { deleteUser } },
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'claim_account_deletion_initial') {
          claims += 1;
          return claims === 1
            ? {
                data: {
                  status: 'claimed',
                  job_status: 'auth_deleting',
                  user_id: USER_ID,
                  lease_token: LEASE_TOKEN,
                  storage_manifest: storageManifest,
                },
                error: null,
              }
            : { data: { status: 'no_work' }, error: null };
        }
        if (name === 'mark_account_deleted_upload_reservations') {
          return { data: { status: 'ok', marked: 1 }, error: null };
        }
        if (name === 'transition_account_deletion_initial') {
          transitions.push(String(args.p_status));
          return {
            data: { status: args.p_status === 'failed' ? 'retry_scheduled' : args.p_status },
            error: null,
          };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    const recordWalletBalances = vi.fn(async () => ({ walletsRecorded: 0 }));
    await expect(processAccountDeletionInitialRetries({
      admin: admin as never,
      workerId: 'account-deletion-worker:test',
      limit: 1,
      recordClaimedFingerprints: vi.fn(async () => ({ usersWithGrants: 0, fingerprintRows: 0 })),
      recordWalletBalances,
    })).resolves.toMatchObject({
      claimed: 1,
      retryScheduled: 1,
      resweepScheduled: 0,
    });
    expect(recordWalletBalances).toHaveBeenCalledWith(admin, USER_ID, [USER_ID]);
    expect(recordWalletBalances.mock.invocationCallOrder[0]).toBeLessThan(
      deleteUser.mock.invocationCallOrder[0],
    );
    expect(transitions).toEqual(['auth_deleting', 'failed']);
    expect(admin.rpc).toHaveBeenCalledWith('mark_account_deleted_upload_reservations', {
      p_owner_user_ids: [USER_ID],
    });
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  it('reclaims a delayed resweep, deletes files created by old upload tokens, and finalizes it', async () => {
    const events: string[] = [];
    const linkedManifest = { ...storageManifest, owner_user_ids: [USER_ID, GUEST_ID] };
    const mockStorage = storageMock({
      listFiles: {
        [`uploads:${USER_ID}`]: [{ id: 'late-file', name: 'late-upload.png' }],
      },
      onList: (bucket, prefix) => events.push(`list:${bucket}:${prefix}`),
      onRemove: (bucket, paths) => events.push(`remove:${bucket}:${paths.join(',')}`),
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
                  storage_manifest: linkedManifest,
                },
                error: null,
              }
            : { data: { status: 'no_work' }, error: null };
        }
        if (name === 'finalize_account_deletion_resweep') {
          return finalize(args);
        }
        if (name === 'mark_account_deleted_upload_reservations') {
          events.push('mark-reservations');
          return { data: { status: 'ok', marked: 2 }, error: null };
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
    expect(events.indexOf('mark-reservations')).toBeLessThan(
      events.indexOf(`list:profiles:${USER_ID}`),
    );
    expect(events.indexOf(`remove:uploads:${USER_ID}/late-upload.png`)).toBeLessThan(
      events.lastIndexOf(`list:uploads:${USER_ID}`),
    );
    expect(admin.rpc).toHaveBeenCalledWith('mark_account_deleted_upload_reservations', {
      p_owner_user_ids: [USER_ID, GUEST_ID],
    });
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
      p_user_id: USER_ID,
      p_lease_token: LEASE_TOKEN,
      p_succeeded: true,
    }));
  });

  it('tombstones before the delayed sweep and keeps a residual object in durable retry', async () => {
    let claims = 0;
    const markReservations = vi.fn();
    const finalize = vi.fn(async (args: Record<string, unknown>) => {
      void args;
      return { data: { status: 'retry_scheduled' }, error: null };
    });
    const admin = {
      storage: {
        from: vi.fn((bucket: string) => ({
          listV2: vi.fn(async (options: { prefix?: string }) => {
            const prefix = (options.prefix ?? '').replace(/\/$/u, '');
            return storageV2Page(
              prefix,
              bucket === 'uploads' && prefix === USER_ID
                ? [{ id: 'residual-file', name: 'late-upload.png' }]
                : [],
            );
          }),
          remove: vi.fn(async (paths: string[]) => ({
            data: paths.map((name) => ({ name })),
            error: null,
          })),
        })),
      },
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
        if (name === 'mark_account_deleted_upload_reservations') {
          markReservations();
          return { data: { status: 'ok', marked: 1 }, error: null };
        }
        if (name === 'finalize_account_deletion_resweep') return finalize(args);
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    await expect(processAccountDeletionResweeps({
      admin: admin as never,
      workerId: 'account-deletion-worker:test',
      limit: 1,
    })).resolves.toMatchObject({ retryScheduled: 1, completed: 0 });
    expect(markReservations).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
      p_succeeded: false,
      p_error_message: 'Could not verify uploads account files were removed.',
    }));
  });

  it('keeps a delayed deletion durable when reservation tombstoning fails', async () => {
    let claims = 0;
    const finalize = vi.fn(async (args: Record<string, unknown>) => {
      void args;
      return { data: { status: 'retry_scheduled' }, error: null };
    });
    const admin = {
      storage: storageMock().storage,
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
        if (name === 'mark_account_deleted_upload_reservations') {
          return { data: null, error: new Error('reservation DB unavailable') };
        }
        if (name === 'finalize_account_deletion_resweep') return finalize(args);
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };

    await expect(processAccountDeletionResweeps({
      admin: admin as never,
      workerId: 'account-deletion-worker:test',
      limit: 1,
    })).resolves.toMatchObject({ retryScheduled: 1, completed: 0 });
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
      p_succeeded: false,
      p_error_message: 'reservation DB unavailable',
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
        if (name === 'mark_account_deleted_upload_reservations') {
          return { data: { status: 'ok', marked: 1 }, error: null };
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

  it('starts by locking the account and revoking every session, and leaves the sweep for later', async () => {
    const calls: string[] = [];
    const admin = {
      auth: {
        admin: {
          deleteUser: vi.fn(),
          signOut: vi.fn(async (_token: string, scope: string) => {
            calls.push(`sign-out:${scope}`);
            return { data: null, error: null };
          }),
        },
      },
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push(`${name}:${String(args.p_status ?? '')}`);
        if (name === 'prepare_account_deletion') {
          return { data: { status: 'prepared', storage_manifest: storageManifest }, error: null };
        }
        return { data: { status: args.p_status }, error: null };
      }),
      storage: { from: vi.fn() },
    };

    await expect(startInitialAccountDeletion({
      accessToken: 'token',
      admin: admin as never,
      userId: USER_ID,
    })).resolves.toEqual({
      status: 'started',
      manifest: parseAccountDeletionStorageManifest(storageManifest),
    });
    expect(calls).toEqual([
      'prepare_account_deletion:',
      'mark_account_deletion_stage:storage_deleting',
      'sign-out:global',
    ]);
    expect(admin.storage.from).not.toHaveBeenCalled();
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('reports a failed prepare as not started, before any session is revoked', async () => {
    const signOut = vi.fn();
    const admin = {
      auth: { admin: { signOut } },
      rpc: vi.fn(async () => ({ data: null, error: { message: 'prepare unavailable' } })),
    };

    const start = startInitialAccountDeletion({
      accessToken: 'token',
      admin: admin as never,
      userId: USER_ID,
    });
    await expect(start).rejects.toBeInstanceOf(AccountDeletionNotStartedError);
    await expect(start).rejects.toThrow('prepare unavailable');
    expect(signOut).not.toHaveBeenCalled();
  });

  it('treats a committed prepare with an unusable manifest as started, never as untouched', async () => {
    const admin = {
      auth: { admin: { signOut: vi.fn() } },
      rpc: vi.fn(async () => ({ data: { status: 'prepared', storage_manifest: {} }, error: null })),
    };

    const start = startInitialAccountDeletion({ admin: admin as never, userId: USER_ID });
    // prepare_account_deletion has already marked the identity `deleting`.
    await expect(start).rejects.toThrow('Account deletion storage manifest is invalid.');
    await expect(start).rejects.not.toBeInstanceOf(AccountDeletionNotStartedError);
  });

  it('records a linked guest wallet under the target deletion job', async () => {
    const guestWallet = { ...SELLER_WALLET, user_id: GUEST_ID, available_token_subunits: -400 };
    const wallets = walletTables({ wallets: [SELLER_WALLET, guestWallet] });

    await expect(recordAccountDeletionWalletBalances(
      { from: wallets.from } as never,
      USER_ID,
      [USER_ID, GUEST_ID],
    )).resolves.toEqual({ walletsRecorded: 2 });
    expect(wallets.recorded).toEqual([{
      rows: [
        { job_id: USER_ID, ...SELLER_WALLET },
        { job_id: USER_ID, ...guestWallet },
      ],
      options: { onConflict: 'user_id,job_id', ignoreDuplicates: true },
    }]);
  });

  it('writes nothing for owners without a wallet', async () => {
    const wallets = walletTables({ wallets: [] });

    await expect(recordAccountDeletionWalletBalances(
      { from: wallets.from } as never,
      USER_ID,
      [USER_ID],
    )).resolves.toEqual({ walletsRecorded: 0 });
    expect(wallets.from).toHaveBeenCalledTimes(1);
    expect(wallets.recorded).toEqual([]);
  });

  it('refuses to record an amount that did not arrive as an exact integer', async () => {
    const wallets = walletTables({
      wallets: [{ ...SELLER_WALLET, available_token_subunits: '412500' }],
    });

    await expect(recordAccountDeletionWalletBalances(
      { from: wallets.from } as never,
      USER_ID,
      [USER_ID],
    )).rejects.toThrow('Could not read creator wallets before account deletion.');
    expect(wallets.recorded).toEqual([]);
  });
});
