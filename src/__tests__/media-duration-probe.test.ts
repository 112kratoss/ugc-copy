import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getFfmpegPath } from '@/lib/video-poster';
import { probeMediaDurationSeconds, probeVideoFile } from '@/lib/video-rendition';

describe('probeMediaDurationSeconds', () => {
  let directory = '';
  let clip = '';

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'magicbooklet-duration-probe-'));
    clip = path.join(directory, 'clip.mp4');
    const encoded = spawnSync(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=2',
      '-y', clip,
    ], { encoding: 'utf8' });
    if (encoded.status !== 0) {
      throw new Error(`Could not encode the probe fixture: ${encoded.stderr}`);
    }
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('reads only HTTPS, so a value from a request can never open a local file', async () => {
    // Control: the clip is readable, so the refusals below come from the protocol list.
    await expect(probeVideoFile(clip)).resolves.toMatchObject({ durationSeconds: 2 });

    await expect(probeMediaDurationSeconds(clip)).resolves.toBeNull();
    await expect(probeMediaDurationSeconds(`file://${clip}`)).resolves.toBeNull();
  });
});
