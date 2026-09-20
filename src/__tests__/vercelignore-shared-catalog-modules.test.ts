import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * The web bundle and the server import two modules from
 * ugc-mobile/lib/model-catalog. Vercel uploads only what .vercelignore lets
 * through, and it excluded the whole mobile workspace, so the staged
 * production build failed with "Module not found" for both files on
 * 2026-09-14 while every local build passed. Gitignore semantics cannot
 * re-include a file under an excluded directory, so the contents are excluded
 * level by level and the shared folder is re-included explicitly.
 */
it('keeps the shared catalog modules in the Vercel upload', () => {
  const lines = readFileSync('.vercelignore', 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  expect(lines).not.toContain('ugc-mobile');
  expect(lines).not.toContain('ugc-mobile/');
  const order = [
    'ugc-mobile/*',
    '!ugc-mobile/lib',
    'ugc-mobile/lib/*',
    '!ugc-mobile/lib/model-catalog',
  ].map((pattern) => lines.indexOf(pattern));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

it('keeps the platform-free resumable transport in web deployments', () => {
  const lines = readFileSync('.vercelignore', 'utf8').split('\n');
  expect(lines.indexOf('!ugc-mobile/lib/media-upload')).toBeGreaterThan(lines.indexOf('ugc-mobile/lib/*'));
  const config = JSON.parse(readFileSync('ugc-mobile/lib/media-upload/tsconfig.json', 'utf8'));
  expect(config.extends).toBeUndefined();
});
