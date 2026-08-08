import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/lib/generation-output-preview', () => ({
  createGenerationOutputPreview: vi.fn(),
}));

const renditionMocks = vi.hoisted(() => ({
  createPostMediaRendition: vi.fn(async () => ({
    status: 'ready' as const,
    renditionStoragePath: 'posts/user/clip.feed.abc123.mp4',
    renditionBytes: 2_031_616,
    width: 610,
    height: 1280,
    durationSeconds: 11.4,
  })),
}));

vi.mock('@/lib/post-media-rendition', () => ({
  createPostMediaRendition: renditionMocks.createPostMediaRendition,
}));

/**
 * Applies `.eq()` filters for real. The preview and rendition sweeps both query
 * post_media and are separated only by their filters, so a chain that ignored
 * them would hand the same rows to both passes.
 */
function createSelectChain(result: { data: unknown[] | null; error: Error | null }) {
  const equalities: Array<[string, unknown]> = [];
  const resolve = () => {
    if (!result.data) return result;
    // Filter only on columns a fixture actually models. Fixtures list just
    // the columns their case cares about, and treating an absent one as a
    // mismatch would drop rows the real query would have returned.
    const data = result.data.filter((row) => equalities.every(
      ([column, value]) => !(column in (row as Record<string, unknown>))
        || (row as Record<string, unknown>)[column] === value,
    ));
    return { ...result, data };
  };
  const chain = {
    eq: vi.fn((column: string, value: unknown) => {
      equalities.push([column, value]);
      return chain;
    }),
    in: vi.fn(() => chain),
    lt: vi.fn(() => chain),
    not: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(async () => resolve()),
    // Thenable so a query that ends at `.order()` resolves too: the per-post
    // repair is bounded by one post's media and takes no limit.
    then: (
      onfulfilled?: ((value: ReturnType<typeof resolve>) => unknown) | null,
      onrejected?: ((reason: unknown) => unknown) | null,
    ) => Promise.resolve(resolve()).then(onfulfilled, onrejected),
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    previewMocks.createPostMediaPreview.mockClear();
    renditionMocks.createPostMediaRendition.mockClear();
    renditionMocks.createPostMediaRendition.mockResolvedValue({
      status: 'ready' as const,
      renditionStoragePath: 'posts/user/clip.feed.abc123.mp4',
      renditionBytes: 2_031_616,
      width: 610,
      height: 1280,
      durationSeconds: 11.4,
    });
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
    const invalidateFeedCache = vi.fn();

    const summary = await repairMediaPreviews(supabase as never, {
      batchSize: 10,
      invalidateFeedCache,
    });

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
    expect(invalidateFeedCache).toHaveBeenCalledOnce();
  });

  it('bounds external generation media downloads with a timeout signal', async () => {
    const { repairMediaPreviews } = await import('@/lib/media-preview-repair');
    const { createGenerationOutputPreview } = await import('@/lib/generation-output-preview');
    vi.mocked(createGenerationOutputPreview).mockResolvedValue({
      previewStoragePath: 'generated/user/output.preview.webp',
      previewThumbhash: 'thumbhash',
      previewStatus: 'ready',
    } as never);
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    let requestInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return {
        ok: true,
        blob: async () => new Blob(['image'], { type: 'image/png' }),
      } as Response;
    }));
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const supabase = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => createSelectChain({
          data: table === 'generations'
            ? [{
                id: 'gen-1',
                output_url: 'https://provider.example.com/output.png',
                category: 'image',
                preview_attempt_count: 0,
              }]
            : [],
          error: null,
        })),
        update: vi.fn((payload: Record<string, unknown>) => {
          updates.push({ table, payload });
          return { eq: vi.fn(async () => ({ error: null })) };
        }),
      })),
      storage: { from: vi.fn() },
    };
    const invalidateFeedCache = vi.fn();

    const summary = await repairMediaPreviews(supabase as never, {
      batchSize: 10,
      invalidateFeedCache,
    });

    expect(summary).toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(requestInit?.signal).toBe(timeoutSignal);
    expect(createGenerationOutputPreview).toHaveBeenCalledWith(expect.objectContaining({
      storagePath: 'https://provider.example.com/output.png',
    }));
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'generations',
        payload: expect.objectContaining({ preview_status: 'ready' }),
      }),
    ]));
    expect(invalidateFeedCache).toHaveBeenCalledOnce();
  });

  it('keeps the feed cache intact when no preview repair completes', async () => {
    const { repairMediaPreviews } = await import('@/lib/media-preview-repair');
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => createSelectChain({ data: [], error: null })),
      })),
    };
    const invalidateFeedCache = vi.fn();

    await expect(repairMediaPreviews(supabase as never, {
      batchSize: 10,
      invalidateFeedCache,
    })).resolves.toEqual({ attempted: 0, completed: 0, failed: 0 });

    expect(invalidateFeedCache).not.toHaveBeenCalled();
  });
});

describe('showcase feed rendition repair', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    renditionMocks.createPostMediaRendition.mockClear();
  });

  function createRenditionClient(rows: Array<Record<string, unknown>>) {
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const download = vi.fn(async () => ({
      data: new Blob(['video'], { type: 'video/mp4' }),
      error: null,
    }));
    const storageFrom = vi.fn(() => ({ download }));
    const supabase = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => createSelectChain({
          data: table === 'post_media' ? rows : [],
          error: null,
        })),
        update: vi.fn((payload: Record<string, unknown>) => {
          updates.push({ table, payload });
          return { eq: vi.fn(async () => ({ error: null })) };
        }),
      })),
      storage: { from: storageFrom },
    };
    return { supabase, updates, download, storageFrom };
  }

  const pendingVideoRow = {
    id: 'media-video-1',
    storage_path: 'posts/user/clip.mp4',
    media_kind: 'video',
    content_type: 'video/mp4',
    preview_status: 'ready',
    preview_attempt_count: 1,
    rendition_status: 'pending',
    rendition_attempt_count: 0,
  };

  it('transcodes a pending video and records the rendition', async () => {
    const { repairPostMediaRenditions } = await import('@/lib/media-preview-repair');
    const { supabase, updates, download, storageFrom } = createRenditionClient([pendingVideoRow]);

    const summary = await repairPostMediaRenditions(supabase as never);

    expect(summary).toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(storageFrom).toHaveBeenCalledWith('showcase_media');
    expect(download).toHaveBeenCalledWith('posts/user/clip.mp4');
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'post_media',
        payload: expect.objectContaining({
          rendition_status: 'ready',
          rendition_storage_path: 'posts/user/clip.feed.abc123.mp4',
          rendition_bytes: 2_031_616,
          // Publish never captured these; the transcode is where we learn them.
          duration_seconds: 11.4,
          width: 610,
          height: 1280,
        }),
      }),
    ]));
  });

  it('stops taking new videos once the time budget is spent', async () => {
    // The sweep shares one 300s invocation with every other due job. A row
    // count bounds nothing useful, because each transcode may run for the full
    // ffmpeg timeout -- the old flat five rows could occupy 600s of those 300.
    const { repairPostMediaRenditions } = await import('@/lib/media-preview-repair');
    const rows = [1, 2, 3, 4].map((index) => ({
      ...pendingVideoRow,
      id: `media-video-${index}`,
      storage_path: `posts/user/clip-${index}.mp4`,
    }));
    const { supabase } = createRenditionClient(rows);
    const readyRendition = {
      status: 'ready' as const,
      renditionStoragePath: 'posts/user/clip.feed.abc123.mp4',
      renditionBytes: 2_031_616,
      width: 610,
      height: 1280,
      durationSeconds: 11.4,
    };

    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // Each transcode burns 40s of the 60s budget.
    renditionMocks.createPostMediaRendition.mockImplementation(async () => {
      clock += 40_000;
      return readyRendition;
    });

    try {
      const summary = await repairPostMediaRenditions(supabase as never, { timeBudgetMs: 60_000 });

      // Two rows fit. The budget is only consulted before starting a row, so
      // the second begins at 40s and the third is refused at 80s.
      expect(summary).toEqual({ attempted: 2, completed: 2, failed: 0 });
    } finally {
      // mockClear in afterEach keeps the implementation, which would otherwise
      // move a fake clock nothing else installed.
      renditionMocks.createPostMediaRendition.mockReset();
      renditionMocks.createPostMediaRendition.mockResolvedValue(readyRendition);
    }
  });

  it('always attempts one video even with no budget, so a slow queue head still drains', async () => {
    const { repairPostMediaRenditions } = await import('@/lib/media-preview-repair');
    const { supabase } = createRenditionClient([pendingVideoRow, { ...pendingVideoRow, id: 'media-video-2' }]);

    const summary = await repairPostMediaRenditions(supabase as never, { timeBudgetMs: 0 });

    expect(summary).toEqual({ attempted: 1, completed: 1, failed: 0 });
  });

  it('records a skipped rendition terminally so it is not retried', async () => {
    const { repairPostMediaRenditions } = await import('@/lib/media-preview-repair');
    renditionMocks.createPostMediaRendition.mockResolvedValue({
      status: 'skipped',
      reason: 'not-smaller',
    } as never);
    const { supabase, updates } = createRenditionClient([pendingVideoRow]);

    const summary = await repairPostMediaRenditions(supabase as never);

    // Counted as completed: declining is the correct terminal answer here.
    expect(summary).toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'post_media',
        payload: expect.objectContaining({ rendition_status: 'skipped' }),
      }),
    ]));
    expect(updates.some((update) => update.payload.rendition_status === 'ready')).toBe(false);
  });

  it('marks the row failed when the transcode throws', async () => {
    const { repairPostMediaRenditions } = await import('@/lib/media-preview-repair');
    renditionMocks.createPostMediaRendition.mockRejectedValue(new Error('ffmpeg exited with code 1'));
    const { supabase, updates } = createRenditionClient([pendingVideoRow]);

    const summary = await repairPostMediaRenditions(supabase as never);

    expect(summary).toEqual({ attempted: 1, completed: 0, failed: 1 });
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'post_media',
        payload: expect.objectContaining({
          rendition_status: 'failed',
          rendition_attempt_count: 1,
          rendition_error: 'ffmpeg exited with code 1',
        }),
      }),
    ]));
  });

  it('leaves image rows alone', async () => {
    const { repairPostMediaRenditions } = await import('@/lib/media-preview-repair');
    const { supabase } = createRenditionClient([{
      ...pendingVideoRow,
      id: 'media-image-1',
      media_kind: 'image',
      content_type: 'image/png',
    }]);

    await expect(repairPostMediaRenditions(supabase as never))
      .resolves.toEqual({ attempted: 0, completed: 0, failed: 0 });
    expect(renditionMocks.createPostMediaRendition).not.toHaveBeenCalled();
  });

  it('degrades to a no-op when the rendition columns are absent', async () => {
    const { repairPostMediaRenditions } = await import('@/lib/media-preview-repair');
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => createSelectChain({
          data: null,
          error: Object.assign(new Error('column post_media.rendition_status does not exist'), {
            code: '42703',
          }),
        })),
      })),
      storage: { from: vi.fn() },
    };

    await expect(repairPostMediaRenditions(supabase as never))
      .resolves.toEqual({ attempted: 0, completed: 0, failed: 0 });
    expect(renditionMocks.createPostMediaRendition).not.toHaveBeenCalled();
  });

  it('stops retrying once the attempt ceiling is reached', async () => {
    const { canRepairRendition, MAX_RENDITION_ATTEMPTS } = await import('@/lib/media-preview-repair');

    expect(MAX_RENDITION_ATTEMPTS).toBe(3);
    expect(canRepairRendition(null)).toBe(true);
    expect(canRepairRendition(2)).toBe(true);
    expect(canRepairRendition(3)).toBe(false);
  });
});

describe('per-post media repair', () => {
  // Earlier blocks leave implementations behind (mockClear keeps them), so this
  // one states its own rather than inheriting a rejecting transcode.
  beforeEach(() => {
    previewMocks.createPostMediaPreview.mockResolvedValue({
      previewStoragePath: 'posts/post-1/0/clip.preview.abc123.webp',
      previewThumbhash: 'thumbhash',
      previewStatus: 'ready',
      width: 400,
      height: 300,
    });
    renditionMocks.createPostMediaRendition.mockResolvedValue({
      status: 'ready' as const,
      renditionStoragePath: 'posts/post-1/0/clip.feed.abc123.mp4',
      renditionBytes: 2_031_616,
      width: 610,
      height: 1280,
      durationSeconds: 11.4,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    previewMocks.createPostMediaPreview.mockClear();
    renditionMocks.createPostMediaRendition.mockClear();
  });

  function createPostRepairClient(rows: Array<Record<string, unknown>>) {
    const updates: Array<Record<string, unknown>> = [];
    const selectFilters: Array<Array<[string, unknown]>> = [];
    const download = vi.fn(async () => ({
      data: new Blob(['media'], { type: 'video/mp4' }),
      error: null,
    }));
    const supabase = {
      from: vi.fn((table: string) => ({
        select: vi.fn(() => {
          const chain = createSelectChain({
            data: table === 'post_media' ? rows : [],
            error: null,
          });
          const filters: Array<[string, unknown]> = [];
          selectFilters.push(filters);
          const originalEq = chain.eq;
          chain.eq = vi.fn((column: string, value: unknown) => {
            filters.push([column, value]);
            return originalEq(column, value);
          });
          return chain;
        }),
        update: vi.fn((payload: Record<string, unknown>) => {
          updates.push(payload);
          return { eq: vi.fn(async () => ({ error: null })) };
        }),
      })),
      storage: { from: vi.fn(() => ({ download })) },
    };
    return { supabase, updates, download, selectFilters };
  }

  const pendingVideoRow = {
    id: 'media-video-1',
    post_id: 'post-1',
    storage_path: 'posts/post-1/0/clip.mp4',
    media_kind: 'video',
    content_type: 'video/mp4',
    preview_status: 'pending',
    preview_attempt_count: 0,
    rendition_status: 'pending',
    rendition_attempt_count: 0,
  };

  it('repairs only the named post and invalidates the feed once work lands', async () => {
    const { repairMediaForPost } = await import('@/lib/media-preview-repair');
    const { supabase, updates, selectFilters } = createPostRepairClient([
      pendingVideoRow,
      { ...pendingVideoRow, id: 'media-other', post_id: 'post-2' },
    ]);
    const invalidateFeedCache = vi.fn();

    const summary = await repairMediaForPost(supabase as never, 'post-1', { invalidateFeedCache });

    // Two rows exist, but only post-1's is in scope for both passes.
    expect(summary).toEqual({ attempted: 2, completed: 2, failed: 0 });
    expect(selectFilters.every((filters) => filters.some(
      ([column, value]) => column === 'post_id' && value === 'post-1',
    ))).toBe(true);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ preview_status: 'ready' }),
      expect.objectContaining({ rendition_status: 'ready' }),
    ]));
    expect(invalidateFeedCache).toHaveBeenCalledTimes(1);
  });

  it('leaves the feed cache alone when nothing was repaired', async () => {
    const { repairMediaForPost } = await import('@/lib/media-preview-repair');
    const { supabase } = createPostRepairClient([]);
    const invalidateFeedCache = vi.fn();

    const summary = await repairMediaForPost(supabase as never, 'post-1', { invalidateFeedCache });

    expect(summary).toEqual({ attempted: 0, completed: 0, failed: 0 });
    expect(invalidateFeedCache).not.toHaveBeenCalled();
  });

  it('still repairs previews when the rendition columns are absent', async () => {
    const { repairMediaForPost } = await import('@/lib/media-preview-repair');
    const updates: Array<Record<string, unknown>> = [];
    let selectCount = 0;
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => {
          selectCount += 1;
          // The preview read succeeds; the rendition read hits the missing column.
          return selectCount === 1
            ? createSelectChain({
              data: [{ ...pendingVideoRow, media_kind: 'image', content_type: 'image/png' }],
              error: null,
            })
            : createSelectChain({
              data: null,
              error: Object.assign(new Error('column post_media.rendition_status does not exist'), {
                code: '42703',
              }),
            });
        }),
        update: vi.fn((payload: Record<string, unknown>) => {
          updates.push(payload);
          return { eq: vi.fn(async () => ({ error: null })) };
        }),
      })),
      storage: {
        from: vi.fn(() => ({
          download: vi.fn(async () => ({
            data: new Blob(['image'], { type: 'image/png' }),
            error: null,
          })),
        })),
      },
    };
    const invalidateFeedCache = vi.fn();

    const summary = await repairMediaForPost(supabase as never, 'post-1', { invalidateFeedCache });

    expect(summary).toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ preview_status: 'ready' }),
    ]));
    expect(renditionMocks.createPostMediaRendition).not.toHaveBeenCalled();
  });
});
