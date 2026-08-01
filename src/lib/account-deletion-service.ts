import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { retainPurchasedUnlockFiles } from '@/lib/account-deletion-resource-retention';

const USER_PREFIX_BUCKETS = [
  'profiles',
  'uploads',
  'generated_images',
  'generated_videos',
  'generated_audio',
  'generation_inputs',
  'post_resource_files',
  'template_inputs',
] as const;

const TEMPLATE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACCOUNT_DELETION_RESWEEP_BATCH_LIMIT = 10;
const ACCOUNT_DELETION_RESWEEP_LEASE_SECONDS = 10 * 60;

export type AccountDeletionStorageManifest = {
  userPrefixBuckets: Array<(typeof USER_PREFIX_BUCKETS)[number]>;
  showcaseMediaPaths: string[];
  templateAssetPrefixes: string[];
};

type StorageEntry = {
  id?: string | null;
  name: string;
  metadata?: unknown;
};

type StorageCleanupSummary = {
  bucketsScanned: number;
  objectsRemoved: number;
};

type InitialAccountDeletionResult = {
  alreadyCompleted: boolean;
  authUserAlreadyMissing: boolean;
  cleanupPending: boolean;
  storage: StorageCleanupSummary;
};

type AccountDeletionResweepSummary = {
  claimed: number;
  completed: number;
  alreadyCompleted: number;
  retryScheduled: number;
  leaseMismatches: number;
  objectsRemoved: number;
};

type AccountDeletionInitialRetrySummary = {
  claimed: number;
  storageSwept: number;
  resweepScheduled: number;
  alreadyCompleted: number;
  retryScheduled: number;
  transitionConflicts: number;
  objectsRemoved: number;
};

type AccountDeletionCleanupSummary = {
  initial: AccountDeletionInitialRetrySummary;
  resweeps: AccountDeletionResweepSummary;
};

type ExecuteInitialAccountDeletionOptions = {
  accessToken?: string;
  admin: SupabaseClient;
  userId: string;
  onNonFatalError?: (message: string, error: unknown) => void;
  retainPurchasedFiles?: typeof retainPurchasedUnlockFiles;
};

type ProcessAccountDeletionResweepsOptions = {
  admin: SupabaseClient;
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
};

type ProcessAccountDeletionInitialRetriesOptions = ProcessAccountDeletionResweepsOptions & {
  retainPurchasedFiles?: typeof retainPurchasedUnlockFiles;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function isMissingBucketError(error: unknown) {
  if (!isRecord(error)) return false;
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  const status = String(error.status ?? error.statusCode ?? '');
  return status === '404' || message.includes('bucket not found');
}

function isMissingAuthUserError(error: unknown) {
  if (!isRecord(error)) return false;
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  const status = String(error.status ?? error.statusCode ?? '');
  return status === '404' || message.includes('user not found');
}

function isAlreadyRevokedSessionError(error: unknown) {
  if (!isRecord(error)) return false;
  const status = String(error.status ?? error.statusCode ?? '');
  return status === '401' || status === '403' || status === '404';
}

function normalizedStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean),
  )];
}

export function parseAccountDeletionStorageManifest(
  value: unknown,
): AccountDeletionStorageManifest | null {
  if (!isRecord(value)) return null;
  if (
    !Array.isArray(value.user_prefix_buckets)
    || !Array.isArray(value.showcase_media_paths)
    || !Array.isArray(value.template_asset_prefixes)
  ) {
    return null;
  }

  const allowedBuckets = new Set<string>(USER_PREFIX_BUCKETS);
  const rawUserPrefixBuckets = normalizedStringArray(value.user_prefix_buckets);
  const showcaseMediaPaths = normalizedStringArray(value.showcase_media_paths);
  const templateAssetPrefixes = normalizedStringArray(value.template_asset_prefixes);

  if (
    rawUserPrefixBuckets.length !== USER_PREFIX_BUCKETS.length
    || rawUserPrefixBuckets.some((bucket) => !allowedBuckets.has(bucket))
    || showcaseMediaPaths.some(
      (path) => path.startsWith('/') || path.includes('..') || path.includes('\\'),
    )
    || templateAssetPrefixes.some((prefix) => !TEMPLATE_ID_PATTERN.test(prefix))
  ) {
    return null;
  }

  return {
    userPrefixBuckets:
      rawUserPrefixBuckets as Array<(typeof USER_PREFIX_BUCKETS)[number]>,
    showcaseMediaPaths,
    templateAssetPrefixes,
  };
}

async function listUserFiles(
  admin: SupabaseClient,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const files: string[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, {
      limit: 1000,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });

    if (error) {
      if (isMissingBucketError(error)) return files;
      throw new Error(`Could not inspect ${bucket} account files.`);
    }

    const entries = (data ?? []) as StorageEntry[];
    for (const entry of entries) {
      const path = `${prefix}/${entry.name}`;
      if (entry.id || entry.metadata) {
        files.push(path);
      } else {
        files.push(...await listUserFiles(admin, bucket, path));
      }
    }

    if (entries.length < 1000) break;
    offset += entries.length;
  }

  return files;
}

export async function removeAccountStorage(
  admin: SupabaseClient,
  userId: string,
  manifest: AccountDeletionStorageManifest,
): Promise<StorageCleanupSummary> {
  let bucketsScanned = 0;
  let objectsRemoved = 0;

  async function removePaths(bucket: string, paths: string[]) {
    for (let index = 0; index < paths.length; index += 100) {
      const batch = paths.slice(index, index + 100);
      const { error } = await admin.storage.from(bucket).remove(batch);
      if (error && !isMissingBucketError(error)) {
        throw new Error(`Could not remove ${bucket} account files.`);
      }
      objectsRemoved += batch.length;
    }
  }

  for (const bucket of manifest.userPrefixBuckets) {
    bucketsScanned += 1;
    const paths = await listUserFiles(admin, bucket, userId);
    await removePaths(bucket, paths);
  }

  bucketsScanned += 1;
  await removePaths('showcase_media', manifest.showcaseMediaPaths);

  for (const templatePrefix of manifest.templateAssetPrefixes) {
    bucketsScanned += 1;
    const paths = await listUserFiles(admin, 'template_assets', templatePrefix);
    await removePaths('template_assets', paths);
  }

  return { bucketsScanned, objectsRemoved };
}

async function prepareAccountDeletion(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin.rpc('prepare_account_deletion', {
    p_user_id: userId,
  });

  if (
    error
    || !isRecord(data)
    || !['prepared', 'already_completed'].includes(String(data.status))
  ) {
    throw new Error(errorMessage(error, 'Could not prepare account deletion.'));
  }

  if (data.status === 'already_completed') {
    return { alreadyCompleted: true as const, manifest: null };
  }

  const manifest = parseAccountDeletionStorageManifest(data.storage_manifest);
  if (!manifest) throw new Error('Account deletion storage manifest is invalid.');

  return { alreadyCompleted: false as const, manifest };
}

export async function markAccountDeletionStage(
  admin: SupabaseClient,
  userId: string,
  status: 'storage_deleting' | 'storage_deleted' | 'auth_deleting' | 'completed' | 'failed',
  failure?: unknown,
): Promise<string> {
  const { data, error } = await admin.rpc('mark_account_deletion_stage', {
    p_user_id: userId,
    p_status: status,
    p_error_message:
      status === 'failed'
        ? errorMessage(failure, 'Unknown deletion error').slice(0, 1000)
        : null,
  });

  const responseStatus = isRecord(data) ? String(data.status ?? '') : '';
  const acceptedStatuses = [status, 'resweep_pending', 'already_completed'];

  if (error || !acceptedStatuses.includes(responseStatus)) {
    throw new Error(
      errorMessage(error, `Could not persist account deletion stage ${status}.`),
    );
  }

  return responseStatus;
}

/**
 * Performs the immediate, user-authorized deletion pass. The operation is
 * idempotent: storage deletes tolerate already-missing objects and every
 * database stage is persisted before the next destructive action.
 *
 * A successful Auth deletion schedules a second Storage sweep after all
 * previously issued signed-upload tokens have expired. Therefore
 * `cleanupPending` remains true until the resweep worker finalizes the job.
 */
export async function executeInitialAccountDeletion({
  accessToken,
  admin,
  userId,
  onNonFatalError,
  retainPurchasedFiles = retainPurchasedUnlockFiles,
}: ExecuteInitialAccountDeletionOptions): Promise<InitialAccountDeletionResult> {
  const preparation = await prepareAccountDeletion(admin, userId);
  if (preparation.alreadyCompleted) {
    return {
      alreadyCompleted: true,
      authUserAlreadyMissing: true,
      cleanupPending: false,
      storage: { bucketsScanned: 0, objectsRemoved: 0 },
    };
  }

  const storageDeletingStatus = await markAccountDeletionStage(
    admin,
    userId,
    'storage_deleting',
  );
  if (storageDeletingStatus === 'already_completed') {
    return {
      alreadyCompleted: true,
      authUserAlreadyMissing: true,
      cleanupPending: false,
      storage: { bucketsScanned: 0, objectsRemoved: 0 },
    };
  }
  if (storageDeletingStatus === 'resweep_pending') {
    return {
      alreadyCompleted: false,
      authUserAlreadyMissing: true,
      cleanupPending: true,
      storage: { bucketsScanned: 0, objectsRemoved: 0 },
    };
  }

  if (accessToken) {
    const { error: signOutError } = await admin.auth.admin.signOut(accessToken, 'global');
    if (signOutError && !isAlreadyRevokedSessionError(signOutError)) {
      throw signOutError;
    }
  }

  // Retention is a hard gate: never sweep creator-prefixed storage or delete
  // Auth until every purchased revision has a durable neutral copy.
  await retainPurchasedFiles(admin, userId);
  const storage = await removeAccountStorage(admin, userId, preparation.manifest);
  const storageDeletedStatus = await markAccountDeletionStage(
    admin,
    userId,
    'storage_deleted',
  );
  if (storageDeletedStatus === 'already_completed' || storageDeletedStatus === 'resweep_pending') {
    return {
      alreadyCompleted: storageDeletedStatus === 'already_completed',
      authUserAlreadyMissing: true,
      cleanupPending: storageDeletedStatus === 'resweep_pending',
      storage,
    };
  }

  const authDeletingStatus = await markAccountDeletionStage(admin, userId, 'auth_deleting');
  if (authDeletingStatus === 'already_completed' || authDeletingStatus === 'resweep_pending') {
    return {
      alreadyCompleted: authDeletingStatus === 'already_completed',
      authUserAlreadyMissing: true,
      cleanupPending: authDeletingStatus === 'resweep_pending',
      storage,
    };
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  const authUserAlreadyMissing = Boolean(deleteError && isMissingAuthUserError(deleteError));
  if (deleteError && !authUserAlreadyMissing) throw deleteError;

  try {
    await markAccountDeletionStage(admin, userId, 'completed');
  } catch (error) {
    // Successful Auth deletion and its database trigger are one transaction,
    // so the durable resweep is already scheduled. This acknowledgement is
    // deliberately non-fatal: changing the job to `failed` after the Auth row
    // is gone would make the completed destructive action unrecoverable.
    onNonFatalError?.(
      'Account deletion resweep acknowledgement could not be persisted.',
      error,
    );
  }

  return {
    alreadyCompleted: false,
    authUserAlreadyMissing,
    cleanupPending: true,
    storage,
  };
}

function parseClaimedResweep(value: unknown):
  | {
      status: 'no_work';
    }
  | {
      status: 'claimed';
      userId: string;
      leaseToken: string;
      manifest: AccountDeletionStorageManifest | null;
    }
  | null {
  if (!isRecord(value)) return null;
  if (value.status === 'no_work') return { status: 'no_work' };
  if (
    value.status !== 'claimed'
    || typeof value.user_id !== 'string'
    || !UUID_PATTERN.test(value.user_id)
    || typeof value.lease_token !== 'string'
    || !UUID_PATTERN.test(value.lease_token)
  ) {
    return null;
  }

  return {
    status: 'claimed',
    userId: value.user_id,
    leaseToken: value.lease_token,
    manifest: parseAccountDeletionStorageManifest(value.storage_manifest),
  };
}

function parseClaimedInitialDeletion(value: unknown):
  | {
      status: 'no_work';
    }
  | {
      status: 'claimed';
      jobStatus: 'storage_deleting' | 'auth_deleting';
      userId: string;
      leaseToken: string;
      manifest: AccountDeletionStorageManifest | null;
    }
  | null {
  if (!isRecord(value)) return null;
  if (value.status === 'no_work') return { status: 'no_work' };
  if (
    value.status !== 'claimed'
    || !['storage_deleting', 'auth_deleting'].includes(String(value.job_status))
    || typeof value.user_id !== 'string'
    || !UUID_PATTERN.test(value.user_id)
    || typeof value.lease_token !== 'string'
    || !UUID_PATTERN.test(value.lease_token)
  ) {
    return null;
  }

  return {
    status: 'claimed',
    jobStatus: value.job_status as 'storage_deleting' | 'auth_deleting',
    userId: value.user_id,
    leaseToken: value.lease_token,
    manifest: parseAccountDeletionStorageManifest(value.storage_manifest),
  };
}

type InitialTransitionStatus =
  | 'storage_deleted'
  | 'auth_deleting'
  | 'resweep_pending'
  | 'retry_scheduled'
  | 'lease_mismatch'
  | 'invalid_transition'
  | 'already_completed';

async function transitionAccountDeletionInitial(
  admin: SupabaseClient,
  input: {
    userId: string;
    leaseToken: string;
    status: 'storage_deleted' | 'auth_deleting' | 'resweep_waiting' | 'failed';
    error?: unknown;
  },
): Promise<InitialTransitionStatus> {
  const { data, error } = await admin.rpc('transition_account_deletion_initial', {
    p_user_id: input.userId,
    p_lease_token: input.leaseToken,
    p_status: input.status,
    p_error_message:
      input.status === 'failed'
        ? errorMessage(input.error, 'Unknown initial deletion error').slice(0, 1000)
        : null,
  });
  const status = isRecord(data) ? String(data.status ?? '') : '';

  if (
    error
    || ![
      'storage_deleted',
      'auth_deleting',
      'resweep_pending',
      'retry_scheduled',
      'lease_mismatch',
      'invalid_transition',
      'already_completed',
    ].includes(status)
  ) {
    throw new Error(errorMessage(error, 'Could not transition account deletion retry.'));
  }

  return status as InitialTransitionStatus;
}

async function finalizeAccountDeletionResweep(
  admin: SupabaseClient,
  input: {
    userId: string;
    leaseToken: string;
    succeeded: boolean;
    error?: unknown;
  },
): Promise<'completed' | 'retry_scheduled' | 'lease_mismatch' | 'already_completed'> {
  const { data, error } = await admin.rpc('finalize_account_deletion_resweep', {
    p_user_id: input.userId,
    p_lease_token: input.leaseToken,
    p_succeeded: input.succeeded,
    p_error_message: input.succeeded
      ? null
      : errorMessage(input.error, 'Unknown storage resweep error').slice(0, 1000),
  });
  const status = isRecord(data) ? String(data.status ?? '') : '';

  if (
    error
    || !['completed', 'retry_scheduled', 'lease_mismatch', 'already_completed'].includes(status)
  ) {
    throw new Error(errorMessage(error, 'Could not finalize account deletion resweep.'));
  }

  return status as
    | 'completed'
    | 'retry_scheduled'
    | 'lease_mismatch'
    | 'already_completed';
}

export async function hasDueAccountDeletionInitialRetries(
  admin: SupabaseClient,
  now = new Date(),
): Promise<boolean> {
  const nowIso = now.toISOString();
  const staleBeforeIso = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('account_deletion_jobs')
    .select('user_id')
    .in('status', [
      'requested',
      'storage_deleting',
      'storage_deleted',
      'auth_deleting',
      'failed',
    ])
    .lte('next_attempt_at', nowIso)
    .or(`status.eq.failed,updated_at.lte.${staleBeforeIso}`)
    .or(`lease_token.is.null,lease_expires_at.is.null,lease_expires_at.lte.${nowIso}`)
    .limit(1);

  if (error) {
    throw new Error(errorMessage(error, 'Could not inspect initial account deletions.'));
  }

  return Boolean(data?.length);
}

export async function hasDueAccountDeletionResweeps(
  admin: SupabaseClient,
  now = new Date(),
): Promise<boolean> {
  const nowIso = now.toISOString();
  const { data, error } = await admin
    .from('account_deletion_jobs')
    .select('user_id')
    .in('status', ['resweep_waiting', 'resweep_deleting'])
    .lte('resweep_after', nowIso)
    .lte('next_attempt_at', nowIso)
    .or(
      `status.eq.resweep_waiting,lease_expires_at.is.null,lease_expires_at.lte.${nowIso}`,
    )
    .limit(1);

  if (error) {
    throw new Error(errorMessage(error, 'Could not inspect account deletion resweeps.'));
  }

  return Boolean(data?.length);
}

export async function hasDueAccountDeletionCleanup(
  admin: SupabaseClient,
  now = new Date(),
): Promise<boolean> {
  const [hasInitialRetry, hasResweep] = await Promise.all([
    hasDueAccountDeletionInitialRetries(admin, now),
    hasDueAccountDeletionResweeps(admin, now),
  ]);

  return hasInitialRetry || hasResweep;
}

export async function processAccountDeletionInitialRetries({
  admin,
  workerId,
  limit = ACCOUNT_DELETION_RESWEEP_BATCH_LIMIT,
  leaseSeconds = ACCOUNT_DELETION_RESWEEP_LEASE_SECONDS,
  retainPurchasedFiles = retainPurchasedUnlockFiles,
}: ProcessAccountDeletionInitialRetriesOptions): Promise<AccountDeletionInitialRetrySummary> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Account deletion retry limit must be between 1 and 100.');
  }

  const summary: AccountDeletionInitialRetrySummary = {
    claimed: 0,
    storageSwept: 0,
    resweepScheduled: 0,
    alreadyCompleted: 0,
    retryScheduled: 0,
    transitionConflicts: 0,
    objectsRemoved: 0,
  };

  for (let index = 0; index < limit; index += 1) {
    const { data, error } = await admin.rpc('claim_account_deletion_initial', {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
    if (error) {
      throw new Error(errorMessage(error, 'Could not claim account deletion retry.'));
    }

    const claim = parseClaimedInitialDeletion(data);
    if (!claim) throw new Error('Account deletion retry claim returned invalid data.');
    if (claim.status === 'no_work') break;

    summary.claimed += 1;

    try {
      if (claim.jobStatus === 'storage_deleting') {
        if (!claim.manifest) {
          throw new Error('Account deletion storage manifest is invalid.');
        }

        await retainPurchasedFiles(admin, claim.userId);
        const storage = await removeAccountStorage(admin, claim.userId, claim.manifest);
        summary.storageSwept += 1;
        summary.objectsRemoved += storage.objectsRemoved;

        const storageTransition = await transitionAccountDeletionInitial(admin, {
          userId: claim.userId,
          leaseToken: claim.leaseToken,
          status: 'storage_deleted',
        });
        if (storageTransition === 'resweep_pending') {
          summary.resweepScheduled += 1;
          continue;
        }
        if (storageTransition === 'already_completed') {
          summary.alreadyCompleted += 1;
          continue;
        }
        if (
          storageTransition === 'lease_mismatch'
          || storageTransition === 'invalid_transition'
        ) {
          summary.transitionConflicts += 1;
          continue;
        }
        if (storageTransition !== 'storage_deleted') {
          throw new Error(`Unexpected storage deletion transition: ${storageTransition}.`);
        }
      }

      const authTransition = await transitionAccountDeletionInitial(admin, {
        userId: claim.userId,
        leaseToken: claim.leaseToken,
        status: 'auth_deleting',
      });
      if (authTransition === 'resweep_pending') {
        summary.resweepScheduled += 1;
        continue;
      }
      if (authTransition === 'already_completed') {
        summary.alreadyCompleted += 1;
        continue;
      }
      if (authTransition === 'lease_mismatch' || authTransition === 'invalid_transition') {
        summary.transitionConflicts += 1;
        continue;
      }
      if (authTransition !== 'auth_deleting') {
        throw new Error(`Unexpected auth deletion transition: ${authTransition}.`);
      }

      const { error: deleteError } = await admin.auth.admin.deleteUser(claim.userId);
      if (deleteError && !isMissingAuthUserError(deleteError)) throw deleteError;

      // On a normal delete the Auth trigger already moved the row and cleared
      // the lease. This explicit transition is the idempotent fallback for an
      // Auth user that was removed out-of-band before the worker reached it.
      const resweepTransition = await transitionAccountDeletionInitial(admin, {
        userId: claim.userId,
        leaseToken: claim.leaseToken,
        status: 'resweep_waiting',
      });
      if (resweepTransition === 'resweep_pending') {
        summary.resweepScheduled += 1;
      } else if (resweepTransition === 'already_completed') {
        summary.alreadyCompleted += 1;
      } else if (
        resweepTransition === 'lease_mismatch'
        || resweepTransition === 'invalid_transition'
      ) {
        summary.transitionConflicts += 1;
      } else {
        throw new Error(`Unexpected resweep transition: ${resweepTransition}.`);
      }
    } catch (cleanupError) {
      const failureTransition = await transitionAccountDeletionInitial(admin, {
        userId: claim.userId,
        leaseToken: claim.leaseToken,
        status: 'failed',
        error: cleanupError,
      });

      if (failureTransition === 'retry_scheduled') {
        summary.retryScheduled += 1;
      } else if (failureTransition === 'resweep_pending') {
        summary.resweepScheduled += 1;
      } else if (failureTransition === 'already_completed') {
        summary.alreadyCompleted += 1;
      } else {
        summary.transitionConflicts += 1;
      }
    }
  }

  return summary;
}

/**
 * Claims and processes a bounded batch. Failed object deletion is durably
 * rescheduled by the database with backoff. Expired leases are reclaimable, so
 * a terminated function invocation cannot strand a job.
 */
export async function processAccountDeletionResweeps({
  admin,
  workerId,
  limit = ACCOUNT_DELETION_RESWEEP_BATCH_LIMIT,
  leaseSeconds = ACCOUNT_DELETION_RESWEEP_LEASE_SECONDS,
}: ProcessAccountDeletionResweepsOptions): Promise<AccountDeletionResweepSummary> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Account deletion resweep limit must be between 1 and 100.');
  }

  const summary: AccountDeletionResweepSummary = {
    claimed: 0,
    completed: 0,
    alreadyCompleted: 0,
    retryScheduled: 0,
    leaseMismatches: 0,
    objectsRemoved: 0,
  };

  for (let index = 0; index < limit; index += 1) {
    const { data, error } = await admin.rpc('claim_account_deletion_resweep', {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
    if (error) {
      throw new Error(errorMessage(error, 'Could not claim account deletion resweep.'));
    }

    const claim = parseClaimedResweep(data);
    if (!claim) throw new Error('Account deletion resweep claim returned invalid data.');
    if (claim.status === 'no_work') break;

    summary.claimed += 1;
    let cleanupError: unknown = null;

    try {
      if (!claim.manifest) {
        throw new Error('Account deletion storage manifest is invalid.');
      }
      const storage = await removeAccountStorage(admin, claim.userId, claim.manifest);
      summary.objectsRemoved += storage.objectsRemoved;
    } catch (error) {
      cleanupError = error;
    }

    const finalizeStatus = await finalizeAccountDeletionResweep(admin, {
      userId: claim.userId,
      leaseToken: claim.leaseToken,
      succeeded: cleanupError === null,
      error: cleanupError,
    });

    if (finalizeStatus === 'completed') summary.completed += 1;
    if (finalizeStatus === 'already_completed') summary.alreadyCompleted += 1;
    if (finalizeStatus === 'retry_scheduled') summary.retryScheduled += 1;
    if (finalizeStatus === 'lease_mismatch') summary.leaseMismatches += 1;
  }

  return summary;
}

export async function processAccountDeletionCleanup(
  options: ProcessAccountDeletionResweepsOptions,
): Promise<AccountDeletionCleanupSummary> {
  const limit = options.limit ?? ACCOUNT_DELETION_RESWEEP_BATCH_LIMIT;
  const initial = await processAccountDeletionInitialRetries({
    ...options,
    limit,
  });
  const remaining = Math.max(0, limit - initial.claimed);
  const resweeps = remaining > 0
    ? await processAccountDeletionResweeps({
        ...options,
        limit: remaining,
      })
    : {
        claimed: 0,
        completed: 0,
        alreadyCompleted: 0,
        retryScheduled: 0,
        leaseMismatches: 0,
        objectsRemoved: 0,
      };

  if (
    initial.retryScheduled > 0
    || initial.transitionConflicts > 0
    || resweeps.retryScheduled > 0
    || resweeps.leaseMismatches > 0
  ) {
    throw new Error(
      'Account deletion cleanup batch incomplete: '
      + `${initial.retryScheduled + resweeps.retryScheduled} retry scheduled, `
      + `${initial.transitionConflicts + resweeps.leaseMismatches} transition conflict.`,
    );
  }

  return { initial, resweeps };
}

export {
  ACCOUNT_DELETION_RESWEEP_BATCH_LIMIT,
  ACCOUNT_DELETION_RESWEEP_LEASE_SECONDS,
  USER_PREFIX_BUCKETS,
};
