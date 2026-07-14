import { afterEach, describe, expect, it, vi } from 'vitest';

describe('generation input media persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('routes external input media through the guarded downloader', async () => {
    const { persistGenerationInputMedia } = await import('@/lib/generation-input-media');
    const downloadRemoteMedia = vi.fn(async () => ({
      blob: new Blob(['image'], { type: 'image/png' }),
      sourceName: 'reference.png',
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
      downloadRemoteMedia,
    });

    expect(downloadRemoteMedia).toHaveBeenCalledWith({
      url: 'https://provider.example.com/reference.png',
      kind: 'image',
    });
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

  it('does not read a storage path outside the authenticated user prefix', async () => {
    const { persistGenerationInputMedia } = await import('@/lib/generation-input-media');
    const download = vi.fn();
    const upload = vi.fn();
    const insert = vi.fn();
    const supabase = {
      storage: { from: vi.fn(() => ({ download, upload })) },
      from: vi.fn(() => ({ insert })),
    };

    await persistGenerationInputMedia({
      supabase: supabase as never,
      generationId: 'gen-1',
      userId: 'attacker-1',
      candidates: [{
        mediaType: 'image',
        role: 'reference_image',
        sourceStoragePath: 'generation_inputs/victim-1/public-generation/00-reference_image.png',
      }],
    });

    expect(download).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
