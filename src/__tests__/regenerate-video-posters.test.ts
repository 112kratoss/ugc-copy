import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createPostMediaPreview: vi.fn(),
  createGenerationOutputPreview: vi.fn(),
  invalidateShowcaseFeedCache: vi.fn(),
}));

vi.mock('@/lib/post-media-preview', () => ({
  createPostMediaPreview: mocks.createPostMediaPreview,
}));
vi.mock('@/lib/generation-output-preview', () => ({
  createGenerationOutputPreview: mocks.createGenerationOutputPreview,
}));
vi.mock('@/lib/showcase-feed-cache', () => ({
  invalidateShowcaseFeedCache: mocks.invalidateShowcaseFeedCache,
}));
vi.mock('@/lib/post-media-rendition', () => ({
  createPostMediaRendition: vi.fn(),
}));

import { regenerateVideoPosters } from '@/lib/media-preview-repair';

type Fixtures = { generations: Record<string, unknown>[]; post_media: Record<string, unknown>[] };

function createClient(fixtures: Fixtures, options: { failDownload?: string } = {}) {
  const updates: Array<{ table: string; payload: Record<string, unknown>; id: unknown }> = [];
  const downloads: string[] = [];
  const selectChain = (rows: unknown[]) => {
    const chain = {
      eq: () => chain,
      not: () => chain,
      order: () => chain,
      limit: async () => ({ data: rows, error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    };
    return chain;
  };
  const client = {
    from: (table: keyof Fixtures | 'posts') => ({
      select: () => selectChain(table === 'posts' ? [] : fixtures[table]),
      update: (payload: Record<string, unknown>) => ({
        eq: async (_column: string, id: unknown) => {
          updates.push({ table, payload, id });
          return { error: null };
        },
      }),
    }),
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          const key = `${bucket}/${path}`;
          downloads.push(key);
          if (options.failDownload === key) return { data: null, error: new Error('Object not found') };
          return { data: new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }), error: null };
        },
      }),
    },
  };
  return { client: client as never, updates, downloads };
}

const videoGeneration = {
  id: 'gen-video',
  user_id: 'user-1',
  output_url: 'generated_videos/user-1/clip.mp4',
  category: 'video',
  preview_url: 'generated_videos/user-1/clip.preview.oldhash.webp',
  preview_attempt_count: 1,
};
const imageGeneration = {
  id: 'gen-image',
  user_id: 'user-1',
  output_url: 'generated_images/user-1/still.png',
  category: 'image',
  preview_url: 'generated_images/user-1/still.preview.oldhash.webp',
  preview_attempt_count: 1,
};
const postVideo = {
  id: 'media-video',
  post_id: 'post-1',
  storage_path: 'posts/post-1/clip.mp4',
  media_kind: 'video',
  content_type: 'video/mp4',
  preview_storage_path: 'posts/post-1/clip.preview.oldhash.webp',
  preview_attempt_count: 1,
};

describe('regenerateVideoPosters', () => {
  beforeEach(() => {
    mocks.createPostMediaPreview.mockReset();
    mocks.createGenerationOutputPreview.mockReset();
    mocks.invalidateShowcaseFeedCache.mockReset();
    mocks.createGenerationOutputPreview.mockResolvedValue({
      previewStoragePath: 'generated_videos/user-1/clip.preview.newhash.webp',
      previewThumbhash: 'gen-thumbhash',
      previewWidth: 720,
      previewHeight: 1280,
      displayStoragePath: null,
    });
    mocks.createPostMediaPreview.mockResolvedValue({
      previewStoragePath: 'posts/post-1/clip.preview.newhash.webp',
      previewThumbhash: 'post-thumbhash',
      previewStatus: 'ready',
      width: null,
      height: null,
      displayStoragePath: null,
    });
  });

  it('lists the video rows and writes nothing on a dry run', async () => {
    const { client, updates, downloads } = createClient({
      generations: [videoGeneration, imageGeneration],
      post_media: [postVideo],
    });
    const lines: string[] = [];

    const summary = await regenerateVideoPosters(client, { dryRun: true, log: (line) => lines.push(line) });

    expect(summary).toEqual({
      generations: { candidates: 1, regenerated: 0, unchanged: 0, failed: 0 },
      posts: { candidates: 1, regenerated: 0, unchanged: 0, failed: 0 },
    });
    expect(downloads).toEqual([]);
    expect(updates).toEqual([]);
    expect(lines.join('\n')).toContain('gen-video');
    expect(lines.join('\n')).not.toContain('gen-image');
  });

  it('moves each row to its new poster without touching status, attempts or the clip dimensions', async () => {
    const { client, updates, downloads } = createClient({
      generations: [videoGeneration, imageGeneration],
      post_media: [postVideo],
    });

    const summary = await regenerateVideoPosters(client);

    expect(summary.generations).toEqual({ candidates: 1, regenerated: 1, unchanged: 0, failed: 0 });
    expect(summary.posts).toEqual({ candidates: 1, regenerated: 1, unchanged: 0, failed: 0 });
    expect(downloads).toEqual(['generated_videos/user-1/clip.mp4', 'showcase_media/posts/post-1/clip.mp4']);

    const generationUpdate = updates.find((update) => update.table === 'generations');
    expect(generationUpdate?.id).toBe('gen-video');
    expect(generationUpdate?.payload).toMatchObject({
      preview_url: 'generated_videos/user-1/clip.preview.newhash.webp',
      preview_thumbhash: 'gen-thumbhash',
      preview_width: 720,
      preview_height: 1280,
    });
    expect(Object.keys(generationUpdate?.payload ?? {})).not.toEqual(
      expect.arrayContaining(['preview_status', 'preview_attempt_count', 'preview_locked_by']),
    );

    const postUpdate = updates.find((update) => update.table === 'post_media');
    expect(postUpdate?.id).toBe('media-video');
    expect(postUpdate?.payload).toMatchObject({
      preview_storage_path: 'posts/post-1/clip.preview.newhash.webp',
      preview_thumbhash: 'post-thumbhash',
    });
    expect(Object.keys(postUpdate?.payload ?? {})).not.toEqual(
      expect.arrayContaining(['width', 'height', 'preview_status', 'preview_attempt_count']),
    );
    expect(mocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
  });

  it('leaves a row alone when the first frame hashes to the poster it already has', async () => {
    mocks.createPostMediaPreview.mockResolvedValue({
      previewStoragePath: postVideo.preview_storage_path,
      previewThumbhash: 'post-thumbhash',
      previewStatus: 'ready',
      width: null,
      height: null,
      displayStoragePath: null,
    });
    const { client, updates } = createClient({ generations: [], post_media: [postVideo] });

    const summary = await regenerateVideoPosters(client);

    expect(summary.posts).toEqual({ candidates: 1, regenerated: 0, unchanged: 1, failed: 0 });
    expect(updates).toEqual([]);
    expect(mocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('counts a failed row and carries on with the rest', async () => {
    const { client, updates } = createClient(
      { generations: [videoGeneration], post_media: [postVideo] },
      { failDownload: 'generated_videos/user-1/clip.mp4' },
    );
    const lines: string[] = [];

    const summary = await regenerateVideoPosters(client, { log: (line) => lines.push(line) });

    expect(summary.generations).toEqual({ candidates: 1, regenerated: 0, unchanged: 0, failed: 1 });
    expect(summary.posts).toEqual({ candidates: 1, regenerated: 1, unchanged: 0, failed: 0 });
    expect(updates.map((update) => update.table)).toEqual(['post_media']);
    expect(lines.join('\n')).toContain('gen-video: failed');
  });
});
