import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('durable generation media', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reuses an existing private generated-media path', async () => {
    const storageFrom = vi.fn();
    const { ensureDurableGenerationMedia } = await import('@/lib/durable-generation-media');

    const result = await ensureDurableGenerationMedia({
      supabase: {
        storage: {
          from: storageFrom,
        },
      } as never,
      generation: {
        id: 'gen-1',
        userId: 'user-1',
        model: 'nano-banana-2',
        category: 'image',
        outputUrl: 'generated_images/user-1/existing.jpg',
        showcaseAssetPath: 'showcase/gen-1/existing.jpg',
      },
    });

    expect(result).toEqual({
      outputUrl: 'generated_images/user-1/existing.jpg',
      createdLocation: null,
    });
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it('copies a working showcase derivative into private generated storage', async () => {
    const download = vi.fn(async () => ({
      data: new Blob(['image-bytes'], { type: 'image/jpeg' }),
      error: null,
    }));
    const upload = vi.fn(async () => ({ data: null, error: null }));
    const storageFrom = vi.fn((bucket: string) => {
      if (bucket === 'showcase_media') {
        return { download };
      }

      if (bucket === 'generated_images') {
        return { upload };
      }

      throw new Error(`Unexpected bucket: ${bucket}`);
    });
    const { ensureDurableGenerationMedia } = await import('@/lib/durable-generation-media');

    const result = await ensureDurableGenerationMedia({
      supabase: {
        storage: {
          from: storageFrom,
        },
      } as never,
      generation: {
        id: 'gen-1',
        userId: 'user-1',
        model: 'nano-banana-2',
        category: 'image',
        outputUrl: 'https://provider.example.com/expired.jpg',
        showcaseAssetPath: 'showcase/gen-1/working.jpg',
      },
    });

    expect(download).toHaveBeenCalledWith('showcase/gen-1/working.jpg');
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^user-1\/restored_gen-1_.+\.jpg$/),
      expect.any(Blob),
      expect.objectContaining({
        contentType: 'image/jpeg',
        upsert: false,
      })
    );
    expect(result.outputUrl).toMatch(/^generated_images\/user-1\/restored_gen-1_.+\.jpg$/);
    expect(result.createdLocation).toEqual({
      bucket: 'generated_images',
      filePath: result.outputUrl.replace('generated_images/', ''),
    });
  });

  it('fails without uploading when neither the showcase derivative nor provider URL can be loaded', async () => {
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    let requestInit: RequestInit | undefined;
    const download = vi.fn(async () => ({
      data: null,
      error: { message: 'missing' },
    }));
    const upload = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response(null, { status: 404 });
    }));
    const storageFrom = vi.fn((bucket: string) => {
      if (bucket === 'showcase_media') {
        return { download };
      }

      return { upload };
    });
    const { ensureDurableGenerationMedia } = await import('@/lib/durable-generation-media');

    await expect(ensureDurableGenerationMedia({
      supabase: {
        storage: {
          from: storageFrom,
        },
      } as never,
      generation: {
        id: 'gen-1',
        userId: 'user-1',
        model: 'nano-banana-2',
        category: 'image',
        outputUrl: 'https://provider.example.com/expired.jpg',
        showcaseAssetPath: 'showcase/gen-1/missing.jpg',
      },
    })).rejects.toThrow(/could not be loaded/i);

    expect(upload).not.toHaveBeenCalled();
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(requestInit?.signal).toBe(timeoutSignal);
  });
});
