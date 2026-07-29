import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { MAX_RENDITION_ATTEMPTS } from '@/lib/media-preview-repair';

const nextConfig = fs.readFileSync(path.join(process.cwd(), 'next.config.ts'), 'utf8');

describe('ffmpeg serverless configuration', () => {
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
  });

  it('still ships the binary to the routes that transcode', () => {
    for (const route of [
      '/api/cron/backend-jobs',
      '/api/cron/media-preview-repair',
      '/api/posts',
      '/api/showcase/publish',
    ]) {
      expect(nextConfig).toContain(`"${route}": ["./node_modules/ffmpeg-static/**"]`);
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
