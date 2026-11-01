import { describe, expect, it, vi } from 'vitest';

const encode = vi.hoisted(() => vi.fn());
const encodeTeaser = vi.hoisted(() => vi.fn());
const probe = vi.hoisted(() => ({ durationSeconds: 2 }));
vi.mock('@/lib/video-rendition', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/video-rendition')>(),
  withVideoInputFile: async (_body: Blob, work: (path: string, bytes: number, lease: number) => unknown) => work('/tmp/fixture.mp4', 1024, 99),
  probeVideoFile: async () => ({ width: 640, height: 360, durationSeconds: probe.durationSeconds }),
  createVideoRenditionFromFile: encode,
  createVideoTeaserFromFile: encodeTeaser,
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

describe('createPostMediaRendition uploads', () => {
  const longClip = (upload: (path: string) => Promise<{ error: unknown }>, reported: string[]) => createPostMediaRendition({
    body: new Blob(['clip'], { type: 'video/mp4' }),
    contentType: 'video/mp4',
    storagePath: 'showcase/gen-1/clip.mp4',
    supabase: { storage: { from: () => ({ upload }) } } as never,
    existingTeaserPath: null,
    onTeaserOutcome: () => undefined,
    onUploaded: (path) => { reported.push(path); },
  });

  it('tells the caller the teaser and the rendition it writes, the teaser first', async () => {
    probe.durationSeconds = 95;
    encodeTeaser.mockResolvedValueOnce({ buffer: Buffer.from('teaser bytes'), bytes: 12 });
    encode.mockResolvedValueOnce({ buffer: Buffer.from('rendition bytes'), bytes: 15, width: 360, height: 640, durationSeconds: 95 });
    const upload = vi.fn(async (path: string) => ({ error: null, path }));
    const reported: string[] = [];
    try {
      await expect(longClip(upload, reported)).resolves.toMatchObject({ status: 'ready' });
    } finally {
      probe.durationSeconds = 2;
    }

    expect(reported).toEqual([upload.mock.calls[0]?.[0], upload.mock.calls[1]?.[0]]);
    expect(reported[0]).toMatch(/^showcase\/gen-1\/clip\.teaser\.[a-f0-9]+\.mp4$/);
    expect(reported[1]).toMatch(/^showcase\/gen-1\/clip\.feed\.[a-f0-9]+\.mp4$/);
  });

  it('tells the caller of a write whose answer was an error, which may still have landed', async () => {
    encode.mockResolvedValueOnce({ buffer: Buffer.from('rendition bytes'), bytes: 15, width: 360, height: 640, durationSeconds: 2 });
    const reported: string[] = [];

    await expect(longClip(async () => ({ error: new Error('upstream connect error') }), reported)).rejects.toThrow('upstream connect error');

    expect(reported).toEqual([expect.stringMatching(/^showcase\/gen-1\/clip\.feed\.[a-f0-9]+\.mp4$/)]);
  });
});
