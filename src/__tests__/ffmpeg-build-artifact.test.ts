import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FFMPEG_REQUIRED_ROUTE_MANIFESTS,
  findFfmpegTraceManifests,
  findIncompleteFfmpegTraceManifests,
  findInlinedRootPaths,
  findMissingRequiredFfmpegRoutes,
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

  describe('inlined build-root paths', () => {
    it('flags a native dependency whose __dirname was inlined', () => {
      // The exact shape that shipped: ffmpeg-static bundled, so its binary path
      // resolved to a build-time virtual root that no lambda has.
      expect(findInlinedRootPaths(
        'let r = o.join("/ROOT/node_modules/ffmpeg-static", n + ".exe");',
      )).toEqual(['/ROOT/node_modules/ffmpeg-static']);
    });

    it("ignores Next's own precompiled dependencies", () => {
      // These inline __dirname too but never use it to reach the filesystem.
      expect(findInlinedRootPaths(
        'x("/ROOT/node_modules/next/dist/compiled/cookie/index.js")',
      )).toEqual([]);
    });

    it('accepts a plain runtime require', () => {
      expect(findInlinedRootPaths('t.exports=e.x("ffmpeg-static",()=>require("ffmpeg-static"))'))
        .toEqual([]);
    });
  });

  describe('trace completeness', () => {
    it('flags a bundle that loads ffmpeg-static without shipping its binary', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'magicbooklet-ffmpeg-incomplete-'));
      const routeDirectory = path.join(root, 'server', 'app', 'api', 'posts');
      try {
        await mkdir(routeDirectory, { recursive: true });
        await writeFile(
          path.join(routeDirectory, 'route.js.nft.json'),
          JSON.stringify({ files: ['../../../../node_modules/ffmpeg-static/index.js'] }),
        );

        await expect(findIncompleteFfmpegTraceManifests(root)).resolves.toEqual([
          path.join(routeDirectory, 'route.js.nft.json'),
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('reports every required route whose manifest is missing the binary', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'magicbooklet-ffmpeg-routes-'));
      try {
        await mkdir(path.join(root, 'server'), { recursive: true });
        await expect(findMissingRequiredFfmpegRoutes(root))
          .resolves.toEqual([...FFMPEG_REQUIRED_ROUTE_MANIFESTS]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
