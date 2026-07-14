import { getStoredMediaLocation } from '@/lib/media-urls';

const USER_SCOPED_BUCKETS = new Set<string>([
  'uploads',
  'generated_images',
  'generated_videos',
  'generated_audio',
  'generation_inputs',
  'profiles',
  'template_inputs',
]);

export type UserOwnedStorageLocation = {
  bucket: string;
  filePath: string;
};

function safeDecode(value: string): string | null {
  try {
    let decoded = value;
    for (let depth = 0; depth < 5; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    }
    // Reject path components that remain recursively encoded rather than
    // guessing how many decoding layers a downstream component may apply.
    return /%[a-f0-9]{2}/i.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

export function isCanonicalStorageObjectPath(filePath: string): boolean {
  const decoded = safeDecode(filePath);
  if (!decoded || decoded.startsWith('/') || decoded.includes('\\')) return false;
  const segments = decoded.split('/');
  return segments.length >= 2
    && segments.every((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
}

export function isStorageObjectOwnedByUser(filePath: string, userId: string): boolean {
  const decoded = safeDecode(filePath);
  return Boolean(
    decoded
    && isCanonicalStorageObjectPath(filePath)
    && decoded.split('/')[0] === userId,
  );
}

export function isUserScopedStorageBucket(bucket: string): boolean {
  return USER_SCOPED_BUCKETS.has(bucket);
}

export function getUserOwnedStoredMediaLocation(
  storagePath: string,
  userId: string,
): UserOwnedStorageLocation | null {
  const location = getStoredMediaLocation(storagePath);
  if (!location || !isUserScopedStorageBucket(location.bucket)) return null;
  return isStorageObjectOwnedByUser(location.filePath, userId) ? location : null;
}

export function assertUserOwnedStorageLocation(
  location: UserOwnedStorageLocation,
  userId: string,
): void {
  if (!isUserScopedStorageBucket(location.bucket) || !isStorageObjectOwnedByUser(location.filePath, userId)) {
    throw new Error('Storage object does not belong to the authenticated user.');
  }
}
