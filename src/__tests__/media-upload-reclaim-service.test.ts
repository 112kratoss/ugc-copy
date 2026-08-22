import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  isAbandonedIntentReclaimEnabled,
  reclaimAbandonedMediaUploads,
  selectReclaimableIntents,
} from '@/lib/media-upload-reclaim-service';
import { RECLAIM_AFTER_HOURS } from '@/lib/media-upload-reclaim';
import { getMediaUploadReclaimPolicy } from '@/lib/media-upload-reclaim-policy';

const NOW = new Date('2026-08-03T12:00:00.000Z');

function agedIso(hours: number) {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

type FakeRow = {
  id: string;
  user_id?: string;
  storage_path: string;
  kind: 'image' | 'video' | 'audio';
  declared_bytes: number | null;
  created_at: string;
  consumed_by: string | null;
};

/**
 * Records the filters the sweep builds and serves a fixed row set, so the tests
 * can assert on the query shape (which is where the rollout gate lives) without
 * a database.
 */
function clientDouble({
  rows = [] as FakeRow[],
  objects = null as string[] | null,
  removeError = null as { message?: string } | null,
  removedNames = null as string[] | null,
}) {
  const notFilters: Array<[string, string, unknown]> = [];
  const updates: Array<Record<string, unknown>> = [];
  const removed: string[][] = [];

  const query: Record<string, unknown> = {};
  for (const method of ['select', 'is', 'lt', 'order', 'limit']) {
    query[method] = vi.fn(() => query);
  }
  query.not = vi.fn((column: string, operator: string, value: unknown) => {
    notFilters.push([column, operator, value]);
    return query;
  });
  query.then = (resolve: (r: { data: FakeRow[]; error: null }) => unknown) =>
    Promise.resolve(resolve({
      data: rows.map((row) => ({
        ...row,
        user_id: row.user_id ?? row.storage_path.split('/')[0] ?? 'user-1',
      })),
      error: null,
    }));

  const updateChain: Record<string, unknown> = {
    in: vi.fn(() => updateChain),
    then: (resolve: (r: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })),
  };

  const from = vi.fn(() => ({
    select: query.select,
    update: vi.fn((values: Record<string, unknown>) => {
      updates.push(values);
      return updateChain;
    }),
  }));

  const storageFrom = vi.fn(() => ({
    listV2: vi.fn(async (options: { prefix?: string }) => {
      const prefix = (options.prefix ?? '').replace(/\/$/u, '');
      const names = objects === null
        ? rows
          .filter((row) => row.storage_path.startsWith(`${prefix}/`))
          .map((row) => row.storage_path.slice(prefix.length + 1))
        : objects;
      return {
        data: {
          hasNext: false,
          folders: [],
          objects: names.map((name, index) => ({
            id: `object-${index}`,
            key: `${prefix}/${name}`,
            name,
            created_at: NOW.toISOString(),
            updated_at: NOW.toISOString(),
            metadata: {},
          })),
        },
      error: null,
      };
    }),
    remove: vi.fn(async (paths: string[]) => {
      removed.push(paths);
      // Storage reports per-path outcomes here, not in `error`.
      return {
        data: (removedNames ?? paths).map((name) => ({ name })),
        error: removeError,
      };
    }),
  }));

  return {
    client: { from, storage: { from: storageFrom } } as unknown as SupabaseClient,
    notFilters,
    updates,
    removed,
  };
}

describe('abandoned reclaim rollout gate', () => {
  it('requires both the exact flag and a safe compatibility minimum', () => {
    expect(isAbandonedIntentReclaimEnabled({})).toBe(false);
    for (const value of ['false', '1', 'TRUE', 'true ']) {
      expect(isAbandonedIntentReclaimEnabled(
        { MEDIA_UPLOAD_RECLAIM_ABANDONED: value },
        '0.0.5',
      )).toBe(false);
    }
    expect(isAbandonedIntentReclaimEnabled(
      { MEDIA_UPLOAD_RECLAIM_ABANDONED: 'true' },
      '0.0.4',
    )).toBe(false);
    expect(isAbandonedIntentReclaimEnabled(
      { MEDIA_UPLOAD_RECLAIM_ABANDONED: 'true' },
      '0.0.5',
    )).toBe(true);
  });

  it.each([
    ['', false],
    ['not-a-version', false],
    ['v0.0.5', false],
    ['0.0', false],
    ['0.0.05', false],
    ['0.0.5-beta.1', false],
    ['0.0.5', true],
    ['0.0.5+build.7', true],
    ['0.0.6-beta.1', true],
    ['0.1.0', true],
    ['1.0.0', true],
  ])('fails closed for minimum app version %j (enabled: %j)', (minimumAppVersion, enabled) => {
    expect(getMediaUploadReclaimPolicy({
      environment: { MEDIA_UPLOAD_RECLAIM_ABANDONED: 'true' },
      minimumAppVersion,
    })).toEqual({
      flagConfigured: true,
      minimumAppVersion,
      effectiveEnabled: enabled,
    });
  });

  it('automatically disables abandoned reclaim when the compatibility minimum is rolled back', () => {
    const environment = { MEDIA_UPLOAD_RECLAIM_ABANDONED: 'true' };
    expect(getMediaUploadReclaimPolicy({ environment, minimumAppVersion: '0.0.5' }).effectiveEnabled)
      .toBe(true);
    expect(getMediaUploadReclaimPolicy({ environment, minimumAppVersion: '0.0.1' }).effectiveEnabled)
      .toBe(false);
  });

  it('keeps the gate disabled with the current code-controlled minimum', () => {
    expect(isAbandonedIntentReclaimEnabled({ MEDIA_UPLOAD_RECLAIM_ABANDONED: 'true' })).toBe(false);
  });

  it('withholds never-consumed rows while the gate is closed', async () => {
    // Old mobile builds resume a draft without checking its staged paths, so
    // collecting an unclaimed object breaks a publish they cannot recover from.
    const gated = clientDouble({ rows: [] });
    await selectReclaimableIntents(gated.client, { now: NOW, includeAbandoned: false });
    expect(gated.notFilters).toContainEqual(['consumed_by', 'is', null]);
  });

  it('offers every uncleared row once the gate is open', async () => {
    const open = clientDouble({ rows: [] });
    await selectReclaimableIntents(open.client, { now: NOW, includeAbandoned: true });
    expect(open.notFilters).toHaveLength(0);
  });
});

describe('reclaimAbandonedMediaUploads', () => {
  it('deletes staged objects past the window and closes their rows', async () => {
    const sweep = clientDouble({
      rows: [{
        id: 'intent-1',
        storage_path: 'user-1/abandoned.mp4',
        kind: 'video',
        declared_bytes: 1024,
        created_at: agedIso(RECLAIM_AFTER_HOURS + 1),
        consumed_by: 'generation_input',
      }],
    });

    const summary = await reclaimAbandonedMediaUploads(sweep.client, {
      now: NOW,
      includeAbandoned: true,
      protectedPaths: new Set(),
    });

    expect(sweep.removed).toEqual([['user-1/abandoned.mp4']]);
    expect(summary).toMatchObject({ scanned: 1, reclaimed: 1, rowsDropped: 0, bytesReclaimed: 1024 });
    expect(sweep.updates.some((update) => 'storage_cleared_at' in update)).toBe(true);
  });

  it('drops rows for uploads that were signed but never written, without a delete', async () => {
    const sweep = clientDouble({
      rows: [{
        id: 'intent-1',
        storage_path: 'user-1/never-uploaded.jpg',
        kind: 'image',
        declared_bytes: 512,
        created_at: agedIso(RECLAIM_AFTER_HOURS + 1),
        consumed_by: null,
      }],
      objects: [],
    });

    const summary = await reclaimAbandonedMediaUploads(sweep.client, {
      now: NOW,
      includeAbandoned: true,
      protectedPaths: new Set(),
    });

    expect(sweep.removed).toEqual([]);
    expect(summary).toMatchObject({ scanned: 1, reclaimed: 0, rowsDropped: 1, bytesReclaimed: 0 });
  });

  it('leaves rows uncleared when the storage delete fails so the next run retries', async () => {
    // Marking the row before confirming the delete would strand the bytes
    // permanently -- nothing else ever looks at the uploads bucket.
    const sweep = clientDouble({
      rows: [{
        id: 'intent-1',
        storage_path: 'user-1/abandoned.mp4',
        kind: 'video',
        declared_bytes: 2048,
        created_at: agedIso(RECLAIM_AFTER_HOURS + 1),
        consumed_by: 'generation_input',
      }],
      removeError: { message: 'storage outage' },
    });

    const summary = await reclaimAbandonedMediaUploads(sweep.client, {
      now: NOW,
      includeAbandoned: true,
      protectedPaths: new Set(),
    });

    expect(summary).toMatchObject({ reclaimed: 0, bytesReclaimed: 0 });
    expect(sweep.updates).toHaveLength(0);
  });

  it('keeps a non-canonical owner-changing row away from privileged storage calls', async () => {
    const sweep = clientDouble({
      rows: [{
        id: 'intent-1',
        user_id: 'user-1',
        storage_path: 'user-1%252fuser-2/private.mp4',
        kind: 'video',
        declared_bytes: 2048,
        created_at: agedIso(RECLAIM_AFTER_HOURS + 1),
        consumed_by: 'generation_input',
      }],
    });

    const summary = await reclaimAbandonedMediaUploads(sweep.client, {
      now: NOW,
      includeAbandoned: true,
      protectedPaths: new Set(),
    });

    expect(summary).toMatchObject({ scanned: 1, reclaimed: 0, rowsDropped: 0, kept: 1 });
    expect(sweep.removed).toEqual([]);
    expect(sweep.updates).toHaveLength(0);
  });

  it('reports no work without touching storage when nothing is due', async () => {
    const sweep = clientDouble({ rows: [] });
    const summary = await reclaimAbandonedMediaUploads(sweep.client, {
      now: NOW,
      includeAbandoned: true,
      protectedPaths: new Set(),
    });

    expect(summary).toEqual({
      abandonedReclaimEnabled: false,
      scanned: 0,
      reclaimed: 0,
      rowsDropped: 0,
      kept: 0,
      bytesReclaimed: 0,
      protectedLegacyReferences: 0,
    });
    expect(sweep.removed).toEqual([]);
  });

  it('does not let an explicit caller option bypass the destructive rollout interlock', async () => {
    const sweep = clientDouble({ rows: [] });

    const summary = await reclaimAbandonedMediaUploads(sweep.client, {
      now: NOW,
      includeAbandoned: true,
      protectedPaths: new Set(),
    });

    expect(summary.abandonedReclaimEnabled).toBe(false);
    expect(sweep.notFilters).toContainEqual(['consumed_by', 'is', null]);
  });
});

describe('legacy generation reference guard', () => {
  function stagedRow(overrides: Partial<FakeRow> = {}): FakeRow {
    return {
      id: 'intent-1',
      storage_path: 'user-1/still-referenced.png',
      kind: 'image',
      declared_bytes: 4096,
      created_at: agedIso(RECLAIM_AFTER_HOURS + 1),
      consumed_by: 'generation_input',
      ...overrides,
    };
  }

  it('withholds a staged object a legacy-only generation still reads', async () => {
    // Its durable input media never persisted, so the inputs view, remix, and
    // paid-bundle recipe inputs all resolve this file directly.
    const sweep = clientDouble({ rows: [stagedRow()] });

    const summary = await reclaimAbandonedMediaUploads(sweep.client, {
      now: NOW,
      includeAbandoned: true,
      protectedPaths: new Set(['user-1/still-referenced.png']),
    });

    expect(sweep.removed).toEqual([]);
    expect(summary).toMatchObject({ reclaimed: 0, protectedLegacyReferences: 1, bytesReclaimed: 0 });
  });

  it('protects consumed rows too, not just never-consumed ones', async () => {
    // A repair that persisted and then rolled back leaves the intent consumed
    // while its generation is legacy-only again -- and the consumed half of the
    // sweep runs from day one, before any gate is opened.
    const sweep = clientDouble({ rows: [stagedRow({ consumed_by: 'generation_input' })] });

    const summary = await reclaimAbandonedMediaUploads(sweep.client, {
      now: NOW,
      includeAbandoned: false,
      protectedPaths: new Set(['user-1/still-referenced.png']),
    });

    expect(sweep.removed).toEqual([]);
    expect(summary.protectedLegacyReferences).toBe(1);
  });

  it('still drops the row when the protected object was never written', async () => {
    // There are no bytes to protect; the row is garbage either way.
    const sweep = clientDouble({ rows: [stagedRow({ consumed_by: null })], objects: [] });

    const summary = await reclaimAbandonedMediaUploads(sweep.client, {
      now: NOW,
      includeAbandoned: true,
      protectedPaths: new Set(['user-1/still-referenced.png']),
    });

    expect(summary).toMatchObject({ rowsDropped: 1, protectedLegacyReferences: 0 });
  });

  it('only clears the rows storage confirmed it deleted', async () => {
    // remove() can partially fail with error null. Clearing every row on that
    // would orphan the survivors, since nothing else looks at this bucket.
    const sweep = clientDouble({
      rows: [
        stagedRow({ id: 'intent-1', storage_path: 'user-1/gone.png', declared_bytes: 100 }),
        stagedRow({ id: 'intent-2', storage_path: 'user-1/kept.png', declared_bytes: 900 }),
      ],
      removedNames: ['user-1/gone.png'],
    });

    const summary = await reclaimAbandonedMediaUploads(sweep.client, {
      now: NOW,
      includeAbandoned: true,
      protectedPaths: new Set(),
    });

    expect(summary).toMatchObject({ reclaimed: 1, bytesReclaimed: 100 });
  });

  it('reclaims nothing at all when the protected set cannot be proven', async () => {
    // A truncated or failed guard scan is not evidence that anything is safe.
    const sweep = clientDouble({ rows: [stagedRow()] });

    const summary = await reclaimAbandonedMediaUploads(sweep.client, {
      now: NOW,
      includeAbandoned: true,
      protectedPaths: null,
    });

    expect(sweep.removed).toEqual([]);
    expect(sweep.updates).toHaveLength(0);
    expect(summary).toMatchObject({ scanned: 1, reclaimed: 0, rowsDropped: 0, kept: 1 });
  });
});
