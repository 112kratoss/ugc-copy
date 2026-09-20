/** Versioned, scope-bound continuation; authorization remains in each query. */
export type MediaLibraryBoundary = { createdAt: string; id: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export function encodeMediaLibraryCursor(scope: string, boundary: MediaLibraryBoundary): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, ...boundary })).toString('base64url');
}

export function decodeMediaLibraryCursor(value: string, scope: string): MediaLibraryBoundary | null {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const row = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (row.v !== 1 || row.scope !== scope || typeof row.id !== 'string' || !UUID.test(row.id)
      || typeof row.createdAt !== 'string' || !TIMESTAMP.test(row.createdAt)
      || !Number.isFinite(Date.parse(row.createdAt))) return null;
    // Preserve Postgres microseconds; converting through Date loses the boundary.
    return { id: row.id, createdAt: row.createdAt };
  } catch { return null; }
}

export function mediaLibraryBoundaryFilter(boundary: MediaLibraryBoundary, idColumn: string, ascendingId = false): string {
  return `created_at.lt.${boundary.createdAt},and(created_at.eq.${boundary.createdAt},${idColumn}.${ascendingId ? 'gt' : 'lt'}.${boundary.id})`;
}
