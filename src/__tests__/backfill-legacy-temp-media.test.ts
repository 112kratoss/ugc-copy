import { describe, expect, it, vi } from 'vitest';

import {
  buildStorageTarget,
  inferMediaTarget,
  parseGenerationIdArgument,
  runBackfill,
} from '../../scripts/backfill-legacy-temp-media.mjs';

const IMAGE_GENERATION = {
  id: '24f5537e-f5db-4a26-8db3-c3d89f3ed261',
  user_id: '28677503-bfbe-4e99-9105-b8f0c7e0e507',
  prediction_id: '582fa1827ca37b5d621536962040a8cd',
  output_url: 'https://tempfile.aiquickdraw.com/image-format-converter/example.jpg',
  model: 'nano-banana-2',
  category: 'image',
  created_at: '2026-03-29T04:07:55.000Z',
  preview_url: null,
  preview_thumbhash: null,
  preview_status: 'failed',
  preview_attempt_count: 3,
  preview_error: 'External media download failed (404).',
  preview_generated_at: null,
};

type QueryResult = {
  count?: number | null;
  data?: unknown;
  error: null | { message: string };
};

function createSupabaseMock({ objectExists }: { objectExists: boolean }) {
  const generationUpdates: Array<Record<string, unknown>> = [];
  const postUpdates: Array<Record<string, unknown>> = [];
  const upload = vi.fn();
  const remove = vi.fn();

  class QueryBuilder implements PromiseLike<QueryResult> {
    action: 'select' | 'update' | null = null;
    filters: Record<string, unknown> = {};
    values: Record<string, unknown> | null = null;

    constructor(readonly table: string) {}

    select(...args: unknown[]) {
      void args;
      if (!this.action) this.action = 'select';
      return this;
    }

    update(values: Record<string, unknown>) {
      this.action = 'update';
      this.values = values;
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters[column] = value;
      return this;
    }

    like(column: string, value: unknown) {
      this.filters[column] = value;
      return this;
    }

    in(column: string, value: unknown) {
      this.filters[column] = value;
      return this;
    }

    order() {
      return this;
    }

    range() {
      return this.execute();
    }

    execute(): Promise<QueryResult> {
      if (this.action === 'select' && this.table === 'generations') {
        return Promise.resolve({ data: [IMAGE_GENERATION], error: null });
      }
      if (this.action === 'select' && this.table === 'posts') {
        return Promise.resolve({
          data: [{ id: 'post-1', output_url: IMAGE_GENERATION.output_url }],
          error: null,
        });
      }
      if (this.action === 'update' && this.table === 'generations') {
        generationUpdates.push(this.values ?? {});
        return Promise.resolve({ data: [{ id: IMAGE_GENERATION.id }], error: null });
      }
      if (this.action === 'update' && this.table === 'posts') {
        postUpdates.push(this.values ?? {});
        return Promise.resolve({ data: [{ id: 'post-1' }], error: null });
      }
      throw new Error(`Unexpected query: ${this.table}/${this.action}`);
    }

    then<TResult1 = QueryResult, TResult2 = never>(
      onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return this.execute().then(onfulfilled, onrejected);
    }
  }

  return {
    client: {
      from: (table: string) => new QueryBuilder(table),
      storage: {
        from: () => ({
          exists: vi.fn().mockResolvedValue(objectExists
            ? { data: true, error: null }
            : { data: false, error: { status: 404 } }),
          upload,
          remove,
        }),
      },
    },
    generationUpdates,
    postUpdates,
    remove,
    upload,
  };
}

const silentLogger = {
  error: vi.fn(),
  log: vi.fn(),
};

describe('legacy temporary media backfill', () => {
  it('parses and validates an optional generation id filter', () => {
    const id = '24F5537E-F5DB-4A26-8DB3-C3D89F3ED261';
    expect(parseGenerationIdArgument([`--generation-id=${id}`])).toBe(id.toLowerCase());
    expect(parseGenerationIdArgument(['--generation-id', id])).toBe(id.toLowerCase());
    expect(parseGenerationIdArgument([])).toBeNull();
    expect(() => parseGenerationIdArgument(['--generation-id=not-a-uuid'])).toThrow(/canonical UUID/);
    expect(() => parseGenerationIdArgument([
      `--generation-id=${id}`,
      '--generation-id',
      id,
    ])).toThrow(/only be supplied once/);
  });

  it('builds deterministic owner-scoped image and video targets', () => {
    expect(buildStorageTarget(IMAGE_GENERATION)).toMatchObject({
      bucket: 'generated_images',
      extension: 'jpg',
      filePath: `${IMAGE_GENERATION.user_id}/generated_${IMAGE_GENERATION.prediction_id}.jpg`,
    });
    expect(buildStorageTarget({
      ...IMAGE_GENERATION,
      output_url: 'https://tempfile.aiquickdraw.com/r/result.mp4',
      model: 'kling-2.6/motion-control',
      category: null,
    })).toMatchObject({
      bucket: 'generated_videos',
      extension: 'mp4',
      kind: 'video',
    });
    expect(buildStorageTarget({ ...IMAGE_GENERATION, user_id: '../other-user' })).toBeNull();
    expect(inferMediaTarget(IMAGE_GENERATION, 'text/html')).toBeNull();
  });

  it('reuses an exact durable object without fetching or uploading and relinks posts', async () => {
    const supabase = createSupabaseMock({ objectExists: true });
    const fetcher = vi.fn(() => {
      throw new Error('fetch must not run when the exact object exists');
    });

    const result = await runBackfill({
      supabase: supabase.client as never,
      dryRun: false,
      fetcher: fetcher as never,
      logger: silentLogger,
    });

    expect(result).toMatchObject({ migrated: 1, failed: 0, skipped: 0, exitCode: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(supabase.upload).not.toHaveBeenCalled();
    expect(supabase.generationUpdates).toEqual([expect.objectContaining({
      output_url: `generated_images/${IMAGE_GENERATION.user_id}/generated_${IMAGE_GENERATION.prediction_id}.jpg`,
      preview_status: 'pending',
      preview_attempt_count: 0,
      preview_error: null,
    })]);
    expect(supabase.postUpdates).toEqual([{
      output_url: `generated_images/${IMAGE_GENERATION.user_id}/generated_${IMAGE_GENERATION.prediction_id}.jpg`,
    }]);
  });

  it('fails closed with a nonzero summary when the source and durable object are missing', async () => {
    const supabase = createSupabaseMock({ objectExists: false });
    const fetcher = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }));

    const result = await runBackfill({
      supabase: supabase.client as never,
      dryRun: true,
      fetcher,
      logger: silentLogger,
    });

    expect(result).toMatchObject({ migrated: 0, failed: 1, skipped: 0, exitCode: 1 });
    expect(supabase.generationUpdates).toHaveLength(0);
    expect(supabase.postUpdates).toHaveLength(0);
    expect(supabase.upload).not.toHaveBeenCalled();
    expect(supabase.remove).not.toHaveBeenCalled();
  });
});
