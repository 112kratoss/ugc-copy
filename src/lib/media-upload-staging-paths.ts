/**
 * Path vocabulary for the shared `uploads` staging bucket.
 *
 * Deliberately dependency-free so both the request path (which is `server-only`)
 * and the ops backfill (which runs under tsx, where `server-only` does not
 * resolve) can agree on what a staged path is. Everything here is pure.
 */

export const MEDIA_UPLOAD_INTENTS_TABLE = 'media_upload_intents';

/**
 * Ceiling on the legacy-generation scan. Hitting it means the protected set may
 * be truncated, which callers must treat as "cannot prove anything is safe".
 */
export const LEGACY_GUARD_SCAN_LIMIT = 1000;

/**
 * Callers hold the staging path in two shapes: the sign response and the client
 * payloads use the prefixed `uploads/...` form, while the post services strip
 * the prefix early so the value can go straight to storage.remove(). Rows are
 * stored bucket-relative so the sweep never has to reconstruct anything.
 */
export function normalizeUploadIntentPath(storagePath: string): string {
  return storagePath.trim().replace(/^\/+/, '').replace(/^uploads\//, '');
}

/**
 * Every `uploads/` path named anywhere in a workflow settings blob.
 *
 * Walks parsed values rather than the raw `::text` form so JSON escaping cannot
 * hide a path, and matches "contains" rather than "starts with" so a staged path
 * embedded in a stored signed URL still counts. This deliberately
 * over-approximates: the reclaim guard protects a superset of what repair
 * understands, so a settings shape the legacy builder does not parse still keeps
 * its bytes.
 *
 * Returns bucket-relative paths, matching `media_upload_intents.storage_path`.
 */
export function extractUploadsPathsFromWorkflowSettings(workflowSettings: unknown): string[] {
  const found = new Set<string>();

  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || value == null) {
      return;
    }

    if (typeof value === 'string') {
      const marker = value.indexOf('uploads/');
      if (marker === -1) {
        return;
      }

      // Must go through the same normalization the intent rows were written
      // with. The sweep compares these two sets by exact string, so any
      // asymmetry here means a guarded file silently fails to match its row and
      // gets deleted while a generation is still reading it.
      const candidate = normalizeUploadIntentPath(
        value.slice(marker + 'uploads/'.length).split(/[?#]/)[0],
      );
      // `{userId}/{uploadId}-{fileName}` -- anything shorter is not a real
      // staged object and must not shadow one.
      if (candidate.split('/').filter(Boolean).length >= 2) {
        found.add(candidate);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry, depth + 1);
      }
      return;
    }

    if (typeof value === 'object') {
      for (const entry of Object.values(value as Record<string, unknown>)) {
        visit(entry, depth + 1);
      }
    }
  };

  visit(workflowSettings, 0);
  return Array.from(found);
}
