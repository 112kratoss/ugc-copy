import { describe, expect, it, vi } from 'vitest';

import {
  isUploadCancelledError,
  runWeightedUploadQueue,
  UploadCancelledError,
} from '@/lib/upload-queue';

/**
 * Mirrors ugc-mobile/__tests__/upload-file.test.ts. The two workspaces cannot
 * share a package, so the same vectors run on both copies to keep them honest.
 */
describe('runWeightedUploadQueue', () => {
  it('runs two images concurrently but gives each video the full upload budget', async () => {
    const releases = new Map<string, () => void>();
    const starts: string[] = [];
    const queue = runWeightedUploadQueue([
      { item: 'image-1', kind: 'image' },
      { item: 'image-2', kind: 'image' },
      { item: 'video-1', kind: 'video' },
      { item: 'image-3', kind: 'image' },
    ], async (item) => {
      starts.push(item);
      await new Promise<void>((resolve) => releases.set(item, resolve));
      return `${item}:uploaded`;
    });

    await vi.waitFor(() => expect(starts).toEqual(['image-1', 'image-2']));
    releases.get('image-1')?.();
    await Promise.resolve();
    expect(starts).toEqual(['image-1', 'image-2']);

    releases.get('image-2')?.();
    await vi.waitFor(() => expect(starts).toEqual(['image-1', 'image-2', 'video-1']));
    releases.get('video-1')?.();
    await vi.waitFor(() => expect(starts).toEqual(['image-1', 'image-2', 'video-1', 'image-3']));
    releases.get('image-3')?.();

    await expect(queue).resolves.toMatchObject({
      failures: [],
      successes: [
        { index: 0, result: 'image-1:uploaded' },
        { index: 1, result: 'image-2:uploaded' },
        { index: 2, result: 'video-1:uploaded' },
        { index: 3, result: 'image-3:uploaded' },
      ],
    });
  });

  it('keeps the successes when one item fails', async () => {
    // This is the whole reason the composer stopped using Promise.all: a single
    // rejection used to discard files that had already uploaded, stranding their
    // staged objects with nothing to collect them.
    const result = await runWeightedUploadQueue([
      { item: 'ok-1', kind: 'image' },
      { item: 'boom', kind: 'image' },
      { item: 'ok-2', kind: 'image' },
    ], async (item) => {
      if (item === 'boom') throw new Error('upload failed');
      return `${item}:uploaded`;
    });

    expect(result.successes.map((entry) => entry.item)).toEqual(['ok-1', 'ok-2']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].item).toBe('boom');
  });

  it('preserves the original order regardless of completion order', async () => {
    // The first item is the Showcase cover, so a reorder would change what the
    // published post looks like.
    const result = await runWeightedUploadQueue([
      { item: 'slow', kind: 'image' },
      { item: 'fast', kind: 'image' },
    ], async (item) => {
      if (item === 'slow') await new Promise((resolve) => setTimeout(resolve, 10));
      return item;
    });

    expect(result.successes.map((entry) => entry.index)).toEqual([0, 1]);
    expect(result.successes.map((entry) => entry.result)).toEqual(['slow', 'fast']);
  });

  it('marks not-yet-started items cancelled when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runWeightedUploadQueue([
      { item: 'a', kind: 'image' },
      { item: 'b', kind: 'image' },
    ], async (item) => item, { signal: controller.signal });

    expect(result.successes).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.every((failure) => isUploadCancelledError(failure.error))).toBe(true);
  });

  it('resolves immediately for an empty batch', async () => {
    await expect(runWeightedUploadQueue([], async (item) => item)).resolves.toEqual({
      successes: [],
      failures: [],
    });
  });

  it('recognises its own cancellation error across realms', () => {
    expect(isUploadCancelledError(new UploadCancelledError())).toBe(true);
    const lookalike = new Error('Upload cancelled.');
    lookalike.name = 'UploadCancelledError';
    expect(isUploadCancelledError(lookalike)).toBe(true);
    expect(isUploadCancelledError(new Error('network'))).toBe(false);
  });
});
