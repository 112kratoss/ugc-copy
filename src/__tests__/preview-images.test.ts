import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('preview image optimization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('optimizes only same-origin paths and configured Supabase storage objects', async () => {
    const { canOptimizePreviewImage } = await import('@/lib/preview-images');

    expect(canOptimizePreviewImage('/images/cover.webp')).toBe(true);
    expect(canOptimizePreviewImage('//evil.example/cover.webp')).toBe(false);
    expect(canOptimizePreviewImage('/images\\cover.webp')).toBe(false);
    expect(canOptimizePreviewImage(
      'https://project.supabase.co/storage/v1/object/public/showcase_media/cover.webp'
    )).toBe(true);
    expect(canOptimizePreviewImage(
      'http://project.supabase.co/storage/v1/object/public/showcase_media/cover.webp'
    )).toBe(false);
    expect(canOptimizePreviewImage(
      'https://user:password@project.supabase.co/storage/v1/object/public/showcase_media/cover.webp'
    )).toBe(false);
    expect(canOptimizePreviewImage(
      'https://project.supabase.co:444/storage/v1/object/public/showcase_media/cover.webp'
    )).toBe(false);
    expect(canOptimizePreviewImage(
      'https://other.example/storage/v1/object/public/showcase_media/cover.webp'
    )).toBe(false);
  });

  it('builds a bounded same-origin optimizer URL and leaves unsupported hosts unchanged', async () => {
    const { buildOptimizedPreviewImageUrl } = await import('@/lib/preview-images');
    const source = 'https://project.supabase.co/storage/v1/object/public/showcase_media/cover.webp';
    const optimized = new URL(buildOptimizedPreviewImageUrl(source), 'https://magicbooklet.com');

    expect(optimized.origin).toBe('https://magicbooklet.com');
    expect(optimized.pathname).toBe('/_next/image');
    expect(optimized.searchParams.get('url')).toBe(source);
    expect(optimized.searchParams.get('w')).toBe('750');
    expect(optimized.searchParams.get('q')).toBe('75');
    expect(buildOptimizedPreviewImageUrl('https://images.example/cover.webp')).toBe(
      'https://images.example/cover.webp'
    );
  });
});
