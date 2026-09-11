import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';

import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, default: { ...actual, spawn: spawnMock }, spawn: spawnMock };
});

import { createVideoPosterBufferFromFile } from '@/lib/video-poster';

const originalFfmpegPath = process.env.FFMPEG_PATH;

/**
 * The reel draws a video's poster under the surface until the player has
 * rendered, and playback starts at zero. A poster from later in the clip
 * therefore reads as the video jumping backwards on every landing, so the
 * poster is the first frame, and one second is only a fallback for a source
 * whose first frame ffmpeg cannot decode.
 */
describe('video poster frame choice', () => {
  const seeks: string[] = [];
  let failFirst = false;

  beforeEach(async () => {
    spawnMock.mockReset();
    seeks.length = 0;
    failFirst = false;
    process.env.FFMPEG_PATH = '/tmp/test-ffmpeg';
    const frame = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).jpeg().toBuffer();
    spawnMock.mockImplementation((_binary: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      seeks.push(args[args.indexOf('-ss') + 1]);
      const framePath = args[args.length - 1];
      queueMicrotask(() => {
        if (failFirst && seeks.length === 1) {
          child.emit('close', 1, null);
          return;
        }
        writeFileSync(framePath, frame);
        child.emit('close', 0, null);
      });
      return child;
    });
  });

  afterAll(() => {
    if (originalFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = originalFfmpegPath;
  });

  it('takes the first frame, and nothing else when it decodes', async () => {
    const poster = await createVideoPosterBufferFromFile('/tmp/input.mp4');
    expect(seeks).toEqual(['00:00:00.000']);
    expect(poster.length).toBeGreaterThan(0);
  });

  it('falls back to one second only when the first frame fails', async () => {
    failFirst = true;
    const poster = await createVideoPosterBufferFromFile('/tmp/input.mp4');
    expect(seeks).toEqual(['00:00:00.000', '00:00:01.000']);
    expect(poster.length).toBeGreaterThan(0);
  });
});
