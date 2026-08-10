import { EventEmitter } from 'node:events';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    default: {
      ...actual,
      spawn: spawnMock,
    },
    spawn: spawnMock,
  };
});

import {
  runVideoPosterFfmpeg,
  VIDEO_POSTER_TIMEOUT_MS,
} from '@/lib/video-poster';

type MockChild = EventEmitter & { stderr: EventEmitter };

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stderr = new EventEmitter();
  return child;
}

const originalFfmpegPath = process.env.FFMPEG_PATH;

describe('video poster ffmpeg execution', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    process.env.FFMPEG_PATH = '/tmp/test-ffmpeg';
  });

  afterAll(() => {
    if (originalFfmpegPath === undefined) {
      delete process.env.FFMPEG_PATH;
    } else {
      process.env.FFMPEG_PATH = originalFfmpegPath;
    }
  });

  it('sets a hard wall-clock timeout and uses SIGKILL', async () => {
    const child = createMockChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      return child;
    });

    await expect(runVideoPosterFfmpeg('/tmp/input.mp4', '/tmp/frame.jpg', '00:00:01.000'))
      .rejects.toThrow(`ffmpeg terminated by SIGKILL after ${VIDEO_POSTER_TIMEOUT_MS}ms.`);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      '/tmp/test-ffmpeg',
      expect.arrayContaining(['-ss', '00:00:01.000', '-i', '/tmp/input.mp4', '/tmp/frame.jpg']),
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: VIDEO_POSTER_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
  });

  it('still resolves normally when ffmpeg exits successfully', async () => {
    const child = createMockChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });

    await expect(runVideoPosterFfmpeg('/tmp/input.mp4', '/tmp/frame.jpg', '00:00:00.000'))
      .resolves.toBeUndefined();
  });
});
