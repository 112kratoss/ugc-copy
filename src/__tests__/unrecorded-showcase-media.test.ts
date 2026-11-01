import { afterEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { queueUnrecordedShowcaseMedia } from '@/lib/unrecorded-showcase-media';

describe('queueUnrecordedShowcaseMedia', () => {
  let restoreLogSink: (() => void) | null = null;
  afterEach(() => {
    restoreLogSink?.();
    restoreLogSink = null;
    vi.useRealTimers();
  });

  function captureLogs() {
    const logs: BackendLogRecord[] = [];
    restoreLogSink = setBackendLogSink((record) => logs.push(record));
    return logs;
  }

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

  it("calls nothing for uploads under a post's own prefixes, which this queue does not take", async () => {
    const rpc = vi.fn();

    await queueUnrecordedShowcaseMedia({ rpc } as never, [
      'posts/post-1/photo.preview.p1.webp',
      'private-posts/post-1/photo.preview.p1.webp',
      null,
    ]);

    expect(rpc).not.toHaveBeenCalled();
  });

  it('tries again after a failed or thrown call, since nothing else can work the paths out again', async () => {
    vi.useFakeTimers();
    const logs = captureLogs();
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'upstream connect error' } })
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({ data: 1, error: null });

    const handOff = queueUnrecordedShowcaseMedia({ rpc } as never, ['showcase/gen-1/clip.feed.r1.mp4']);
    await vi.runAllTimersAsync();

    await expect(handOff).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(logs).toEqual([]);
  });

  it('logs a hand-off that fails every try instead of failing the sweep', async () => {
    vi.useFakeTimers();
    const logs = captureLogs();
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'permission denied for function' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'permission denied for function' } })
      .mockRejectedValueOnce(new Error('fetch failed'));

    const handOff = queueUnrecordedShowcaseMedia({ rpc } as never, ['showcase/gen-1/clip.feed.r1.mp4']);
    await vi.runAllTimersAsync();

    await expect(handOff).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(logs).toEqual([expect.objectContaining({
      level: 'error',
      msg: 'failed_to_queue_unrecorded_showcase_media',
      paths: ['showcase/gen-1/clip.feed.r1.mp4'],
      errorMessage: 'fetch failed',
    })]);
  });
});
