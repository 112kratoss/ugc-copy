import { afterEach, describe, expect, it, vi } from 'vitest';

import { canRepairPreview, hasRepairableMediaPreviews } from '@/lib/media-preview-repair';

const previewMocks = vi.hoisted(() => ({
  createPostMediaPreview: vi.fn(async () => ({
    previewStoragePath: 'posts/user/source.preview.abc123.webp',
    previewThumbhash: 'thumbhash',
    previewStatus: 'ready',
    width: 400,
    height: 300,
  })),
}));

vi.mock('@/lib/post-media-preview', () => ({
  createPostMediaPreview: previewMocks.createPostMediaPreview,
}));

vi.mock('@/lib/generation-media-preview', () => ({
  createGenerationOutputPreview: vi.fn(),
}));

function createSelectChain(result: unknown) {
  const chain = {
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    lt: vi.fn(() => chain),
    not: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(async () => result),
  };
  return chain;
}

function createRepairableProbeClient(results: Array<{ data: unknown[] | null; error: Error | null }>) {
  const limit = vi.fn(async () => {
    const result = results.shift();
    if (!result) throw new Error('Unexpected repairable probe query');
    return result;
  });
  const not = vi.fn(() => ({ limit }));
  const lt = vi.fn(() => ({ not }));
  const inFilter = vi.fn(() => ({ in: inFilter, lt }));
  const eq = vi.fn(() => ({ in: inFilter }));
  const select = vi.fn(() => ({ eq, in: inFilter }));
  const from = vi.fn(() => ({ select }));

  return {
    from,
    select,
    eq,
    in: inFilter,
    lt,
    not,
    limit,
  };
}

describe('media preview repair retries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    previewMocks.createPostMediaPreview.mockClear();
  });

  it('retries pending work at most three times', () => {
    expect(canRepairPreview(null)).toBe(true);
    expect(canRepairPreview(0)).toBe(true);
    expect(canRepairPreview(2)).toBe(true);
    expect(canRepairPreview(3)).toBe(false);
  });

  it('checks repairable preview work with one-row probes', async () => {
    const supabase = createRepairableProbeClient([
      { data: [], error: null },
      { data: [{ id: 'media-1' }], error: null },
    ]);

    await expect(hasRepairableMediaPreviews(supabase as never)).resolves.toBe(true);

    expect(supabase.from).toHaveBeenNthCalledWith(1, 'generations');
    expect(supabase.eq).toHaveBeenCalledWith('status', 'succeeded');
    expect(supabase.in).toHaveBeenCalledWith('category', ['image', 'video']);
    expect(supabase.in).toHaveBeenCalledWith('preview_status', ['pending', 'failed', 'processing']);
    expect(supabase.lt).toHaveBeenCalledWith('preview_attempt_count', 3);
    expect(supabase.not).toHaveBeenCalledWith('output_url', 'is', null);
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'post_media');
    expect(supabase.not).toHaveBeenCalledWith('storage_path', 'is', null);
    expect(supabase.limit).toHaveBeenCalledWith(1);
  });

  it('downloads post media from the showcase media bucket by storage path', async () => {
    const { repairMediaPreviews } = await import('@/lib/media-preview-repair');
    const download = vi.fn(async () => ({
      data: new Blob(['image'], { type: 'image/png' }),
      error: null,
    }));
    const storageFrom = vi.fn(() => ({ download }));
    const updates: Array<{ table: string; payload: unknown }> = [];
    const supabase = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => createSelectChain({
          data: table === 'post_media'
            ? [{
                id: 'media-1',
                storage_path: 'posts/user/source.png',
                media_kind: 'image',
                content_type: 'image/png',
                preview_attempt_count: 0,
              }]
            : [],
          error: null,
        })),
        update: vi.fn((payload: unknown) => {
          updates.push({ table, payload });
          return { eq: vi.fn(async () => ({ error: null })) };
        }),
      })),
      storage: { from: storageFrom },
    };

    const summary = await repairMediaPreviews(supabase as never, { batchSize: 10 });

    expect(summary).toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(storageFrom).toHaveBeenCalledWith('showcase_media');
    expect(download).toHaveBeenCalledWith('posts/user/source.png');
    expect(previewMocks.createPostMediaPreview).toHaveBeenCalledWith(expect.objectContaining({
      storagePath: 'posts/user/source.png',
      contentType: 'image/png',
    }));
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'post_media',
        payload: expect.objectContaining({ preview_status: 'ready' }),
      }),
    ]));
  });
});
