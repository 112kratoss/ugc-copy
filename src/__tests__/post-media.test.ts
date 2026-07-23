import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { loadPostMediaItemsMap } from '@/lib/post-media';

describe('post media summaries', () => {
  it('exposes optional preview URLs alongside original media', async () => {
    const rows = [{
      id: 'media-1',
      post_id: 'post-1',
      media_key: 'proof-cover',
      storage_path: 'posts/post-1/original.jpg',
      preview_storage_path: 'posts/post-1/original.preview.webp',
      external_url: null,
      media_kind: 'image',
      content_type: 'image/jpeg',
      original_name: 'original.jpg',
      width: 1200,
      height: 800,
      duration_seconds: null,
      sort_order: 0,
    }];
    const query = {
      select() {
        return query;
      },
      in() {
        return query;
      },
      order() {
        return Promise.resolve({ data: rows, error: null });
      },
    };
    const supabase = {
      from: () => query,
      storage: {
        from: () => ({
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.example.com/${path}` },
          }),
        }),
      },
    };

    const result = await loadPostMediaItemsMap(supabase as never, ['post-1']);

    expect(result.get('post-1')?.[0]).toMatchObject({
      mediaKey: 'proof-cover',
      url: 'https://cdn.example.com/posts/post-1/original.jpg',
      previewUrl: 'https://cdn.example.com/posts/post-1/original.preview.webp',
      width: 1200,
      height: 800,
    });
  });

  it('supplies a deterministic key for legacy rows', async () => {
    const rows = [{
      id: 'legacy-media',
      post_id: 'post-1',
      storage_path: 'posts/post-1/second.jpg',
      external_url: null,
      media_kind: 'image',
      content_type: 'image/jpeg',
      original_name: 'second.jpg',
      width: null,
      height: null,
      duration_seconds: null,
      sort_order: 1,
    }];
    const query = {
      select() { return query; },
      in() { return query; },
      order() { return Promise.resolve({ data: rows, error: null }); },
    };
    const supabase = {
      from: () => query,
      storage: {
        from: () => ({
          getPublicUrl: (storagePath: string) => ({ data: { publicUrl: `https://cdn.example.com/${storagePath}` } }),
        }),
      },
    };

    const result = await loadPostMediaItemsMap(supabase as never, ['post-1']);
    expect(result.get('post-1')?.[0]?.mediaKey).toBe('media-2');
  });
});
