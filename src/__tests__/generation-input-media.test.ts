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

  // A remixed reference keeps the original creator's storagePath (for lineage)
  // while its resolved sourceUrl points at the caller-owned copy imported at
  // dispatch time. The durable snapshot must download that copy from storage —
  // the signed URL's host is not on the remote-media allowlist.
  it('persists a remixed reference from the caller-owned imported copy', async () => {
    const { persistGenerationInputMedia } = await import('@/lib/generation-input-media');

    const download = vi.fn(async () => ({
      data: new Blob(['imported-copy'], { type: 'image/jpeg' }),
      error: null,
    }));
    const upload = vi.fn(async () => ({ error: null }));
    const insert = vi.fn(async () => ({ error: null }));
    const supabase = {
      storage: {
        from: vi.fn((bucket: string) => {
          expect(bucket).toBe('generation_inputs');
          return { download, upload };
        }),
      },
      from: vi.fn(() => ({ insert })),
    };

    await persistGenerationInputMedia({
      supabase: supabase as never,
      generationId: 'gen-1',
      userId: 'user-1',
      candidates: [{
        mediaType: 'image',
        role: 'reference_image',
        label: 'Reference image',
        sourceStoragePath: 'generation_inputs/creator-1/gen-9/00-reference_image.jpg',
        sourceUrl: 'https://project.supabase.co/storage/v1/object/sign/generation_inputs/user-1/remix-imports/gen-9/00-reference_image.jpg?token=copy',
      }],
    });

    expect(download).toHaveBeenCalledWith('user-1/remix-imports/gen-9/00-reference_image.jpg');
    expect(upload).toHaveBeenCalledWith(
      'user-1/gen-1/00-reference_image.jpg',
      expect.any(Blob),
      expect.objectContaining({ contentType: 'image/jpeg' })
    );
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      storage_path: 'generation_inputs/user-1/gen-1/00-reference_image.jpg',
      metadata: expect.objectContaining({
        sourceStoragePath: 'generation_inputs/creator-1/gen-9/00-reference_image.jpg',
      }),
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

describe('generation input media loading', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('batch-signs unique owned paths once per storage bucket', async () => {
    const { loadGenerationInputMediaMap } = await import('@/lib/generation-input-media');
    const rows = [
      {
        id: 'input-1',
        generation_id: 'gen-1',
        user_id: 'user-1',
        media_type: 'image',
        role: 'reference_image',
        label: 'Product',
        storage_path: 'generation_inputs/user-1/gen-1/product.png',
        source_generation_id: null,
        sort_order: 0,
        metadata: null,
      },
      {
        id: 'input-2',
        generation_id: 'gen-1',
        user_id: 'user-1',
        media_type: 'image',
        role: 'reference_image',
        label: 'Logo',
        storage_path: 'uploads/user-1/logo.png',
        source_generation_id: null,
        sort_order: 1,
        metadata: null,
      },
      {
        id: 'input-3',
        generation_id: 'gen-2',
        user_id: 'user-1',
        media_type: 'image',
        role: 'reference_image',
        label: 'Shared logo',
        storage_path: 'uploads/user-1/logo.png',
        source_generation_id: null,
        sort_order: 0,
        metadata: null,
      },
    ];
    const signers = new Map<string, ReturnType<typeof vi.fn>>();
    const storageFrom = vi.fn((bucket: string) => {
      const createSignedUrls = vi.fn(async (paths: string[]) => ({
        data: paths.map((path) => ({
          error: null,
          path,
          signedUrl: `https://signed.example.com/${bucket}/${path}`,
        })),
        error: null,
      }));
      signers.set(bucket, createSignedUrls);
      return { createSignedUrls };
    });
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn(() => ({
            order: vi.fn(async () => ({ data: rows, error: null })),
          })),
        })),
      })),
      storage: { from: storageFrom },
    };

    const result = await loadGenerationInputMediaMap({
      supabase: supabase as never,
      generationIds: ['gen-1', 'gen-2', 'gen-1'],
      urlMode: 'signed',
    });

    expect(storageFrom).toHaveBeenCalledTimes(2);
    expect(signers.get('generation_inputs')).toHaveBeenCalledWith(
      ['user-1/gen-1/product.png'],
      3600,
    );
    expect(signers.get('uploads')).toHaveBeenCalledWith(['user-1/logo.png'], 3600);
    expect(result.get('gen-1')?.map((item) => item.url)).toEqual([
      'https://signed.example.com/generation_inputs/user-1/gen-1/product.png',
      'https://signed.example.com/uploads/user-1/logo.png',
    ]);
    expect(result.get('gen-2')?.[0]?.url).toBe(
      'https://signed.example.com/uploads/user-1/logo.png',
    );
  });

  it('does not sign or expose a storage object outside the row owner prefix', async () => {
    const { loadGenerationInputMediaMap } = await import('@/lib/generation-input-media');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const storageFrom = vi.fn();
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn(() => ({
            order: vi.fn(async () => ({
              data: [{
                id: 'input-1',
                generation_id: 'gen-1',
                user_id: 'user-1',
                media_type: 'image',
                role: 'reference_image',
                label: null,
                storage_path: 'uploads/user-2/private.png',
                source_generation_id: null,
                sort_order: 0,
                metadata: null,
              }],
              error: null,
            })),
          })),
        })),
      })),
      storage: { from: storageFrom },
    };

    const result = await loadGenerationInputMediaMap({
      supabase: supabase as never,
      generationIds: ['gen-1'],
      urlMode: 'signed',
    });

    expect(storageFrom).not.toHaveBeenCalled();
    expect(result.get('gen-1')?.[0]).toMatchObject({ url: null, storagePath: null });
  });

  it('keeps successful signed URLs when another file in the batch fails', async () => {
    const { loadGenerationInputMediaMap } = await import('@/lib/generation-input-media');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rows = ['ok.png', 'missing.png'].map((fileName, index) => ({
      id: `input-${index}`,
      generation_id: 'gen-1',
      user_id: 'user-1',
      media_type: 'image',
      role: 'reference_image',
      label: null,
      storage_path: `uploads/user-1/${fileName}`,
      source_generation_id: null,
      sort_order: index,
      metadata: null,
    }));
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn(() => ({
            order: vi.fn(async () => ({ data: rows, error: null })),
          })),
        })),
      })),
      storage: {
        from: vi.fn(() => ({
          createSignedUrls: vi.fn(async () => ({
            data: [
              {
                error: null,
                path: 'user-1/ok.png',
                signedUrl: 'https://signed.example.com/uploads/user-1/ok.png',
              },
              { error: 'Object not found', path: 'user-1/missing.png', signedUrl: null },
            ],
            error: null,
          })),
        })),
      },
    };

    const result = await loadGenerationInputMediaMap({
      supabase: supabase as never,
      generationIds: ['gen-1'],
      urlMode: 'signed',
    });

    expect(result.get('gen-1')?.map((item) => item.url)).toEqual([
      'https://signed.example.com/uploads/user-1/ok.png',
      null,
    ]);
  });

  it('builds legacy summary descriptors without storage signing or source-generation reads', async () => {
    const { buildLegacyGenerationInputMedia } = await import('@/lib/generation-input-media');
    const storageFrom = vi.fn();
    const from = vi.fn();

    const result = await buildLegacyGenerationInputMedia({
      supabase: { storage: { from: storageFrom }, from } as never,
      generationId: 'gen-1',
      ownerUserId: 'user-1',
      category: 'image',
      workflowSettings: {
        elements: [
          {
            id: 'stored-reference',
            displayName: 'Stored reference',
            handle: '@stored',
            storagePath: 'generation_inputs/user-1/gen-1/stored.png',
          },
          {
            id: 'source-reference',
            displayName: 'Source reference',
            handle: '@source',
            sourceGenerationId: 'source-gen-1',
          },
        ],
      },
      urlMode: 'none',
    });

    expect(result).toEqual([
      expect.objectContaining({
        storagePath: 'generation_inputs/user-1/gen-1/stored.png',
        sourceGenerationId: null,
        url: null,
      }),
      expect.objectContaining({
        storagePath: null,
        sourceGenerationId: 'source-gen-1',
        url: null,
      }),
    ]);
    expect(storageFrom).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});
