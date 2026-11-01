import { afterEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { queueUnrecordedShowcaseMedia } from '@/lib/unrecorded-showcase-media';

describe('queueUnrecordedShowcaseMedia', () => {
  let restoreLogSink: (() => void) | null = null;
  afterEach(() => {
    restoreLogSink?.();
    restoreLogSink = null;
  });

  it("hands the queue each upload in a creation's public folder once", async () => {
    const rpc = vi.fn(async () => ({ data: 2, error: null }));

    await queueUnrecordedShowcaseMedia({ rpc } as never, [
      'showcase/gen-1/clip.feed.r1.mp4',
      null,
      'showcase/gen-1/clip.teaser.t1.mp4',
      'showcase/gen-1/clip.feed.r1.mp4',
      undefined,
    ]);

    expect(rpc).toHaveBeenCalledExactlyOnceWith('queue_unrecorded_showcase_media', {
      p_paths: ['showcase/gen-1/clip.feed.r1.mp4', 'showcase/gen-1/clip.teaser.t1.mp4'],
    });
  });

  it("calls nothing for uploads under a post's own prefix", async () => {
    const rpc = vi.fn();

    await queueUnrecordedShowcaseMedia({ rpc } as never, [
      'posts/post-1/photo.preview.p1.webp',
      'private-posts/post-1/photo.preview.p1.webp',
      null,
    ]);

    expect(rpc).not.toHaveBeenCalled();
  });

  it('logs a failed hand-off instead of failing the sweep', async () => {
    const logs: BackendLogRecord[] = [];
    restoreLogSink = setBackendLogSink((record) => logs.push(record));
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'permission denied for function' } }));

    await expect(queueUnrecordedShowcaseMedia({ rpc } as never, ['showcase/gen-1/clip.feed.r1.mp4']))
      .resolves.toBeUndefined();

    expect(logs).toEqual([expect.objectContaining({
      level: 'error',
      msg: 'failed_to_queue_unrecorded_showcase_media',
      paths: ['showcase/gen-1/clip.feed.r1.mp4'],
    })]);
  });
});
