import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { retainPurchasedUnlockFiles } from '@/lib/account-deletion-resource-retention';
import { recordClaimedIdentityFingerprints } from '@/lib/account-identity-fingerprint';
import { parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';
import { iterateStorageObjectsV2, StorageListV2Error } from '@/lib/storage-list-v2';

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
  ownerUserIds: string[];
  userPrefixBuckets: Array<(typeof USER_PREFIX_BUCKETS)[number]>;
  showcaseMediaPaths: string[];
  templateAssetPrefixes: string[];
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
  recordClaimedFingerprints?: typeof recordClaimedIdentityFingerprints;
};

type ProcessAccountDeletionResweepsOptions = {
  admin: SupabaseClient;
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
};

type ProcessAccountDeletionInitialRetriesOptions = ProcessAccountDeletionResweepsOptions & {
  retainPurchasedFiles?: typeof retainPurchasedUnlockFiles;
  recordClaimedFingerprints?: typeof recordClaimedIdentityFingerprints;
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
  const status = String(error.status ?? error.statusCode ?? '');
  return status === '404';
}

function isMissingAuthUserError(error: unknown) {
  if (!isRecord(error)) return false;
  const status = String(error.status ?? error.statusCode ?? '');
  return status === '404';
}

function isAlreadyRevokedSessionError(error: unknown) {
  if (!isRecord(error)) return false;
  const status = String(error.status ?? error.statusCode ?? '');
  return status === '401' || status === '403' || status === '404';
}

function exactStringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || !item || item !== item.trim())
  ) return null;
  return [...new Set(value as string[])];
}

function parseCanonicalManifestShowcasePath(storagePath: string): string | null {
  const canonicalPath = parseCanonicalStorageObjectPath(storagePath, { minimumSegments: 3 });
  if (!canonicalPath) return null;
  const [scope, resourceId] = canonicalPath.split('/');
  return (scope === 'showcase' || scope === 'posts') && UUID_PATTERN.test(resourceId ?? '')
    ? canonicalPath
    : null;
}

export function parseAccountDeletionStorageManifest(
  value: unknown,
): AccountDeletionStorageManifest | null {
  if (!isRecord(value)) return null;
  if (
    !Array.isArray(value.owner_user_ids)
    || !Array.isArray(value.user_prefix_buckets)
    || !Array.isArray(value.showcase_media_paths)
    || !Array.isArray(value.template_asset_prefixes)
  ) {
    return null;
  }

  const allowedBuckets = new Set<string>(USER_PREFIX_BUCKETS);
  const ownerUserIds = exactStringArray(value.owner_user_ids);
  const rawUserPrefixBuckets = exactStringArray(value.user_prefix_buckets);
  const showcaseMediaPaths = exactStringArray(value.showcase_media_paths);
  const templateAssetPrefixes = exactStringArray(value.template_asset_prefixes);
  if (!ownerUserIds || !rawUserPrefixBuckets || !showcaseMediaPaths || !templateAssetPrefixes) {
    return null;
  }
  const canonicalShowcaseMediaPaths = showcaseMediaPaths.map(parseCanonicalManifestShowcasePath);
  const canonicalTemplateAssetPrefixes = templateAssetPrefixes.map((prefix) =>
    parseCanonicalStorageObjectPath(prefix, { minimumSegments: 1 }));

  if (
    ownerUserIds.length === 0
    || ownerUserIds.some((userId) => !UUID_PATTERN.test(userId))
    || rawUserPrefixBuckets.length !== USER_PREFIX_BUCKETS.length
    || rawUserPrefixBuckets.some((bucket) => !allowedBuckets.has(bucket))
    || canonicalShowcaseMediaPaths.some((storagePath) => !storagePath)
    || canonicalTemplateAssetPrefixes.some(
      (prefix) => !prefix || !TEMPLATE_ID_PATTERN.test(prefix),
    )
  ) {
    return null;
  }

  return {
    ownerUserIds,
    userPrefixBuckets:
      rawUserPrefixBuckets as Array<(typeof USER_PREFIX_BUCKETS)[number]>,
    showcaseMediaPaths: canonicalShowcaseMediaPaths as string[],
    templateAssetPrefixes: canonicalTemplateAssetPrefixes as string[],
  };
}

async function listUserFiles(
  admin: SupabaseClient,
  bucket: string,
  prefix: string,
  expectedRootSegment: string,
): Promise<string[]> {
  const canonicalPrefix = parseCanonicalStorageObjectPath(prefix, {
    minimumSegments: 1,
    ownerUserId: expectedRootSegment,
  });
  if (!canonicalPrefix) {
    throw new Error(`Could not inspect ${bucket} account files.`);
  }
  const files: string[] = [];

  try {
    for await (const entry of iterateStorageObjectsV2(admin, {
      bucket,
      prefix: canonicalPrefix,
      pageSize: 1000,
    })) {
      const path = parseCanonicalStorageObjectPath(entry.path, {
        ownerUserId: expectedRootSegment,
      });
      if (!path) throw new Error(`Could not inspect ${bucket} account files.`);
      files.push(path);
    }
  } catch (error) {
    if (error instanceof StorageListV2Error && isMissingBucketError(error.storageError)) {
      return files;
    }
    if (error instanceof Error && error.message === `Could not inspect ${bucket} account files.`) {
      throw error;
    }
    throw new Error(`Could not inspect ${bucket} account files.`);
  }

  return files;
}

async function assertStoragePathsAbsent(
  admin: SupabaseClient,
  bucket: string,
  paths: string[],
  expectedRootSegment?: string,
) {
  const pathsByParent = new Map<string, Set<string>>();

  for (const storagePath of paths) {
    const canonicalPath = parseCanonicalStorageObjectPath(
      storagePath,
      expectedRootSegment ? { ownerUserId: expectedRootSegment } : {},
    );
    if (!canonicalPath) {
      throw new Error(`Could not verify ${bucket} account files.`);
    }

    const separatorIndex = canonicalPath.lastIndexOf('/');
    if (separatorIndex <= 0) {
      throw new Error(`Could not verify ${bucket} account files.`);
    }
    const parent = canonicalPath.slice(0, separatorIndex);
    const existing = pathsByParent.get(parent) ?? new Set<string>();
    existing.add(canonicalPath);
    pathsByParent.set(parent, existing);
  }

  for (const [parent, expectedAbsent] of pathsByParent) {
    const rootSegment = expectedRootSegment ?? parent.split('/')[0];
    if (!rootSegment) throw new Error(`Could not verify ${bucket} account files.`);
    const remainingPaths = await listUserFiles(admin, bucket, parent, rootSegment);
    if (remainingPaths.some((path) => expectedAbsent.has(path))) {
      throw new Error(`Could not verify ${bucket} account files were removed.`);
    }
  }
}

async function assertAccountStorageEmpty(
  admin: SupabaseClient,
  manifest: AccountDeletionStorageManifest,
) {
  for (const ownerUserId of manifest.ownerUserIds) {
    for (const bucket of manifest.userPrefixBuckets) {
      const remainingPaths = await listUserFiles(admin, bucket, ownerUserId, ownerUserId);
      if (remainingPaths.length > 0) {
        throw new Error(`Could not verify ${bucket} account files were removed.`);
      }
    }
  }

  await assertStoragePathsAbsent(admin, 'showcase_media', manifest.showcaseMediaPaths);

  for (const templatePrefix of manifest.templateAssetPrefixes) {
    const remainingPaths = await listUserFiles(
      admin,
      'template_assets',
      templatePrefix,
      templatePrefix,
    );
    if (remainingPaths.length > 0) {
      throw new Error('Could not verify template_assets account files were removed.');
    }
  }
}

export async function removeAccountStorage(
  admin: SupabaseClient,
  userId: string,
  manifest: AccountDeletionStorageManifest,
): Promise<StorageCleanupSummary> {
  let bucketsScanned = 0;
  let objectsRemoved = 0;

  async function removePaths(bucket: string, paths: string[], expectedRootSegment?: string) {
    const canonicalPaths = paths.map((storagePath) => parseCanonicalStorageObjectPath(
      storagePath,
      expectedRootSegment ? { ownerUserId: expectedRootSegment } : {},
    ));
    if (canonicalPaths.some((storagePath) => !storagePath)) {
      throw new Error(`Could not remove ${bucket} account files.`);
    }

    for (let index = 0; index < canonicalPaths.length; index += 100) {
      const batch = canonicalPaths.slice(index, index + 100) as string[];
      const { error } = await admin.storage.from(bucket).remove(batch);
      if (error && !isMissingBucketError(error)) {
        throw new Error(`Could not remove ${bucket} account files.`);
      }
      if (!error) {
        await assertStoragePathsAbsent(admin, bucket, batch, expectedRootSegment);
      }
      objectsRemoved += batch.length;
    }
  }

  if (!manifest.ownerUserIds.includes(userId)) {
    throw new Error('Account deletion manifest does not include its target identity.');
  }

  for (const ownerUserId of manifest.ownerUserIds) {
    if (!UUID_PATTERN.test(ownerUserId)) {
      throw new Error('Account deletion manifest contains an invalid owner identity.');
    }
    for (const bucket of manifest.userPrefixBuckets) {
      bucketsScanned += 1;
      const paths = await listUserFiles(admin, bucket, ownerUserId, ownerUserId);
      await removePaths(bucket, paths, ownerUserId);
    }
  }

  bucketsScanned += 1;
  const canonicalShowcasePaths = manifest.showcaseMediaPaths.map(parseCanonicalManifestShowcasePath);
  if (canonicalShowcasePaths.some((storagePath) => !storagePath)) {
    throw new Error('Account deletion manifest contains an invalid showcase path.');
  }
  await removePaths('showcase_media', canonicalShowcasePaths as string[]);

  for (const templatePrefix of manifest.templateAssetPrefixes) {
    const canonicalPrefix = parseCanonicalStorageObjectPath(templatePrefix, { minimumSegments: 1 });
    if (!canonicalPrefix || !TEMPLATE_ID_PATTERN.test(canonicalPrefix)) {
      throw new Error('Account deletion manifest contains an invalid template prefix.');
    }
    bucketsScanned += 1;
    const paths = await listUserFiles(admin, 'template_assets', canonicalPrefix, canonicalPrefix);
    await removePaths('template_assets', paths, canonicalPrefix);
  }

  // A successful delete response alone is not evidence that Storage removed
  // every requested object. Re-list every durable owner prefix before callers
  // are allowed to advance to Auth deletion. The delayed pass performs the
  // same verification after all issued signed-upload capabilities have aged
  // out, closing the window in which a late upload could recreate an object.
  await assertAccountStorageEmpty(admin, manifest);

  return { bucketsScanned, objectsRemoved };
}

async function retainPurchasedFilesForOwners(
  admin: SupabaseClient,
  manifest: AccountDeletionStorageManifest,
  retainPurchasedFiles: typeof retainPurchasedUnlockFiles,
) {
  for (const ownerUserId of manifest.ownerUserIds) {
    await retainPurchasedFiles(admin, ownerUserId);
  }
}

async function deleteLinkedAuthUsersGuestFirst(
  admin: SupabaseClient,
  targetUserId: string,
  ownerUserIds: string[],
): Promise<{ targetAlreadyMissing: boolean }> {
  if (!ownerUserIds.includes(targetUserId)) {
    throw new Error('Account deletion manifest does not include its target identity.');
  }

  const deletionOrder = [
    ...ownerUserIds.filter((userId) => userId !== targetUserId),
    targetUserId,
  ];
  let targetAlreadyMissing = false;

  for (const userId of deletionOrder) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    const alreadyMissing = Boolean(error && isMissingAuthUserError(error));
    if (error && !alreadyMissing) throw error;
    if (userId === targetUserId) targetAlreadyMissing = alreadyMissing;
  }

  return { targetAlreadyMissing };
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
  recordClaimedFingerprints = recordClaimedIdentityFingerprints,
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

  // Close reservation issuance/finalization before copying retained sources;
  // otherwise a legacy signed capability could race the source snapshot.
  await markAccountDeletedUploadReservations(admin, preparation.manifest.ownerUserIds);
  // Retention is a hard gate: never sweep creator-prefixed storage or delete
  // Auth until every purchased revision has a durable neutral copy.
  await retainPurchasedFilesForOwners(admin, preparation.manifest, retainPurchasedFiles);
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

  // The durable claim ledger is written while the auth rows still exist:
  // credit_grants cascades away with auth.users, and identifiers changed since
  // the claim (a swapped email, a newly linked provider) only exist on the live
  // rows. Idempotent, so the resweep retry path repeats it safely; a failure
  // throws and leaves the job retryable rather than deleting Auth unrecorded.
  await recordClaimedFingerprints(admin, preparation.manifest.ownerUserIds);

  const authDeletingStatus = await markAccountDeletionStage(admin, userId, 'auth_deleting');
  if (authDeletingStatus === 'already_completed' || authDeletingStatus === 'resweep_pending') {
    return {
      alreadyCompleted: authDeletingStatus === 'already_completed',
      authUserAlreadyMissing: true,
      cleanupPending: authDeletingStatus === 'resweep_pending',
      storage,
    };
  }

  const { targetAlreadyMissing: authUserAlreadyMissing } =
    await deleteLinkedAuthUsersGuestFirst(
      admin,
      userId,
      preparation.manifest.ownerUserIds,
    );

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

async function markAccountDeletedUploadReservations(
  admin: SupabaseClient,
  ownerUserIds: string[],
) {
  const { data, error } = await admin.rpc('mark_account_deleted_upload_reservations', {
    p_owner_user_ids: ownerUserIds,
  });
  const marked = isRecord(data) ? data.marked : null;

  if (
    error
    || !isRecord(data)
    || data.status !== 'ok'
    || typeof marked !== 'number'
    || !Number.isSafeInteger(marked)
    || marked < 0
  ) {
    throw new Error(
      errorMessage(error, 'Could not mark deleted-account upload reservations.'),
    );
  }
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
  recordClaimedFingerprints = recordClaimedIdentityFingerprints,
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

        await markAccountDeletedUploadReservations(admin, claim.manifest.ownerUserIds);
        await retainPurchasedFilesForOwners(admin, claim.manifest, retainPurchasedFiles);
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
      } else {
        if (!claim.manifest) {
          throw new Error('Account deletion storage manifest is invalid.');
        }
        // Rolling deployments may reclaim a job that reached auth_deleting
        // before reservation tombstones existed. Close that compatibility gap
        // idempotently before allowing the destructive Auth transition.
        await markAccountDeletedUploadReservations(admin, claim.manifest.ownerUserIds);
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

      if (!claim.manifest) {
        throw new Error('Account deletion storage manifest is invalid.');
      }
      // Same ledger write as the immediate pass: a job that crashed before the
      // Auth step lands here with its auth rows still present, so the retry
      // must record fingerprints before it deletes them.
      await recordClaimedFingerprints(admin, claim.manifest.ownerUserIds);
      await deleteLinkedAuthUsersGuestFirst(
        admin,
        claim.userId,
        claim.manifest.ownerUserIds,
      );

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
      // The service-only tombstone takes the shared reservation lock before
      // the first Storage listing. This closes application-side finalization
      // and consumption races; the subsequent canonical sweep then proves the
      // target and every linked guest prefix empty. The RPC is idempotent and
      // neither releases capacity nor deletes durable reservation rows.
      await markAccountDeletedUploadReservations(admin, claim.manifest.ownerUserIds);
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
