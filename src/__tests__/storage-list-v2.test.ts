import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  iterateStorageObjectsV2,
  StorageListV2Error,
} from '@/lib/storage-list-v2';

function clientWithPages(pages: Array<Record<string, unknown>>) {
  const listV2 = vi.fn(async () => pages.shift());
  return {
    client: {
      storage: { from: vi.fn(() => ({ listV2 })) },
    } as unknown as SupabaseClient,
    listV2,
  };
}

describe('iterateStorageObjectsV2', () => {
  it('uses opaque cursors and returns flat object paths', async () => {
    const { client, listV2 } = clientWithPages([
      {
        data: {
          hasNext: true,
          nextCursor: 'cursor-2',
          folders: [],
          objects: [{
            id: 'object-1',
            key: 'user-1/nested/one.png',
            name: 'one.png',
            created_at: '2026-08-22T00:00:00.000Z',
            updated_at: '2026-08-22T00:00:00.000Z',
            metadata: { size: 10 },
          }],
        },
        error: null,
      },
      {
        data: {
          hasNext: false,
          folders: [],
          objects: [{
            id: 'object-2',
            name: 'user-1/two.png',
            created_at: '2026-08-22T00:00:01.000Z',
            updated_at: '2026-08-22T00:00:01.000Z',
            metadata: null,
          }],
        },
        error: null,
      },
    ]);

    const paths: string[] = [];
    for await (const object of iterateStorageObjectsV2(client, {
      bucket: 'uploads',
      prefix: '/user-1/',
      pageSize: 100,
    })) {
      paths.push(object.path);
    }

    expect(paths).toEqual(['user-1/nested/one.png', 'user-1/two.png']);
    expect(listV2).toHaveBeenNthCalledWith(1, {
      prefix: 'user-1/',
      limit: 100,
      with_delimiter: false,
      sortBy: { column: 'name', order: 'asc' },
    });
    expect(listV2).toHaveBeenNthCalledWith(2, {
      prefix: 'user-1/',
      limit: 100,
      cursor: 'cursor-2',
      with_delimiter: false,
      sortBy: { column: 'name', order: 'asc' },
    });
  });

  it('fails closed on a missing continuation cursor', async () => {
    const { client } = clientWithPages([{
      data: { hasNext: true, folders: [], objects: [] },
      error: null,
    }]);

    const consume = async () => {
      for await (const object of iterateStorageObjectsV2(client, { bucket: 'uploads' })) {
        void object;
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(StorageListV2Error);
  });

  it('rejects an object outside the requested prefix', async () => {
    const { client } = clientWithPages([{
      data: {
        hasNext: false,
        folders: [],
        objects: [{
          id: 'object-1',
          key: 'another-user/private.png',
          name: 'private.png',
          created_at: '2026-08-22T00:00:00.000Z',
          updated_at: '2026-08-22T00:00:00.000Z',
          metadata: null,
        }],
      },
      error: null,
    }]);

    const consume = async () => {
      for await (const object of iterateStorageObjectsV2(client, {
        bucket: 'uploads',
        prefix: 'user-1',
      })) {
        void object;
      }
    };
    await expect(consume()).rejects.toThrow('outside uploads/user-1/');
  });
});
