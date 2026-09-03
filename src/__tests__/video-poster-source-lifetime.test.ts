import { EventEmitter } from 'node:events';
import { Blob as NodeBlob } from 'node:buffer';
import { existsSync, writeFileSync } from 'node:fs';

import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, default: { ...actual, spawn: spawnMock }, spawn: spawnMock };
});

import { createVideoPosterBuffer } from '@/lib/video-poster';

const originalFfmpegPath = process.env.FFMPEG_PATH;

/**
 * Whether the source was still on disk at the moment ffmpeg opened it.
 *
 * `createVideoPosterBuffer` writes the download to a temp directory and removes
 * that directory in a `finally`. A `finally` runs when its `try` block
 * *completes*, and `return someAsyncCall()` completes the block right away — so
 * the cleanup used to delete the input while ffmpeg was still starting on it.
 * ffmpeg answered `AVERROR(ENOENT)`, which surfaces as exit code 254, and three
 * of those retired the row permanently.
 */
let inputExistedWhenFfmpegRan: boolean | null = null;

describe('video poster source lifetime', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    inputExistedWhenFfmpegRan = null;
    process.env.FFMPEG_PATH = '/tmp/test-ffmpeg';
  });

  afterAll(() => {
    if (originalFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = originalFfmpegPath;
  });

  it('keeps the downloaded source on disk until ffmpeg has opened it', async () => {
    const frame = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).jpeg().toBuffer();

    spawnMock.mockImplementation((_binary: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      const inputPath = args[args.indexOf('-i') + 1];
      const framePath = args[args.length - 1];

      // A real spawn does not open the input synchronously. Give the event loop
      // the same chance to interleave that it gives the process launch.
      setTimeout(() => {
        inputExistedWhenFfmpegRan ??= existsSync(inputPath);
        if (!existsSync(inputPath)) {
          // Exactly what ffmpeg does: AVERROR(ENOENT) leaves exit code 254.
          child.emit('close', 254, null);
          return;
        }
        writeFileSync(framePath, frame);
        child.emit('close', 0, null);
      }, 15);

      return child;
    });

    const poster = await createVideoPosterBuffer(
      new NodeBlob([new Uint8Array([1, 2, 3, 4])]) as unknown as Blob,
    );

    expect(inputExistedWhenFfmpegRan).toBe(true);
    expect(poster.length).toBeGreaterThan(0);
  });
});
