import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

type GenerationRow = {
  id: string;
  user_id: string;
  status: string;
  model: string;
  category: string | null;
  output_url: string | null;
  showcase_asset_path: string | null;
  is_public: boolean;
};

type LinkedPostRow = {
  id: string;
  visibility: 'public' | 'unlisted' | 'private';
  output_url: string | null;
  showcase_asset_path: string | null;
};

let generationState: GenerationRow | null = null;
let linkedPostState: LinkedPostRow | null = null;
let postUpdateError: { message: string } | null = null;
let generationRollbackError: { message: string } | null = null;
const generationUpdates: Array<Record<string, unknown>> = [];
const postUpdates: Array<Record<string, unknown>> = [];
const storageRemoveCalls: Array<{ bucket: string; paths: string[] }> = [];
const downloadMock = vi.fn();
const persistGenerationMediaBlobMock = vi.fn();
const isCompatibleGenerationMediaTypeMock = vi.fn();

vi.mock('@/lib/durable-generation-media', () => ({
  persistGenerationMediaBlob: (...args: unknown[]) => persistGenerationMediaBlobMock(...args),
  isCompatibleGenerationMediaType: (...args: unknown[]) => isCompatibleGenerationMediaTypeMock(...args),
}));

function makeMaybeSingleQuery<T>(value: () => T | null) {
  const query = {
    eq() {
      return query;
    },
    async maybeSingle() {
      return {
        data: value(),
        error: null,
      };
    },
  };
  return query;
}

function makeUpdateQuery(error: () => { message: string } | null) {
  const query = {
    eq() {
      return query;
    },
    then(resolve: (result: { error: { message: string } | null }) => void) {
      resolve({ error: error() });
    },
  };
  return query;
}

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
  }),
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'generations') {
        return {
          select() {
            return makeMaybeSingleQuery(() => generationState);
          },
          update(payload: Record<string, unknown>) {
            generationUpdates.push(payload);
            return makeUpdateQuery(() => generationUpdates.length > 1 ? generationRollbackError : null);
          },
        };
      }

      if (table === 'posts') {
        return {
          select() {
            return makeMaybeSingleQuery(() => linkedPostState);
          },
          update(payload: Record<string, unknown>) {
            postUpdates.push(payload);
            return makeUpdateQuery(() => postUpdateError);
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
    storage: {
      from(bucket: string) {
        return {
          download: downloadMock,
          async remove(paths: string[]) {
            storageRemoveCalls.push({ bucket, paths });
            return { data: null, error: null };
          },
        };
      },
    },
  }),
}));

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/generations/gen-1/restore-media', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer token',
    },
    body: JSON.stringify(body),
  }) as NextRequest;
}

const routeContext = {
  params: Promise.resolve({ id: 'gen-1' }),
};

describe('/api/generations/[id]/restore-media route', () => {
  beforeEach(() => {
    vi.resetModules();
    generationState = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      output_url: 'https://provider.example.com/missing.jpg',
      showcase_asset_path: null,
      is_public: false,
    };
    linkedPostState = {
      id: 'post-1',
      visibility: 'private',
      output_url: 'https://provider.example.com/missing.jpg',
      showcase_asset_path: null,
    };
    postUpdateError = null;
    generationRollbackError = null;
    generationUpdates.length = 0;
    postUpdates.length = 0;
    storageRemoveCalls.length = 0;
    downloadMock.mockReset();
    downloadMock.mockResolvedValue({
      data: new Blob(['replacement-image'], { type: 'image/png' }),
      error: null,
    });
    persistGenerationMediaBlobMock.mockReset();
    persistGenerationMediaBlobMock.mockResolvedValue({
      outputUrl: 'generated_images/user-1/restored-gen-1.png',
      createdLocation: {
        bucket: 'generated_images',
        filePath: 'user-1/restored-gen-1.png',
      },
    });
    isCompatibleGenerationMediaTypeMock.mockReset();
    isCompatibleGenerationMediaTypeMock.mockReturnValue(true);
  });

  it('restores a private generation and its linked private post from an owner upload', async () => {
    const { POST } = await import('@/app/api/generations/[id]/restore-media/route');
    const response = await POST(makeRequest({
      storagePath: 'uploads/user-1/replacement.png',
      originalName: 'replacement.png',
      contentType: 'image/png',
    }), routeContext);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(downloadMock).toHaveBeenCalledWith('user-1/replacement.png');
    expect(persistGenerationMediaBlobMock).toHaveBeenCalledWith(expect.objectContaining({
      generation: expect.objectContaining({
        id: 'gen-1',
        userId: 'user-1',
      }),
      sourceName: 'replacement.png',
    }));
    expect(generationUpdates[0]).toMatchObject({
      output_url: 'generated_images/user-1/restored-gen-1.png',
      showcase_asset_path: null,
      is_public: false,
    });
    expect(postUpdates[0]).toMatchObject({
      output_url: 'generated_images/user-1/restored-gen-1.png',
      showcase_asset_path: null,
    });
    expect(storageRemoveCalls).toContainEqual({
      bucket: 'uploads',
      paths: ['user-1/replacement.png'],
    });
    expect(data).toMatchObject({
      success: true,
      outputUrl: 'generated_images/user-1/restored-gen-1.png',
    });
  });

  it('rejects uploads outside the authenticated user folder', async () => {
    const { POST } = await import('@/app/api/generations/[id]/restore-media/route');
    const response = await POST(makeRequest({
      storagePath: 'uploads/other-user/replacement.png',
      originalName: 'replacement.png',
      contentType: 'image/png',
    }), routeContext);

    expect(response.status).toBe(400);
    expect(downloadMock).not.toHaveBeenCalled();
    expect(persistGenerationMediaBlobMock).not.toHaveBeenCalled();
  });

  it('rejects a replacement whose media type does not match the generation', async () => {
    isCompatibleGenerationMediaTypeMock.mockReturnValue(false);

    const { POST } = await import('@/app/api/generations/[id]/restore-media/route');
    const response = await POST(makeRequest({
      storagePath: 'uploads/user-1/replacement.mp4',
      originalName: 'replacement.mp4',
      contentType: 'video/mp4',
    }), routeContext);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toMatch(/does not match/i);
    expect(persistGenerationMediaBlobMock).not.toHaveBeenCalled();
    expect(storageRemoveCalls).toContainEqual({
      bucket: 'uploads',
      paths: ['user-1/replacement.mp4'],
    });
  });

  it('rolls back the generation and removes the new object when the linked post update fails', async () => {
    postUpdateError = { message: 'post update failed' };

    const { POST } = await import('@/app/api/generations/[id]/restore-media/route');
    const response = await POST(makeRequest({
      storagePath: 'uploads/user-1/replacement.png',
      originalName: 'replacement.png',
      contentType: 'image/png',
    }), routeContext);

    expect(response.status).toBe(500);
    expect(generationUpdates).toEqual([
      expect.objectContaining({
        output_url: 'generated_images/user-1/restored-gen-1.png',
      }),
      expect.objectContaining({
        output_url: 'https://provider.example.com/missing.jpg',
      }),
    ]);
    expect(storageRemoveCalls).toContainEqual({
      bucket: 'generated_images',
      paths: ['user-1/restored-gen-1.png'],
    });
  });

  it('keeps the new private object when the linked post update and generation rollback both fail', async () => {
    postUpdateError = { message: 'post update failed' };
    generationRollbackError = { message: 'rollback failed' };

    const { POST } = await import('@/app/api/generations/[id]/restore-media/route');
    const response = await POST(makeRequest({
      storagePath: 'uploads/user-1/replacement.png',
      originalName: 'replacement.png',
      contentType: 'image/png',
    }), routeContext);

    expect(response.status).toBe(500);
    expect(storageRemoveCalls).not.toContainEqual({
      bucket: 'generated_images',
      paths: ['user-1/restored-gen-1.png'],
    });
  });
});
