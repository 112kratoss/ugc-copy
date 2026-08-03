import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  LEGACY_GUARD_SCAN_LIMIT,
  MAX_INPUT_REPAIR_ATTEMPTS,
  extractUploadsPathsFromWorkflowSettings,
  hasRepairableLegacyGenerations,
  listProtectedUploadPaths,
  repairMissingGenerationInputMedia,
  toRepairCandidates,
} from '@/lib/generation-input-media-repair';
import { normalizeUploadIntentPath } from '@/lib/media-upload-staging-paths';
import type { GenerationInputMediaItem } from '@/lib/generation-input-media';

const NOW = new Date('2026-08-03T12:00:00.000Z');

function legacyItem(overrides: Partial<GenerationInputMediaItem> = {}): GenerationInputMediaItem {
  return {
    id: 'legacy-gen-1-reference_image-0',
    generationId: 'gen-1',
    mediaType: 'image',
    role: 'reference_image',
    label: 'Reference image 1',
    url: null,
    storagePath: 'uploads/user-1/abc-ref.png',
    sourceGenerationId: null,
    sortOrder: 0,
    metadata: { legacy: true, displayName: 'Ref' },
    ...overrides,
  };
}

/**
 * Records what the repair writes and lets each collaborator be steered
 * independently, so the rollback and verification branches can be exercised
 * without storage or a database.
 */
function repairClientDouble({
  generations = [] as Array<Record<string, unknown>>,
  rowsByGeneration = new Map<string, Array<{ id: string; metadata: Record<string, unknown> | null }>>(),
  rpcError = null as { message?: string } | null,
  deleteError = null as { message?: string } | null,
  sourceGenerations = [] as Array<{ id: string; user_id: string; output_url: string | null }>,
} = {}) {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const deletedGenerations: string[] = [];
  const repairUpserts: Array<Record<string, unknown>> = [];
  const removedObjects: string[][] = [];

  const client = {
    rpc: vi.fn(async (_name: string, args: Record<string, unknown>) => {
      rpcCalls.push(args);
      if (rpcError) return { data: null, error: rpcError };
      const limit = Number(args.p_limit ?? 0);
      return { data: generations.slice(0, limit), error: null };
    }),
    from: vi.fn((table: string) => {
      if (table === 'generation_input_media') {
        const query: Record<string, unknown> = {
          select: () => query,
          delete: () => ({
            eq: async (_column: string, generationId: string) => {
              deletedGenerations.push(generationId);
              return { error: deleteError };
            },
          }),
          eq: async (_column: string, generationId: string) => ({
            data: rowsByGeneration.get(generationId) ?? [],
            error: null,
          }),
        };
        return query;
      }

      if (table === 'generations') {
        return {
          select: () => ({
            in: async () => ({ data: sourceGenerations, error: null }),
          }),
        };
      }

      if (table === 'generation_input_media_repairs') {
        return {
          upsert: async (values: Record<string, unknown>) => {
            repairUpserts.push(values);
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    }),
    storage: {
      from: vi.fn(() => ({
        list: async () => ({ data: [{ name: '00-reference_image.png' }], error: null }),
        remove: async (paths: string[]) => {
          removedObjects.push(paths);
          return { error: null };
        },
      })),
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    rpcCalls,
    deletedGenerations,
    repairUpserts,
    removedObjects,
  };
}

describe('extractUploadsPathsFromWorkflowSettings', () => {
  it('finds staged paths wherever they are nested', () => {
    const paths = extractUploadsPathsFromWorkflowSettings({
      elements: [{ storagePath: 'uploads/user-1/a-ref.png' }],
      seedanceAssets: { images: [{ sourceUrl: 'uploads/user-1/b-ref.jpg' }] },
      nested: { deeper: { characterImage: { storagePath: 'uploads/user-1/c-char.png' } } },
    });

    expect(new Set(paths)).toEqual(new Set([
      'user-1/a-ref.png',
      'user-1/b-ref.jpg',
      'user-1/c-char.png',
    ]));
  });

  it('finds a staged path embedded in a stored signed URL and drops the query', () => {
    // The guard has to over-approximate: a path buried in a signed URL is still
    // a file the legacy view may resolve.
    expect(extractUploadsPathsFromWorkflowSettings({
      url: 'https://project.supabase.co/storage/v1/object/sign/uploads/user-1/a-ref.png?token=abc',
    })).toEqual(['user-1/a-ref.png']);
  });

  it('returns bucket-relative paths so they compare against intent rows', () => {
    expect(extractUploadsPathsFromWorkflowSettings({ p: 'uploads/user-1/a.png' }))
      .toEqual(['user-1/a.png']);
  });

  it('ignores strings that cannot be a staged object', () => {
    expect(extractUploadsPathsFromWorkflowSettings({
      a: 'uploads/',
      b: 'uploads/lonely-segment',
      c: 'no staging path here',
      d: 42,
      e: null,
    })).toEqual([]);
  });

  it('de-duplicates repeated references', () => {
    expect(extractUploadsPathsFromWorkflowSettings({
      a: 'uploads/user-1/a.png',
      b: 'uploads/user-1/a.png',
    })).toEqual(['user-1/a.png']);
  });

  it('normalizes identically to the intent rows it is compared against', () => {
    // The sweep matches these two sets by exact string. A stored path with a
    // trailing space (the sign route used to pass the extension through
    // unsanitized) normalized on the row side but not here, so the guard missed
    // and a file a generation was still reading got deleted.
    expect(extractUploadsPathsFromWorkflowSettings({ p: 'uploads/user-1/uuid-clip.mp4 ' }))
      .toEqual([normalizeUploadIntentPath('user-1/uuid-clip.mp4 ')]);
    expect(extractUploadsPathsFromWorkflowSettings({ p: 'uploads//user-1/a.png' }))
      .toEqual([normalizeUploadIntentPath('/user-1/a.png')]);
  });
});

describe('toRepairCandidates', () => {
  it('maps legacy items to persist candidates without the legacy marker', () => {
    const [candidate] = toRepairCandidates([legacyItem()]);
    expect(candidate).toMatchObject({
      mediaType: 'image',
      role: 'reference_image',
      sourceStoragePath: 'uploads/user-1/abc-ref.png',
      sortOrder: 0,
    });
    expect(candidate.metadata).not.toHaveProperty('legacy');
    expect(candidate.metadata).toMatchObject({ displayName: 'Ref' });
  });

  it('carries a seedance remote source through as a URL candidate', () => {
    const [candidate] = toRepairCandidates([legacyItem({
      storagePath: null,
      metadata: { legacy: true, sourceUrl: 'https://cdn.example.com/a.jpg' },
    })]);
    expect(candidate.sourceStoragePath).toBeNull();
    expect(candidate.sourceUrl).toBe('https://cdn.example.com/a.jpg');
  });
});

describe('listProtectedUploadPaths', () => {
  it('collects staged paths from every legacy-only generation', async () => {
    const { client, rpcCalls } = repairClientDouble({
      generations: [
        { id: 'gen-1', user_id: 'user-1', workflow_settings: { p: 'uploads/user-1/a.png' }, attempt_count: 0 },
        { id: 'gen-2', user_id: 'user-1', workflow_settings: { p: 'uploads/user-1/b.png' }, attempt_count: 9 },
      ],
    });

    const paths = await listProtectedUploadPaths(client, { now: NOW });

    expect(paths).toEqual(new Set(['user-1/a.png', 'user-1/b.png']));
    // Null cap on purpose: a generation repair gave up on still reads its files.
    expect(rpcCalls[0].p_max_attempts).toBeNull();
  });

  it('fails closed when the scan errors', async () => {
    const { client } = repairClientDouble({ rpcError: { message: 'rpc down' } });
    expect(await listProtectedUploadPaths(client, { now: NOW })).toBeNull();
  });

  it('fails closed when the scan may be truncated', async () => {
    // A truncated scan cannot prove what is protected, and an unproven answer
    // must never authorize a delete.
    const generations = Array.from({ length: LEGACY_GUARD_SCAN_LIMIT }, (_unused, index) => ({
      id: `gen-${index}`,
      user_id: 'user-1',
      workflow_settings: { p: `uploads/user-1/${index}.png` },
      attempt_count: 0,
    }));
    const { client } = repairClientDouble({ generations });
    expect(await listProtectedUploadPaths(client, { now: NOW })).toBeNull();
  });
});

describe('hasRepairableLegacyGenerations', () => {
  it('applies the attempt cap and the age floor', async () => {
    const { client, rpcCalls } = repairClientDouble({
      generations: [{ id: 'gen-1', user_id: 'user-1', workflow_settings: {}, attempt_count: 0 }],
    });

    expect(await hasRepairableLegacyGenerations(client, { now: NOW })).toBe(true);
    expect(rpcCalls[0].p_max_attempts).toBe(MAX_INPUT_REPAIR_ATTEMPTS);
    expect(Date.parse(String(rpcCalls[0].p_created_before))).toBeLessThan(NOW.getTime());
  });

  it('reports no work rather than throwing when the scan fails', async () => {
    const { client } = repairClientDouble({ rpcError: { message: 'rpc down' } });
    expect(await hasRepairableLegacyGenerations(client, { now: NOW })).toBe(false);
  });
});

describe('repairMissingGenerationInputMedia', () => {
  const generation = {
    id: 'gen-1',
    user_id: 'user-1',
    category: 'image',
    model: 'test-model',
    workflow_settings: { elements: [{ storagePath: 'uploads/user-1/abc-ref.png' }] },
    attempt_count: 0,
  };

  it('records durable rows and marks the generation repaired when the set is complete', async () => {
    const rowsByGeneration = new Map<string, Array<{ id: string; metadata: Record<string, unknown> | null }>>();
    rowsByGeneration.set('gen-1', []);
    const double = repairClientDouble({ generations: [generation], rowsByGeneration });

    const summary = await repairMissingGenerationInputMedia(double.client, {
      now: NOW,
      dependencies: {
        buildLegacyGenerationInputMedia: vi.fn(async () => [legacyItem()]),
        persistGenerationInputMedia: vi.fn(async () => {
          rowsByGeneration.set('gen-1', [
            { id: 'row-1', metadata: { sourceStoragePath: 'uploads/user-1/abc-ref.png' } },
          ]);
        }),
      },
    });

    expect(summary).toMatchObject({ attempted: 1, completed: 1, failed: 0 });
    expect(double.deletedGenerations).toEqual([]);
    expect(double.repairUpserts[0]).toMatchObject({
      generation_id: 'gen-1',
      attempt_count: 1,
      last_error: null,
    });
    expect(double.repairUpserts[0].repaired_at).toBeTruthy();
  });

  it('rolls back rows before objects when the durable set is incomplete', async () => {
    // The read paths flip to durable the moment one row exists, so a half-set
    // silently drops reference tiles. Deleting the rows restores the intact
    // legacy fallback, and rows must go first because account-deletion
    // retention throws on a row whose object is missing.
    const rowsByGeneration = new Map<string, Array<{ id: string; metadata: Record<string, unknown> | null }>>();
    rowsByGeneration.set('gen-1', []);
    const double = repairClientDouble({ generations: [generation], rowsByGeneration });

    const summary = await repairMissingGenerationInputMedia(double.client, {
      now: NOW,
      dependencies: {
        buildLegacyGenerationInputMedia: vi.fn(async () => [
          legacyItem(),
          legacyItem({ id: 'second', storagePath: 'uploads/user-1/def-ref.png', sortOrder: 1 }),
        ]),
        persistGenerationInputMedia: vi.fn(async () => {
          rowsByGeneration.set('gen-1', [
            { id: 'row-1', metadata: { sourceStoragePath: 'uploads/user-1/abc-ref.png' } },
          ]);
        }),
      },
    });

    expect(summary).toMatchObject({ attempted: 1, completed: 0, failed: 1 });
    expect(double.deletedGenerations).toEqual(['gen-1']);
    expect(double.removedObjects).toEqual([['user-1/gen-1/00-reference_image.png']]);
    expect(double.repairUpserts[0]).toMatchObject({
      attempt_count: 1,
      repaired_at: null,
      last_error: 'missing_durable_media_for_1_sources',
    });
  });

  it('does not accept one row as satisfying two candidates that share a source path', async () => {
    // The same picked file can appear as both an element and the start frame.
    // Comparing only distinct paths let a single written row satisfy both, so a
    // half-persisted set read as complete and the read paths flipped to durable
    // with a tile silently missing.
    const rowsByGeneration = new Map<string, Array<{ id: string; metadata: Record<string, unknown> | null }>>();
    rowsByGeneration.set('gen-1', []);
    const double = repairClientDouble({ generations: [generation], rowsByGeneration });

    const summary = await repairMissingGenerationInputMedia(double.client, {
      now: NOW,
      dependencies: {
        buildLegacyGenerationInputMedia: vi.fn(async () => [
          legacyItem(),
          legacyItem({ id: 'second', role: 'start_frame', sortOrder: 1 }),
        ]),
        persistGenerationInputMedia: vi.fn(async () => {
          rowsByGeneration.set('gen-1', [
            { id: 'row-1', metadata: { sourceStoragePath: 'uploads/user-1/abc-ref.png' } },
          ]);
        }),
      },
    });

    expect(summary).toMatchObject({ completed: 0, failed: 1 });
    expect(double.deletedGenerations).toEqual(['gen-1']);
    expect(double.repairUpserts[0].last_error).toBe('persisted_1_of_2_candidates');
  });

  it('reports a rollback it could not complete so the caller can stop reclaiming', async () => {
    // A surviving half-set removes the generation from the guard's selection
    // while its staged files are still the only copy of the inputs that failed
    // to persist -- the sweep must not run in the same job.
    const rowsByGeneration = new Map<string, Array<{ id: string; metadata: Record<string, unknown> | null }>>();
    rowsByGeneration.set('gen-1', []);
    const double = repairClientDouble({
      generations: [generation],
      rowsByGeneration,
      deleteError: { message: 'delete failed' },
    });

    const summary = await repairMissingGenerationInputMedia(double.client, {
      now: NOW,
      dependencies: {
        buildLegacyGenerationInputMedia: vi.fn(async () => [legacyItem()]),
        persistGenerationInputMedia: vi.fn(async () => undefined),
      },
    });

    expect(summary.rollbackFailures).toEqual(['gen-1']);
  });

  it('counts a persist that wrote nothing as a failed attempt', async () => {
    // Otherwise the LIKE-based selection keeps reselecting the generation on
    // every run, forever.
    const rowsByGeneration = new Map<string, Array<{ id: string; metadata: Record<string, unknown> | null }>>();
    rowsByGeneration.set('gen-1', []);
    const double = repairClientDouble({ generations: [generation], rowsByGeneration });

    const summary = await repairMissingGenerationInputMedia(double.client, {
      now: NOW,
      dependencies: {
        buildLegacyGenerationInputMedia: vi.fn(async () => [legacyItem()]),
        persistGenerationInputMedia: vi.fn(async () => undefined),
      },
    });

    expect(summary).toMatchObject({ attempted: 1, completed: 0, failed: 1 });
    expect(double.repairUpserts[0].last_error).toBe('persist_wrote_no_rows');
  });

  it('stops before persisting when a reference belongs to another user', async () => {
    // Those bytes cannot be copied into this user's bucket, so the correct
    // permanent state is the legacy fallback plus the reclaim guard.
    const rowsByGeneration = new Map<string, Array<{ id: string; metadata: Record<string, unknown> | null }>>();
    rowsByGeneration.set('gen-1', []);
    const persistGenerationInputMedia = vi.fn(async () => undefined);
    const double = repairClientDouble({
      generations: [generation],
      rowsByGeneration,
      sourceGenerations: [{ id: 'source-1', user_id: 'someone-else', output_url: 'generated_images/x/y.png' }],
    });

    const summary = await repairMissingGenerationInputMedia(double.client, {
      now: NOW,
      dependencies: {
        buildLegacyGenerationInputMedia: vi.fn(async () => [
          legacyItem({ storagePath: null, sourceGenerationId: 'source-1', metadata: { legacy: true } }),
        ]),
        persistGenerationInputMedia,
      },
    });

    expect(persistGenerationInputMedia).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ attempted: 1, failed: 1 });
    expect(double.repairUpserts[0].last_error).toBe('cross_user_source_reference');
  });

  it('resolves a same-owner source generation into a copyable path', async () => {
    const rowsByGeneration = new Map<string, Array<{ id: string; metadata: Record<string, unknown> | null }>>();
    rowsByGeneration.set('gen-1', []);
    const persistGenerationInputMedia = vi.fn(async () => {
      rowsByGeneration.set('gen-1', [
        { id: 'row-1', metadata: { sourceStoragePath: 'generated_images/user-1/y.png' } },
      ]);
    });
    const double = repairClientDouble({
      generations: [generation],
      rowsByGeneration,
      sourceGenerations: [{ id: 'source-1', user_id: 'user-1', output_url: 'generated_images/user-1/y.png' }],
    });

    const summary = await repairMissingGenerationInputMedia(double.client, {
      now: NOW,
      dependencies: {
        buildLegacyGenerationInputMedia: vi.fn(async () => [
          legacyItem({ storagePath: null, sourceGenerationId: 'source-1', metadata: { legacy: true } }),
        ]),
        persistGenerationInputMedia,
      },
    });

    expect(persistGenerationInputMedia).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [expect.objectContaining({ sourceStoragePath: 'generated_images/user-1/y.png' })],
    }));
    expect(summary).toMatchObject({ completed: 1 });
  });

  it('never deletes rows it did not create', async () => {
    const rowsByGeneration = new Map<string, Array<{ id: string; metadata: Record<string, unknown> | null }>>();
    rowsByGeneration.set('gen-1', [{ id: 'pre-existing', metadata: {} }]);
    const persistGenerationInputMedia = vi.fn(async () => undefined);
    const double = repairClientDouble({ generations: [generation], rowsByGeneration });

    const summary = await repairMissingGenerationInputMedia(double.client, {
      now: NOW,
      dependencies: {
        buildLegacyGenerationInputMedia: vi.fn(async () => [legacyItem()]),
        persistGenerationInputMedia,
      },
    });

    expect(persistGenerationInputMedia).not.toHaveBeenCalled();
    expect(double.deletedGenerations).toEqual([]);
    expect(summary).toMatchObject({ attempted: 0, skipped: 1 });
  });

  it('honours the attempt cap in JS as well as in SQL', async () => {
    const double = repairClientDouble({
      generations: [{ ...generation, attempt_count: MAX_INPUT_REPAIR_ATTEMPTS }],
    });

    const summary = await repairMissingGenerationInputMedia(double.client, {
      now: NOW,
      dependencies: {
        buildLegacyGenerationInputMedia: vi.fn(async () => [legacyItem()]),
        persistGenerationInputMedia: vi.fn(async () => undefined),
      },
    });

    expect(summary).toMatchObject({ attempted: 0, skipped: 1 });
  });

  it('returns an empty summary rather than throwing when selection fails', async () => {
    const { client } = repairClientDouble({ rpcError: { message: 'rpc down' } });
    expect(await repairMissingGenerationInputMedia(client, { now: NOW })).toEqual({
      attempted: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      rollbackFailures: [],
    });
  });
});
