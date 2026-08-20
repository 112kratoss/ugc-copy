import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  restoreGenerationMediaForRoute,
  type GenerationRestoreMediaDependencies,
} from '@/lib/generation-restore-media-service';

function makeMaybeSingleQuery<T>(
  value: () => T | null,
  onEq?: (column: string, filterValue: unknown) => void,
) {
  const query = {
    eq(column: string, filterValue: unknown) {
      onEq?.(column, filterValue);
      return query;
    },
    in() {
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

function makeUpdateQuery(onEq?: (column: string, filterValue: unknown) => void) {
  const query = {
    eq(column: string, filterValue: unknown) {
      onEq?.(column, filterValue);
      return query;
    },
    in() {
      return query;
    },
    is() {
      return query;
    },
    select() {
      return query;
    },
    async maybeSingle() {
      return { data: { id: 'updated-row' }, error: null };
    },
    then(resolve: (result: { data: { id: string }; error: null }) => void) {
      resolve({ data: { id: 'updated-row' }, error: null });
    },
  };
  return query;
}

function createAdminClientMock(options: {
  generationUserId?: string;
  linkedGuestIds?: string[];
} = {}) {
  const generationUserId = options.generationUserId ?? 'user-1';
  const generation = {
    id: 'gen-1',
    user_id: generationUserId,
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
  const ownerFilters: Array<{
    column: string;
    operation: 'select' | 'update';
    table: 'generations' | 'posts';
    value: unknown;
  }> = [];
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
            return makeMaybeSingleQuery(() => generation, (column, value) => {
              ownerFilters.push({ column, operation: 'select', table: 'generations', value });
            });
          },
          update(payload: Record<string, unknown>) {
            generationUpdates.push(payload);
            return makeUpdateQuery((column, value) => {
              ownerFilters.push({ column, operation: 'update', table: 'generations', value });
            });
          },
        };
      }

      if (table === 'posts') {
        return {
          select() {
            return makeMaybeSingleQuery(() => linkedPost, (column, value) => {
              ownerFilters.push({ column, operation: 'select', table: 'posts', value });
            });
          },
          update(payload: Record<string, unknown>) {
            postUpdates.push(payload);
            return makeUpdateQuery((column, value) => {
              ownerFilters.push({ column, operation: 'update', table: 'posts', value });
            });
          },
        };
      }

      if (table === 'profiles') {
        return {
          select() {
            const query = {
              eq() {
                return query;
              },
              then(resolve: (result: { data: Array<{ id: string }>; error: null }) => unknown) {
                return Promise.resolve({
                  data: (options.linkedGuestIds ?? []).map((id) => ({ id })),
                  error: null,
                }).then(resolve);
              },
            };
            return query;
          },
        };
      }

      // No row represents a legacy client upload. The consumer must retain the
      // compatibility behavior while still accepting explicitly finalized new
      // uploads when a reservation exists.
      if (table === 'upload_byte_reservations') {
        return {
          select() {
            return makeMaybeSingleQuery(() => null);
          },
        };
      }

      if (table === 'media_upload_intents') {
        return {
          update() {
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
            return { data: paths.map((name) => ({ name })), error: null };
          },
        };
      },
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };

  return {
    client: client as unknown as SupabaseClient,
    downloadMock,
    generationUpdates,
    ownerFilters,
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
          bucket: 'generated_images' as const,
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

  it('mutates the actual linked guest owner after the registered account authorizes it', async () => {
    const admin = createAdminClientMock({
      generationUserId: 'guest-1',
      linkedGuestIds: ['guest-1'],
    });
    const dependencies = {
      isCompatibleGenerationMediaType: vi.fn(() => true),
      persistGenerationMediaBlob: vi.fn(async () => ({
        outputUrl: 'generated_images/guest-1/restored-gen-1.png',
        createdLocation: {
          bucket: 'generated_images' as const,
          filePath: 'guest-1/restored-gen-1.png',
        },
      })),
    } satisfies Partial<GenerationRestoreMediaDependencies>;

    await expect(restoreGenerationMediaForRoute({
      adminSupabase: admin.client,
      body: {
        storagePath: 'uploads/user-1/replacement.png',
        originalName: 'replacement.png',
        contentType: 'image/png',
      },
      generationId: 'gen-1',
      userId: 'user-1',
      dependencies,
    })).resolves.toMatchObject({ ok: true });

    expect(dependencies.persistGenerationMediaBlob).toHaveBeenCalledWith(expect.objectContaining({
      generation: expect.objectContaining({ userId: 'guest-1' }),
    }));
    expect(admin.ownerFilters).toEqual(expect.arrayContaining([
      { column: 'user_id', operation: 'select', table: 'posts', value: 'guest-1' },
      { column: 'user_id', operation: 'update', table: 'generations', value: 'guest-1' },
      { column: 'user_id', operation: 'update', table: 'posts', value: 'guest-1' },
    ]));
  });
});
