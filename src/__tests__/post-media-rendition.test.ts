import { describe, expect, it, vi } from 'vitest';

const encode = vi.hoisted(() => vi.fn());
vi.mock('@/lib/video-rendition', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/video-rendition')>(),
  withVideoInputFile: async (_body: Blob, work: (path: string, bytes: number, lease: number) => unknown) => work('/tmp/fixture.mp4', 1024, 99),
  probeVideoFile: async () => ({ width: 640, height: 360, durationSeconds: 2 }),
  createVideoRenditionFromFile: encode,
}));

import { createPostMediaRendition } from '@/lib/post-media-rendition';
import { VideoRenditionSkipped } from '@/lib/video-rendition';

const renditionOf = () => createPostMediaRendition({
  body: new Blob(['clip'], { type: 'video/mp4' }),
  contentType: 'video/mp4',
  storagePath: 'posts/post-1/0/clip.mp4',
  supabase: {} as never,
});

describe('createPostMediaRendition skips', () => {
  it('hands a not-smaller skip on with the size the encoder wrote', async () => {
    // The source plays in the rendition's place, and the rendition sweep
    // records this size so the card is laid out upright.
    encode.mockRejectedValueOnce(new VideoRenditionSkipped(
      'not-smaller',
      'Rendition exceeded its useful output size.',
      { width: 360, height: 640 },
    ));

    await expect(renditionOf()).resolves.toEqual({ status: 'skipped', reason: 'not-smaller', width: 360, height: 640 });
  });

  it('hands on no size when nothing was encoded', async () => {
    encode.mockRejectedValueOnce(new VideoRenditionSkipped('too-large', 'Source bytes are outside the rendition budget.'));

    await expect(renditionOf()).resolves.toEqual({ status: 'skipped', reason: 'too-large', width: null, height: null });
  });
});
