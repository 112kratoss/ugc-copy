import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findFfmpegTraceManifests,
  traceContainsFfmpeg,
} from '../../scripts/check-ffmpeg-build-artifact.mjs';

describe('FFmpeg build artifact verification', () => {
  it('recognizes npm, pnpm, and Windows FFmpeg trace paths', () => {
    expect(traceContainsFfmpeg(['../../node_modules/ffmpeg-static/ffmpeg'])).toBe(true);
    expect(traceContainsFfmpeg([
      '../../../../node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg',
    ])).toBe(true);
    expect(traceContainsFfmpeg(['..\\node_modules\\ffmpeg-static\\ffmpeg.exe'])).toBe(true);
    expect(traceContainsFfmpeg(['../../node_modules/ffmpeg-static/index.js'])).toBe(false);
  });

  it('finds only manifests that trace the binary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'magicbooklet-ffmpeg-traces-'));
    const routeDirectory = path.join(root, 'server', 'app', 'api', 'cron', 'media-preview-repair');
    try {
      await mkdir(routeDirectory, { recursive: true });
      await writeFile(
        path.join(routeDirectory, 'route.js.nft.json'),
        JSON.stringify({ files: ['../../../../../../../node_modules/ffmpeg-static/ffmpeg'] }),
      );
      await writeFile(
        path.join(root, 'server', 'unrelated.js.nft.json'),
        JSON.stringify({ files: ['../../node_modules/next/package.json'] }),
      );

      await expect(findFfmpegTraceManifests(root)).resolves.toEqual([
        path.join(routeDirectory, 'route.js.nft.json'),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
