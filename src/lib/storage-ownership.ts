export const USER_SCOPED_STORAGE_BUCKETS = new Set<string>([
  'uploads',
  'generated_images',
  'generated_videos',
  'generated_audio',
  'generation_inputs',
  'profiles',
  'post_resource_files',
  'template_inputs',
]);

export type UserOwnedStorageLocation = {
  bucket: string;
  filePath: string;
};

const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/i;
const ENCODED_BYTE = /%[a-f0-9]{2}/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Decode a storage path to the one representation privileged storage calls use.
 *
 * Encoded separators are rejected rather than interpreted. Otherwise two
 * components can disagree about segment boundaries (for example, an owner
 * check can see `user%252fother` while Storage eventually sees
 * `user/other`). The check is repeated before every decode so double-encoded
 * separators are rejected too.
 */
export function decodeCanonicalStoragePath(value: string): string | null {
  if (!value || value !== value.trim() || CONTROL_CHARACTER.test(value)) return null;

  try {
    let decoded = value;
    for (let depth = 0; depth < 5; depth += 1) {
      if (ENCODED_PATH_SEPARATOR.test(decoded)) return null;
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    }
    // Reject path components that remain recursively encoded rather than
    // guessing how many decoding layers a downstream component may apply.
    return ENCODED_BYTE.test(decoded) || ENCODED_PATH_SEPARATOR.test(decoded)
      ? null
      : decoded;
  } catch {
    return null;
  }
}

export function parseCanonicalStorageObjectPath(
  filePath: string,
  options: { ownerUserId?: string; minimumSegments?: number } = {},
): string | null {
  const decoded = decodeCanonicalStoragePath(filePath);
  if (
    !decoded
    || decoded.startsWith('/')
    || decoded.endsWith('/')
    || decoded.includes('\\')
    || decoded.includes('://')
    || CONTROL_CHARACTER.test(decoded)
  ) return null;

  const segments = decoded.split('/');
  if (
    segments.length < (options.minimumSegments ?? 2)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) return null;

  if (options.ownerUserId !== undefined) {
    // An encoded owner segment is not canonical even if it decodes to the
    // current user. This prevents the ownership boundary itself from changing
    // representation between validation and the Storage request.
    const rawOwner = filePath.split('/')[0];
    if (rawOwner !== options.ownerUserId || segments[0] !== options.ownerUserId) return null;
  }

  return decoded;
}

export function parseCanonicalStorageLocation(
  storagePath: string,
  options: {
    allowedBuckets?: ReadonlySet<string> | readonly string[];
    ownerUserId?: string;
  } = {},
): UserOwnedStorageLocation | null {
  const decoded = decodeCanonicalStoragePath(storagePath);
  if (!decoded || decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('://')) {
    return null;
  }

  const separatorIndex = decoded.indexOf('/');
  if (separatorIndex <= 0) return null;
  const rawSeparatorIndex = storagePath.indexOf('/');
  if (rawSeparatorIndex <= 0) return null;

  const bucket = decoded.slice(0, separatorIndex);
  // Bucket names are an authorization input too. Do not allow their spelling
  // to change through percent-decoding.
  if (storagePath.slice(0, rawSeparatorIndex) !== bucket) return null;

  const allowedBuckets = options.allowedBuckets;
  if (allowedBuckets) {
    if (!new Set<string>(allowedBuckets).has(bucket)) return null;
  }

  const rawFilePath = storagePath.slice(rawSeparatorIndex + 1);
  const filePath = parseCanonicalStorageObjectPath(
    rawFilePath,
    { ownerUserId: options.ownerUserId },
  );
  return filePath ? { bucket, filePath } : null;
}

export function isCanonicalStorageObjectPath(filePath: string): boolean {
  return parseCanonicalStorageObjectPath(filePath) !== null;
}

export function isStorageObjectOwnedByUser(filePath: string, userId: string): boolean {
  return parseCanonicalStorageObjectPath(filePath, { ownerUserId: userId }) !== null;
}

export function isUserScopedStorageBucket(bucket: string): boolean {
  return USER_SCOPED_STORAGE_BUCKETS.has(bucket);
}

export function getUserOwnedStoredMediaLocation(
  storagePath: string,
  userId: string,
  options: { allowedBuckets?: ReadonlySet<string> | readonly string[] } = {},
): UserOwnedStorageLocation | null {
  return getCanonicalStoredMediaLocation(storagePath, {
    allowedBuckets: options.allowedBuckets,
    ownerUserId: userId,
  });
}

export function getCanonicalStoredMediaLocation(
  storagePath: string,
  options: {
    allowedBuckets?: ReadonlySet<string> | readonly string[];
    ownerUserId?: string;
  } = {},
): UserOwnedStorageLocation | null {
  const allowedBuckets = options.allowedBuckets ?? USER_SCOPED_STORAGE_BUCKETS;
  const direct = parseCanonicalStorageLocation(storagePath, {
    allowedBuckets,
    ownerUserId: options.ownerUserId,
  });
  if (direct) return direct;

  // Never derive the authorization path from URL.pathname. WHATWG URL parsing
  // normalizes raw and encoded dot segments (and treats backslashes as path
  // separators), erasing the exact evidence this boundary must reject. Parse
  // and retain the raw path from the original string, while still constructing
  // URL to validate its scheme/authority shape.
  try {
    const url = new URL(storagePath);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username
      || url.password
      || storagePath.includes('\\')
    ) return null;

    const schemeSeparator = storagePath.indexOf('://');
    if (schemeSeparator <= 0) return null;
    const authorityStart = schemeSeparator + 3;
    const pathStart = storagePath.indexOf('/', authorityStart);
    if (pathStart < 0) return null;
    const queryStart = storagePath.indexOf('?', pathStart);
    const fragmentStart = storagePath.indexOf('#', pathStart);
    const pathEnd = [queryStart, fragmentStart]
      .filter((index) => index >= 0)
      .reduce((earliest, index) => Math.min(earliest, index), storagePath.length);
    const rawPath = storagePath.slice(pathStart, pathEnd);
    const match = rawPath.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);
    if (!match) return null;
    return parseCanonicalStorageLocation(`${match[1]}/${match[2]}`, {
      allowedBuckets,
      ownerUserId: options.ownerUserId,
    });
  } catch {
    return null;
  }
}

export function assertUserOwnedStorageLocation(
  location: UserOwnedStorageLocation,
  userId: string,
): void {
  if (
    !isUserScopedStorageBucket(location.bucket)
    || !parseCanonicalStorageObjectPath(location.filePath, { ownerUserId: userId })
  ) {
    throw new Error('Storage object does not belong to the authenticated user.');
  }
}
