import type { SupabaseClient } from '@supabase/supabase-js';

export type StorageObjectV2 = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
};

export class StorageListV2Error extends Error {
  readonly storageError: unknown;

  constructor(message: string, storageError?: unknown) {
    super(message);
    this.name = 'StorageListV2Error';
    this.storageError = storageError;
  }
}

function normalizedPrefix(prefix: string): string {
  if (!prefix) return '';
  return `${prefix.replace(/^\/+|\/+$/gu, '')}/`;
}

/**
 * Iterate a flat Storage prefix with the cursor-based list-v2 API.
 *
 * `listV2` avoids offset work as a bucket grows and returns folders separately,
 * so callers receive only real objects and do not need recursive folder scans.
 * A broken/repeated cursor fails closed instead of creating an infinite worker.
 */
export async function* iterateStorageObjectsV2(
  client: SupabaseClient,
  options: {
    bucket: string;
    prefix?: string;
    pageSize?: number;
  },
): AsyncGenerator<StorageObjectV2> {
  const pageSize = options.pageSize ?? 1000;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new StorageListV2Error('Storage list-v2 page size must be between 1 and 1000.');
  }

  const prefix = normalizedPrefix(options.prefix ?? '');
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  for (;;) {
    const { data, error } = await client.storage.from(options.bucket).listV2({
      prefix,
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
      with_delimiter: false,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) {
      throw new StorageListV2Error(
        `Could not list Storage bucket ${options.bucket}.`,
        error,
      );
    }

    for (const object of data.objects) {
      // Storage API deployments may omit the experimental `key` field and
      // return the full bucket-relative object path in `name`. Prefer `key`
      // when present, otherwise treat `name` as the path rather than prefixing
      // it a second time.
      const rawPath = object.key || object.name;
      const path = rawPath.replace(/^\/+/, '');
      if (!path || (prefix && !path.startsWith(prefix))) {
        throw new StorageListV2Error(
          `Storage returned an object outside ${options.bucket}/${prefix}.`,
        );
      }
      yield {
        id: object.id,
        name: object.name,
        path,
        createdAt: object.created_at,
        updatedAt: object.updated_at,
        metadata: object.metadata as Record<string, unknown> | null,
      };
    }

    if (!data.hasNext) return;
    const nextCursor = data.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new StorageListV2Error(
        `Storage returned an invalid cursor for ${options.bucket}/${prefix}.`,
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}
