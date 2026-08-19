import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { MAX_RENDITION_ATTEMPTS } from '@/lib/media-preview-repair';

const nextConfig = fs.readFileSync(path.join(process.cwd(), 'next.config.ts'), 'utf8');

describe('ffmpeg serverless configuration', () => {
  it('keeps the trace constants pointing at the packages they name', () => {
    // The route entries spread these, so an edit here would silently empty every
    // route's include list while the assertions below still read correctly.
    expect(nextConfig).toContain('const FFMPEG_TRACE = ["./node_modules/ffmpeg-static/**"];');
    expect(nextConfig).toContain('const SHARP_TRACE = ["./node_modules/@img/sharp-libvips-*/**"];');
  });

  it('keeps ffmpeg-static external so its __dirname survives bundling', () => {
    // Bundled, Turbopack inlines __dirname as "/ROOT/node_modules/ffmpeg-static",
    // a path no lambda has, and every spawn fails with ENOENT. build:verify
    // scans the emitted chunks for that signature; this pins the fix itself.
    expect(nextConfig).toMatch(/serverExternalPackages:\s*\[[^\]]*["']ffmpeg-static["']/);
  });

  it('does not externalize sharp, which Next already handles by default', () => {
    // Documented so nobody "fixes" a non-problem by copying the line above.
    expect(nextConfig).not.toMatch(/serverExternalPackages:\s*\[[^\]]*["']sharp["']/);
  });

  it('uses glob-safe tracing keys for dynamic routes', () => {
    // Keys are matched as globs, so a literal "[postId]" reads as a character
    // class and silently never matches the route it names.
    const tracingBlock = nextConfig.slice(
      nextConfig.indexOf('outputFileTracingIncludes'),
      nextConfig.indexOf('outputFileTracingExcludes'),
    );
    const routeKeys = [...tracingBlock.matchAll(/^\s*"(\/[^"]*)":/gm)].map(([, key]) => key);
    expect(routeKeys.length).toBeGreaterThan(0);
    expect(routeKeys.filter((key) => key.includes('['))).toEqual([]);
    expect(routeKeys).toContain('/api/posts/*');

    // SHARP_ROUTES is declared above the config and spread in, so it falls
    // outside the slice above -- it needs the same glob-safety check, since a
    // literal "[id]" there would fail exactly as silently.
    const sharpRoutesBlock = nextConfig.slice(
      nextConfig.indexOf('const SHARP_ROUTES = ['),
      nextConfig.indexOf('const nextConfig'),
    );
    const sharpKeys = [...sharpRoutesBlock.matchAll(/"(\/[^"]*)"/g)].map(([, key]) => key);
    expect(sharpKeys.length).toBeGreaterThan(0);
    expect(sharpKeys.filter((key) => key.includes('['))).toEqual([]);
    expect(sharpKeys).toContain('/api/webhooks/kie');
  });

  it('still ships the binary to the routes that transcode', () => {
    for (const route of [
      '/api/cron/backend-jobs',
      '/api/cron/media-preview-repair',
      '/api/posts',
      '/api/showcase/publish',
    ]) {
      expect(nextConfig).toContain(`"${route}": [...FFMPEG_TRACE, ...SHARP_TRACE]`);
    }
  });
});

describe('media pipeline health constants', () => {
  it('mirrors the repair sweep attempt ceiling', () => {
    // backend-health.ts duplicates this rather than importing the module (which
    // would pull ffmpeg and sharp into an ops route). If the sweep's ceiling
    // moves, the health check would silently stop flagging exhausted rows.
    const backendHealth = fs.readFileSync(path.join(process.cwd(), 'src/lib/backend-health.ts'), 'utf8');
    expect(backendHealth).toContain(`const MEDIA_RENDITION_MAX_ATTEMPTS = ${MAX_RENDITION_ATTEMPTS};`);
    expect(backendHealth).toContain(`const MEDIA_PREVIEW_MAX_ATTEMPTS = ${MAX_RENDITION_ATTEMPTS};`);
  });
});
