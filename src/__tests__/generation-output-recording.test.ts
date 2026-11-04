import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GenerationServiceError } from '@/lib/generation-service-core';

const mocks = vi.hoisted(() => ({
  stage: vi.fn(),
  imagePreview: vi.fn(),
  settle: vi.fn(),
  logBackendError: vi.fn(),
  logBackendWarning: vi.fn(),
}));

vi.mock('@/lib/staged-remote-media', () => ({
  stageAllowlistedRemoteMedia: (...args: unknown[]) => mocks.stage(...args),
}));
vi.mock('@/lib/generation-media-preview', () => ({
  createGenerationImagePreviewFromFile: (...args: unknown[]) => mocks.imagePreview(...args),
}));
vi.mock('@/lib/generation-settlement', () => ({
  settleGenerationSucceeded: (...args: unknown[]) => mocks.settle(...args),
  settleGenerationFailed: vi.fn(),
}));
vi.mock('@/lib/backend-logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/backend-logger')>(),
  logBackendError: (...args: unknown[]) => mocks.logBackendError(...args),
  logBackendWarning: (...args: unknown[]) => mocks.logBackendWarning(...args),
}));

import { persistGeneratedOutput, persistGeneratedOutputList } from '@/lib/generation-services';

type NamingRow = {
  id: string;
  output_url: string | null;
  preview_url: string | null;
  display_url: string | null;
  workflow_settings: Record<string, unknown> | null;
};

const PREVIEW = 'generated_images/user-1/generated_p1.preview.1111222233334444.webp';
const DISPLAY = 'generated_images/user-1/generated_p1.display.5555666677778888.webp';

/**
 * A client that answers the display update as PostgREST does: the rows its
 * filters matched, with the columns asked for. `row` is the creation as the
 * database holds it after the settlement (null once deleted).
 */
function createClient({
  row,
  updateError = null,
  readError = null,
}: {
  row: NamingRow | null;
  updateError?: { message: string } | null;
  readError?: { message: string } | null;
}) {
  const calls = {
    uploads: [] as Array<{ bucket: string; path: string; options?: Record<string, unknown> }>,
    removals: [] as Array<{ bucket: string; paths: string[] }>,
    updates: [] as Array<{ patch: Record<string, unknown>; filters: Record<string, unknown>; columns: string | null }>,
    reads: [] as Array<{ filters: Record<string, unknown>; columns: string }>,
  };
  let current = row ? { ...row } : null;

  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, _body: unknown, options?: Record<string, unknown>) => {
          calls.uploads.push({ bucket, path, options });
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          calls.removals.push({ bucket, paths });
          return { data: [], error: null };
        },
      }),
    },
    from(table: string) {
      if (table !== 'generations') throw new Error(`Unexpected table ${table}`);
      return {
        update(patch: Record<string, unknown>) {
          const filters: Record<string, unknown> = {};
          const update = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return update;
            },
            async select(columns: string) {
              calls.updates.push({ patch, filters, columns });
              if (updateError) return { data: null, error: updateError };
              const matches = current
                && Object.entries(filters).every(([column, value]) => (current as Record<string, unknown>)[column] === value);
              if (!matches || !current) return { data: [], error: null };
              current = { ...current, ...patch };
              return { data: [current], error: null };
            },
            then(resolve: (value: { error: unknown }) => unknown) {
              calls.updates.push({ patch, filters, columns: null });
              const matches = current
                && Object.entries(filters).every(([column, value]) => (current as Record<string, unknown>)[column] === value);
              if (matches && current) current = { ...current, ...patch };
              return Promise.resolve({ error: updateError }).then(resolve);
            },
          };
          return update;
        },
        select(columns: string) {
          const filters: Record<string, unknown> = {};
          const read = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return read;
            },
            async maybeSingle() {
              calls.reads.push({ filters, columns });
              if (readError) return { data: null, error: readError };
              return { data: current && current.id === filters.id ? current : null, error: null };
            },
          };
          return read;
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

const generation = {
  id: 'gen-1',
  user_id: 'user-1',
  prediction_id: 'p1',
  status: 'processing',
  output_url: null,
  model: 'nano-banana-2',
  category: 'image',
  workflow_settings: null,
  created_at: '2026-11-04T10:00:00.000Z',
  completed_at: null,
};

function settledRow(overrides: Partial<NamingRow> = {}): NamingRow {
  return {
    id: 'gen-1',
    output_url: 'generated_images/user-1/generated_p1.png',
    preview_url: PREVIEW,
    display_url: null,
    workflow_settings: null,
    ...overrides,
  };
}

function removedPaths(removals: Array<{ bucket: string; paths: string[] }>) {
  return removals.flatMap(({ bucket, paths }) => paths.map((path) => `${bucket}/${path}`)).sort();
}

describe('what a finished run uploads and records', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'generation-output-recording-'));
    const filePath = join(directory, 'output.png');
    await writeFile(filePath, 'synthetic-output-bytes');
    mocks.stage.mockReset().mockResolvedValue({
      filePath,
      sourceName: 'output.png',
      contentType: 'image/png',
      cleanup: async () => {},
    });
    mocks.imagePreview.mockReset().mockImplementation(async ({ storagePath }: { storagePath: string }) => ({
      previewStoragePath: storagePath.replace(/\.png$/, '.preview.1111222233334444.webp'),
      displayStoragePath: storagePath.replace(/\.png$/, '.display.5555666677778888.webp'),
      previewThumbhash: 'thumb',
    }));
    mocks.settle.mockReset().mockResolvedValue('succeeded');
    mocks.logBackendError.mockReset();
    mocks.logBackendWarning.mockReset();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe('a run of one output', () => {
    it('records the display rendition it uploaded, against the output it settled', async () => {
      const { client, calls } = createClient({ row: settledRow() });

      await expect(persistGeneratedOutput(client, client, generation, 'https://tempfile.example.com/p1.png'))
        .resolves.toBe('succeeded');

      expect(calls.updates).toEqual([{
        patch: { display_url: DISPLAY },
        filters: { id: 'gen-1', output_url: 'generated_images/user-1/generated_p1.png' },
        columns: expect.stringContaining('display_url'),
      }]);
      expect(calls.removals).toEqual([]);
    });

    // A publish then copies it inside Storage, which keeps the source's header
    // (generation-post-media copyStoredShowcaseSource).
    it('writes the original with the public copy\'s cache header', async () => {
      const { client, calls } = createClient({ row: settledRow() });

      await persistGeneratedOutput(client, client, generation, 'https://tempfile.example.com/p1.png');

      expect(calls.uploads).toEqual([{
        bucket: 'generated_images',
        path: 'user-1/generated_p1.png',
        options: expect.objectContaining({ cacheControl: '86400', contentType: 'image/png', upsert: true }),
      }]);
    });

    it('removes the display when the row has moved to another output since', async () => {
      const { client, calls } = createClient({
        row: settledRow({ output_url: 'generated_images/user-1/repaired.png', preview_url: 'generated_images/user-1/repaired.preview.aaaa.webp' }),
      });

      await persistGeneratedOutput(client, client, generation, 'https://tempfile.example.com/p1.png');

      expect(removedPaths(calls.removals)).toEqual([
        'generated_images/user-1/generated_p1.display.5555666677778888.webp',
        'generated_images/user-1/generated_p1.png',
        'generated_images/user-1/generated_p1.preview.1111222233334444.webp',
      ]);
    });

    it('keeps everything when the display write fails: it may have landed', async () => {
      const { client, calls } = createClient({ row: settledRow(), updateError: { message: 'timeout' } });

      await persistGeneratedOutput(client, client, generation, 'https://tempfile.example.com/p1.png');

      expect(calls.removals).toEqual([]);
      expect(mocks.logBackendWarning).toHaveBeenCalledWith('generation_display_rendition_not_recorded', expect.anything());
    });

    it('removes what it uploaded when the run had already been settled as failed', async () => {
      mocks.settle.mockResolvedValue('failed');
      const { client, calls } = createClient({ row: settledRow({ output_url: null, preview_url: null }) });

      await expect(persistGeneratedOutput(client, client, generation, 'https://tempfile.example.com/p1.png'))
        .resolves.toBe('failed');

      expect(removedPaths(calls.removals)).toEqual([
        'generated_images/user-1/generated_p1.display.5555666677778888.webp',
        'generated_images/user-1/generated_p1.png',
        'generated_images/user-1/generated_p1.preview.1111222233334444.webp',
      ]);
    });

    it('removes what it uploaded when the creation was deleted meanwhile, and still reports it', async () => {
      mocks.settle.mockRejectedValue(new GenerationServiceError('Generation not found for success settlement.', 404));
      const { client, calls } = createClient({ row: null });

      await expect(persistGeneratedOutput(client, client, generation, 'https://tempfile.example.com/p1.png'))
        .rejects.toMatchObject({ status: 404 });

      expect(removedPaths(calls.removals)).toEqual([
        'generated_images/user-1/generated_p1.display.5555666677778888.webp',
        'generated_images/user-1/generated_p1.png',
        'generated_images/user-1/generated_p1.preview.1111222233334444.webp',
      ]);
    });

    it('keeps everything when the settlement outcome is unknown', async () => {
      mocks.settle.mockRejectedValue(new GenerationServiceError('Failed to settle successful generation.', 500));
      const { client, calls } = createClient({ row: null });

      await expect(persistGeneratedOutput(client, client, generation, 'https://tempfile.example.com/p1.png'))
        .rejects.toMatchObject({ status: 500 });

      expect(calls.removals).toEqual([]);
    });

    it('keeps everything when the row cannot be read back', async () => {
      mocks.settle.mockResolvedValue('failed');
      const { client, calls } = createClient({ row: settledRow(), readError: { message: 'database unavailable' } });

      await persistGeneratedOutput(client, client, generation, 'https://tempfile.example.com/p1.png');

      expect(calls.removals).toEqual([]);
    });

    it('never removes a file the row still names', async () => {
      mocks.settle.mockResolvedValue('failed');
      const { client, calls } = createClient({
        row: settledRow({ output_url: null, preview_url: PREVIEW }),
      });

      await persistGeneratedOutput(client, client, generation, 'https://tempfile.example.com/p1.png');

      expect(removedPaths(calls.removals)).not.toContain(PREVIEW);
    });
  });

  describe('a run of several outputs', () => {
    const listGeneration = { ...generation, model: 'grok-imagine-image' };

    it('removes every output it uploaded when the run had already been settled as failed', async () => {
      mocks.settle.mockResolvedValue('failed');
      const { client, calls } = createClient({ row: settledRow({ output_url: null, preview_url: null }) });

      await expect(persistGeneratedOutputList(client, client, listGeneration, [
        'https://tempfile.example.com/p1-0.png',
        'https://tempfile.example.com/p1-1.png',
      ])).resolves.toMatchObject({ status: 'failed' });

      expect(removedPaths(calls.removals)).toEqual([
        'generated_images/user-1/generated_p1_0.display.5555666677778888.webp',
        'generated_images/user-1/generated_p1_0.png',
        'generated_images/user-1/generated_p1_0.preview.1111222233334444.webp',
        'generated_images/user-1/generated_p1_1.png',
      ]);
    });

    it('keeps the outputs the row records and records the display', async () => {
      const { client, calls } = createClient({
        row: settledRow({
          output_url: 'generated_images/user-1/generated_p1_0.png',
          preview_url: 'generated_images/user-1/generated_p1_0.preview.1111222233334444.webp',
          workflow_settings: {
            outputs: [
              { index: 0, storagePath: 'generated_images/user-1/generated_p1_0.png' },
              { index: 1, storagePath: 'generated_images/user-1/generated_p1_1.png' },
            ],
          },
        }),
      });

      await persistGeneratedOutputList(client, client, listGeneration, [
        'https://tempfile.example.com/p1-0.png',
        'https://tempfile.example.com/p1-1.png',
      ]);

      expect(calls.updates).toEqual([expect.objectContaining({
        patch: { display_url: 'generated_images/user-1/generated_p1_0.display.5555666677778888.webp' },
      })]);
      expect(calls.removals).toEqual([]);
      expect(calls.uploads.map(({ options }) => options?.cacheControl)).toEqual(['86400', '86400']);
    });
  });
});
