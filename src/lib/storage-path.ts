/**
 * Splits a stored path — `bucket/path/to/object` — into the two halves the
 * Storage API asks for separately.
 *
 * A leaf on purpose: no `server-only`, no Supabase client, no Next import. The
 * preview pipeline and the backfill scripts both need this parse, and a script
 * cannot load a module that reaches `server-only` (which is what pulled
 * `storage-upload-body` in when this lived beside the uploader).
 *
 * Returns null for anything that is not a bucket plus a non-empty path, so a
 * bare filename or a trailing slash is refused rather than silently addressed
 * to the wrong bucket.
 */
export function getStorageLocation(storagePath: string) {
  const normalized = storagePath.replace(/^\/+/, '');
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
    return null;
  }

  return {
    bucket: normalized.slice(0, slashIndex),
    filePath: normalized.slice(slashIndex + 1),
  };
}
