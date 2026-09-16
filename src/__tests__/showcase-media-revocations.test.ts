import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { removeGenerationShowcaseDerivative } from '@/lib/generation-post-media';
import {
  hasPendingShowcaseMediaRevocations,
  processShowcaseMediaRevocations,
  showcaseMediaRevocationRetryDelayMs,
  ShowcaseMediaRevocationsStuckError,
} from '@/lib/showcase-media-revocations';

type Row = Record<string, unknown>;

const GENERATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_GENERATION_ID = '22222222-2222-4222-8222-222222222222';
const QUEUED_PATH = `showcase/${GENERATION_ID}/cover.abc123.jpg`;
const NOW = new Date('2026-09-16T10:00:00.000Z');

function queued(overrides: Row = {}): Row {
  return {
    id: 'rev-1',
    generation_id: GENERATION_ID,
    post_id: 'post-1',
    showcase_asset_path: QUEUED_PATH,
    attempt_count: 0,
    next_attempt_at: '2026-09-16T09:50:00.000Z',
    created_at: '2026-09-16T09:50:00.000Z',
    ...overrides,
  };
}

/**
 * A small in-memory Supabase: filters really filter, deletes really delete, and
 * `exists` answers from the set of objects still in the bucket.
 */
function createClient({
  revocations,
  generations = [{ id: GENERATION_ID, showcase_asset_path: null }],
  posts = [{ id: 'post-1', visibility: 'private', showcase_asset_path: null }],
  objects = [QUEUED_PATH],
}: {
  revocations: Row[];
  generations?: Row[];
  posts?: Row[];
  objects?: string[];
}) {
  const tables: Record<string, Row[]> = {
    showcase_media_revocations: revocations,
    generations,
    posts,
  };
  const bucket = new Set(objects);
  const updates: Array<{ id: unknown; values: Row }> = [];

  const from = (table: string) => {
    if (!(table in tables)) throw new Error(`Unexpected table: ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    let operation: 'select' | 'update' | 'delete' = 'select';
    let headCount = false;
    let limit: number | null = null;
    let values: Row = {};
    const matches = () => tables[table].filter((row) => filters.every((filter) => filter(row)));
    const execute = async () => {
      if (operation === 'delete') {
        const doomed = new Set(matches());
        tables[table] = tables[table].filter((row) => !doomed.has(row));
        return { data: null, error: null };
      }
      if (operation === 'update') {
        for (const row of matches()) {
          Object.assign(row, values);
          updates.push({ id: row.id, values });
        }
        return { data: null, error: null };
      }
      const rows = matches();
      return headCount
        ? { data: null, count: rows.length, error: null }
        : { data: limit === null ? rows : rows.slice(0, limit), error: null };
    };
    const builder = {
      select: (_columns: string, options?: { head?: boolean }) => {
        headCount = options?.head === true;
        return builder;
      },
      update: (next: Row) => {
        operation = 'update';
        values = next;
        return builder;
      },
      delete: () => {
        operation = 'delete';
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      lte: (column: string, value: string) => {
        filters.push((row) => String(row[column]) <= value);
        return builder;
      },
      lt: (column: string, value: string) => {
        filters.push((row) => String(row[column]) < value);
        return builder;
      },
      order: () => builder,
      limit: (count: number) => {
        limit = count;
        return builder;
      },
      maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
      then: (
        resolve: (value: Awaited<ReturnType<typeof execute>>) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => execute().then(resolve, reject),
    };
    return builder;
  };

  const storage = {
    from: () => ({
      exists: async (path: string) => ({ data: bucket.has(path), error: null }),
    }),
  };

  return {
    client: { from, storage } as unknown as SupabaseClient,
    bucket,
    tables,
    updates,
  };
}

function removingFrom(bucket: Set<string>) {
  return vi.fn<typeof removeGenerationShowcaseDerivative>(async ({ showcaseAssetPath }) => {
    if (showcaseAssetPath) bucket.delete(showcaseAssetPath);
    return {
      removed: true,
      removedPaths: showcaseAssetPath ? [showcaseAssetPath] : [],
      removedMediaRows: 0,
      error: null,
    };
  });
}

describe('processShowcaseMediaRevocations', () => {
  it('removes a queued copy whose post stayed private, with that post’s legacy media rows', async () => {
    const { client, bucket, tables } = createClient({ revocations: [queued()] });
    const removeDerivative = removingFrom(bucket);

    const summary = await processShowcaseMediaRevocations(client, { now: NOW, removeDerivative });

    expect(summary).toEqual({ due: 1, removed: 1, stillServing: 0, outsidePrefix: 0, rescheduled: 0, stuck: 0 });
    expect(removeDerivative).toHaveBeenCalledWith(expect.objectContaining({
      generationId: GENERATION_ID,
      showcaseAssetPath: QUEUED_PATH,
      postId: 'post-1',
    }));
    expect(bucket.has(QUEUED_PATH)).toBe(false);
    expect(tables.showcase_media_revocations).toEqual([]);
  });

  it('leaves a copy the post serves again, and settles the row', async () => {
    const { client, bucket, tables } = createClient({
      revocations: [queued()],
      posts: [{ id: 'post-1', visibility: 'public', showcase_asset_path: QUEUED_PATH }],
    });
    const removeDerivative = removingFrom(bucket);

    const summary = await processShowcaseMediaRevocations(client, { now: NOW, removeDerivative });

    expect(summary).toMatchObject({ stillServing: 1, removed: 0 });
    expect(removeDerivative).not.toHaveBeenCalled();
    expect(bucket.has(QUEUED_PATH)).toBe(true);
    expect(tables.showcase_media_revocations).toEqual([]);
  });

  it('keeps a republished post’s live media rows while removing its old copy', async () => {
    const livePath = `showcase/${GENERATION_ID}/cover.def456.jpg`;
    const { client, bucket } = createClient({
      revocations: [queued()],
      generations: [{ id: GENERATION_ID, showcase_asset_path: livePath }],
      posts: [{ id: 'post-1', visibility: 'public', showcase_asset_path: livePath }],
      objects: [QUEUED_PATH, livePath],
    });
    const removeDerivative = removingFrom(bucket);

    await processShowcaseMediaRevocations(client, { now: NOW, removeDerivative });

    expect(removeDerivative).toHaveBeenCalledWith(expect.objectContaining({
      showcaseAssetPath: QUEUED_PATH,
      postId: null,
    }));
    expect([...bucket]).toEqual([livePath]);
  });

  it('removes the copy a deleted post left behind', async () => {
    const { client, bucket } = createClient({ revocations: [queued()], posts: [] });
    const removeDerivative = removingFrom(bucket);

    const summary = await processShowcaseMediaRevocations(client, { now: NOW, removeDerivative });

    expect(summary.removed).toBe(1);
    expect(removeDerivative).toHaveBeenCalledWith(expect.objectContaining({ postId: null }));
  });

  it('never removes an object outside the generation’s own prefix', async () => {
    const foreignPath = `showcase/${OTHER_GENERATION_ID}/cover.jpg`;
    const { client, bucket, tables } = createClient({
      revocations: [queued({ showcase_asset_path: foreignPath })],
      objects: [foreignPath],
    });
    const removeDerivative = removingFrom(bucket);

    const summary = await processShowcaseMediaRevocations(client, { now: NOW, removeDerivative });

    expect(summary).toMatchObject({ outsidePrefix: 1, removed: 0 });
    expect(removeDerivative).not.toHaveBeenCalled();
    expect(bucket.has(foreignPath)).toBe(true);
    expect(tables.showcase_media_revocations).toEqual([]);
  });

  it('reschedules a failed delete with backoff and keeps the error', async () => {
    const { client, tables, updates } = createClient({ revocations: [queued({ attempt_count: 2 })] });
    const removeDerivative = vi.fn<typeof removeGenerationShowcaseDerivative>(async () => ({
      removed: false,
      removedPaths: [],
      removedMediaRows: 0,
      error: { message: 'storage unavailable' },
    }));

    const summary = await processShowcaseMediaRevocations(client, { now: NOW, removeDerivative });

    expect(summary).toMatchObject({ rescheduled: 1, removed: 0 });
    expect(updates).toEqual([{
      id: 'rev-1',
      values: {
        attempt_count: 3,
        next_attempt_at: '2026-09-16T10:40:00.000Z',
        last_error: 'storage unavailable',
      },
    }]);
    expect(tables.showcase_media_revocations).toHaveLength(1);
  });

  it('retries when the object is still there after a delete that reported success', async () => {
    const { client, updates } = createClient({ revocations: [queued()] });
    const removeDerivative = vi.fn<typeof removeGenerationShowcaseDerivative>(async () => ({
      removed: true,
      removedPaths: [QUEUED_PATH],
      removedMediaRows: 0,
      error: null,
    }));

    const summary = await processShowcaseMediaRevocations(client, { now: NOW, removeDerivative });

    expect(summary.rescheduled).toBe(1);
    expect(updates[0]?.values).toMatchObject({ last_error: 'The object still exists after removal.' });
  });

  it('fails the run while a copy has been queued for a day, after draining the due batch', async () => {
    const { client, bucket, tables } = createClient({
      revocations: [
        queued({
          id: 'rev-stuck',
          showcase_asset_path: `showcase/${GENERATION_ID}/stuck.jpg`,
          next_attempt_at: '2026-09-16T20:00:00.000Z',
          created_at: '2026-09-15T08:00:00.000Z',
        }),
        queued(),
      ],
    });
    const removeDerivative = removingFrom(bucket);

    const outcome = await processShowcaseMediaRevocations(client, { now: NOW, removeDerivative })
      .then((summary) => summary, (error: unknown) => error);

    expect(outcome).toBeInstanceOf(ShowcaseMediaRevocationsStuckError);
    expect(outcome).toMatchObject({ summary: { due: 1, removed: 1, stuck: 1 } });
    expect(tables.showcase_media_revocations.map((row) => row.id)).toEqual(['rev-stuck']);
  });

  it('backs off from ten minutes to at most a day', () => {
    expect(showcaseMediaRevocationRetryDelayMs(1)).toBe(10 * 60 * 1000);
    expect(showcaseMediaRevocationRetryDelayMs(4)).toBe(80 * 60 * 1000);
    expect(showcaseMediaRevocationRetryDelayMs(20)).toBe(24 * 60 * 60 * 1000);
  });
});

describe('hasPendingShowcaseMediaRevocations', () => {
  it('counts a row still waiting out its backoff as work', async () => {
    const empty = createClient({ revocations: [] });
    const waiting = createClient({ revocations: [queued({ next_attempt_at: '2026-09-17T00:00:00.000Z' })] });

    await expect(hasPendingShowcaseMediaRevocations(empty.client)).resolves.toBe(false);
    await expect(hasPendingShowcaseMediaRevocations(waiting.client)).resolves.toBe(true);
  });
});
