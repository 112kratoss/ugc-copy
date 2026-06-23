import { afterEach, describe, expect, it, vi } from 'vitest';

describe('generation input media persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('bounds external input media downloads with a timeout signal', async () => {
    const { persistGenerationInputMedia } = await import('@/lib/generation-input-media');
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

    const upload = vi.fn(async () => ({ error: null }));
    const insert = vi.fn(async () => ({ error: null }));
    const supabase = {
      storage: {
        from: vi.fn((bucket: string) => {
          expect(bucket).toBe('generation_inputs');
          return { upload };
        }),
      },
      from: vi.fn((table: string) => {
        expect(table).toBe('generation_input_media');
        return { insert };
      }),
    };

    await persistGenerationInputMedia({
      supabase: supabase as never,
      generationId: 'gen-1',
      userId: 'user-1',
      candidates: [{
        mediaType: 'image',
        role: 'reference_image',
        label: 'Reference image',
        sourceUrl: 'https://provider.example.com/reference.png',
      }],
    });

    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(requestInit?.signal).toBe(timeoutSignal);
    expect(upload).toHaveBeenCalledWith(
      'user-1/gen-1/00-reference_image.png',
      expect.any(Blob),
      expect.objectContaining({ contentType: 'image/png' })
    );
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      generation_id: 'gen-1',
      user_id: 'user-1',
      media_type: 'image',
      storage_path: 'generation_inputs/user-1/gen-1/00-reference_image.png',
    }));
  });
});
