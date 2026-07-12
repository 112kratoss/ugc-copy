import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  restoreGenerationMediaForRoute,
  type GenerationRestoreMediaDependencies,
} from '@/lib/generation-restore-media-service';

function makeMaybeSingleQuery<T>(value: () => T | null) {
  const query = {
    eq() {
      return query;
    },
    is() {
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

function makeUpdateQuery() {
  const query = {
    eq() {
      return query;
    },
    is() {
      return query;
    },
    then(resolve: (result: { error: null }) => void) {
      resolve({ error: null });
    },
  };
  return query;
}

function createAdminClientMock() {
  const generation = {
    id: 'gen-1',
    user_id: 'user-1',
    status: 'succeeded',
    model: 'nano-banana-2',
    category: 'image',
    output_url: 'https://provider.example.com/missing.jpg',
    showcase_asset_path: null,
    is_public: false,
  };
  const linkedPost = {
    id: 'post-1',
    visibility: 'private',
    output_url: 'https://provider.example.com/missing.jpg',
    showcase_asset_path: null,
  };
  const generationUpdates: Array<Record<string, unknown>> = [];
  const postUpdates: Array<Record<string, unknown>> = [];
  const storageRemoveCalls: Array<{ bucket: string; paths: string[] }> = [];
  const downloadMock = vi.fn(async () => ({
    data: new Blob(['replacement-image'], { type: 'image/png' }),
    error: null,
  }));

  const client = {
    from(table: string) {
      if (table === 'generations') {
        return {
          select() {
            return makeMaybeSingleQuery(() => generation);
          },
          update(payload: Record<string, unknown>) {
            generationUpdates.push(payload);
            return makeUpdateQuery();
          },
        };
      }

      if (table === 'posts') {
        return {
          select() {
            return makeMaybeSingleQuery(() => linkedPost);
          },
          update(payload: Record<string, unknown>) {
            postUpdates.push(payload);
            return makeUpdateQuery();
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
  };

  return {
    client: client as unknown as SupabaseClient,
    downloadMock,
    generationUpdates,
    postUpdates,
    storageRemoveCalls,
  };
}

describe('restoreGenerationMediaForRoute', () => {
  it('restores a private generation and linked private post from an owner upload', async () => {
    const admin = createAdminClientMock();
    const dependencies = {
      isCompatibleGenerationMediaType: vi.fn(() => true),
      persistGenerationMediaBlob: vi.fn(async () => ({
        outputUrl: 'generated_images/user-1/restored-gen-1.png',
        createdLocation: {
          bucket: 'generated_images',
          filePath: 'user-1/restored-gen-1.png',
        },
      })),
    } satisfies Partial<GenerationRestoreMediaDependencies>;

    const result = await restoreGenerationMediaForRoute({
      adminSupabase: admin.client,
      body: {
        storagePath: 'uploads/user-1/replacement.png',
        originalName: 'replacement.png',
        contentType: 'image/png',
      },
      generationId: 'gen-1',
      userId: 'user-1',
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        outputUrl: 'generated_images/user-1/restored-gen-1.png',
      },
    });
    expect(admin.downloadMock).toHaveBeenCalledWith('user-1/replacement.png');
    expect(dependencies.persistGenerationMediaBlob).toHaveBeenCalledWith(expect.objectContaining({
      generation: expect.objectContaining({
        id: 'gen-1',
        userId: 'user-1',
      }),
      sourceName: 'replacement.png',
      contentType: 'image/png',
    }));
    expect(admin.generationUpdates[0]).toMatchObject({
      output_url: 'generated_images/user-1/restored-gen-1.png',
      showcase_asset_path: null,
      is_public: false,
    });
    expect(admin.postUpdates[0]).toMatchObject({
      output_url: 'generated_images/user-1/restored-gen-1.png',
      showcase_asset_path: null,
    });
    expect(admin.storageRemoveCalls).toContainEqual({
      bucket: 'uploads',
      paths: ['user-1/replacement.png'],
    });
  });
});
