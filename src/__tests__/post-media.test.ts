import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { loadPostMediaItemsMap } from '@/lib/post-media';
import { resolvePostMediaUrl } from '@/lib/posts-server';

describe('post media summaries', () => {
  it('signs only storage owned by the persisted post owner', async () => {
    const createSignedUrl = vi.fn(async (filePath: string) => ({
      data: { signedUrl: `https://signed.example.test/${filePath}` },
      error: null,
    }));
    const supabase = {
      storage: {
        from: vi.fn(() => ({ createSignedUrl })),
      },
    };

    await expect(resolvePostMediaUrl(supabase as never, {
      showcase_asset_path: null,
      output_url: 'generated_images/owner-1/canonical.png',
      user_id: 'owner-1',
    })).resolves.toBe('https://signed.example.test/owner-1/canonical.png');

    for (const outputUrl of [
      'generated_images/foreign-owner/private.png',
      'generated_images/owner-1%252fforeign-owner/private.png',
    ]) {
      createSignedUrl.mockClear();
      await expect(resolvePostMediaUrl(supabase as never, {
        showcase_asset_path: null,
        output_url: outputUrl,
        user_id: 'owner-1',
      })).resolves.toBeNull();
      expect(createSignedUrl).not.toHaveBeenCalled();
    }
  });

  it('keeps HTTPS provider media but rejects ownerless storage references', async () => {
    const supabase = { storage: { from: vi.fn() } };

    await expect(resolvePostMediaUrl(supabase as never, {
      showcase_asset_path: null,
      output_url: 'https://provider.example.test/output.png',
      user_id: null,
    })).resolves.toBe('https://provider.example.test/output.png');
    await expect(resolvePostMediaUrl(supabase as never, {
      showcase_asset_path: null,
      output_url: 'generated_images/owner-1/output.png',
      user_id: null,
    })).resolves.toBeNull();
    expect(supabase.storage.from).not.toHaveBeenCalled();
  });

  it('uses the related persisted post owner for gallery external storage', async () => {
    let selectedColumns = '';
    const rows = [{
      id: 'media-foreign',
      post_id: 'post-1',
      storage_path: null,
      external_url: 'generated_images/foreign-owner/private.png',
      media_kind: 'image',
      content_type: 'image/png',
      original_name: 'private.png',
      width: null,
      height: null,
      duration_seconds: null,
      sort_order: 0,
      posts: { user_id: 'owner-1' },
    }];
    const query = {
      select(columns: string) { selectedColumns = columns; return query; },
      in() { return query; },
      order() { return Promise.resolve({ data: rows, error: null }); },
    };
    const createSignedUrl = vi.fn();
    const supabase = {
      from: () => query,
      storage: { from: vi.fn(() => ({ createSignedUrl })) },
    };

    const result = await loadPostMediaItemsMap(supabase as never, ['post-1']);

    expect(result.get('post-1')).toEqual([]);
    expect(selectedColumns).toContain('posts!inner(user_id)');
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

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

  it('serves the display rendition an image row records', async () => {
    let selectedColumns = '';
    const rows = [{
      id: 'media-1',
      post_id: 'post-1',
      storage_path: 'posts/post-1/original.jpg',
      preview_storage_path: 'posts/post-1/original.preview.webp',
      display_storage_path: 'posts/post-1/original.display.webp',
      external_url: null,
      media_kind: 'image',
      content_type: 'image/jpeg',
      original_name: 'original.jpg',
      width: 1536,
      height: 2752,
      duration_seconds: null,
      sort_order: 0,
    }];
    const query = {
      select(columns: string) { selectedColumns = columns; return query; },
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

    // Without the column in the select, every image opened in the viewer
    // downloaded its original (up to 2.8 MB) instead of the 1440px WebP.
    expect(selectedColumns).toContain('display_storage_path');
    expect(result.get('post-1')?.[0]).toMatchObject({
      url: 'https://cdn.example.com/posts/post-1/original.jpg',
      displayUrl: 'https://cdn.example.com/posts/post-1/original.display.webp',
    });
  });

  it('keeps serving media from a database that predates display renditions', async () => {
    const selections: string[] = [];
    const rows = [{
      id: 'media-1',
      post_id: 'post-1',
      storage_path: 'posts/post-1/original.jpg',
      external_url: null,
      media_kind: 'image',
      content_type: 'image/jpeg',
      original_name: 'original.jpg',
      width: null,
      height: null,
      duration_seconds: null,
      sort_order: 0,
    }];
    const query = {
      select(columns: string) { selections.push(columns); return query; },
      in() { return query; },
      order() {
        return Promise.resolve(selections.length === 1
          ? { data: null, error: { code: '42703', message: 'column post_media.display_storage_path does not exist' } }
          : { data: rows, error: null });
      },
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

    expect(selections).toHaveLength(2);
    expect(selections[1]).not.toContain('display_storage_path');
    expect(selections[1]).toContain('source_unavailable_at');
    expect(result.get('post-1')?.[0]).toMatchObject({
      url: 'https://cdn.example.com/posts/post-1/original.jpg',
      displayUrl: null,
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
