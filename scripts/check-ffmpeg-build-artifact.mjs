#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import ffmpegStaticPath from 'ffmpeg-static';

const FFMPEG_TRACE_PATTERN = /(?:^|\/)ffmpeg-static(?:@[^/]*)?(?:\/node_modules\/ffmpeg-static)?\/ffmpeg(?:\.exe)?$/;
const FFMPEG_MODULE_TRACE_PATTERN = /(?:^|\/)ffmpeg-static(?:@[^/]*)?(?:\/node_modules\/ffmpeg-static)?\/index\.js$/;

/**
 * Turbopack rewrites `__dirname` in a bundled module to this virtual root, so
 * any native dependency that resolves its binary that way ends up pointing at a
 * path no lambda has. Next's own precompiled dependencies inline it too, but
 * they never use it to reach the filesystem.
 */
const INLINED_ROOT_PATH_PATTERN = /\/ROOT\/[a-zA-Z0-9_@./-]*/g;
/**
 * Two allowances, and both are deliberately narrow.
 *
 * 1. Next's own precompiled dependencies, as above.
 *
 * 2. A BARE "/ROOT/" with nothing after it. That is not a path to anything —
 *    it is the static prefix of Turbopack's own runtime path *constructor*,
 *    `U.P = e => `/ROOT/${e}``, which Next emits inside its edge-wrapper
 *    template. It appears as soon as a root `instrumentation.ts` exists,
 *    whatever that file imports, so without this allowance the check forbids
 *    instrumentation outright — which is how it blocked server-side error
 *    tracking (F15b).
 *
 *    This cannot mask the bug the check exists for. That bug was
 *    "/ROOT/node_modules/ffmpeg-static" — a path *with a tail*, still flagged.
 *    Anything that reaches the filesystem names what it is reaching; a prefix
 *    with an empty tail names nothing.
 */
export const ALLOWED_INLINED_ROOT_PATH_PATTERN = /^\/ROOT\/(?:$|node_modules\/next\/dist(?:\/|$))/;

/** Routes that must be able to spawn ffmpeg at runtime. */
export const FFMPEG_REQUIRED_ROUTE_MANIFESTS = [
  'app/api/cron/backend-jobs/route.js.nft.json',
  'app/api/cron/generation-completions/route.js.nft.json',
  'app/api/cron/media-preview-repair/route.js.nft.json',
  'app/api/generate/route.js.nft.json',
  'app/api/generate-video/route.js.nft.json',
  'app/api/posts/route.js.nft.json',
  'app/api/posts/[postId]/route.js.nft.json',
  'app/api/showcase/publish/route.js.nft.json',
];

export function traceContainsFfmpeg(files) {
  return Array.isArray(files) && files.some((file) => (
    typeof file === 'string'
    && FFMPEG_TRACE_PATTERN.test(file.replaceAll('\\', '/'))
  ));
}

export function traceContainsFfmpegModule(files) {
  return Array.isArray(files) && files.some((file) => (
    typeof file === 'string'
    && FFMPEG_MODULE_TRACE_PATTERN.test(file.replaceAll('\\', '/'))
  ));
}

export function findInlinedRootPaths(source) {
  const matches = String(source ?? '').match(INLINED_ROOT_PATH_PATTERN) ?? [];
  return [...new Set(matches)].filter((match) => !ALLOWED_INLINED_ROOT_PATH_PATTERN.test(match));
}

export async function findTraceManifests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findTraceManifests(entryPath);
    return entry.name.endsWith('.nft.json') ? [entryPath] : [];
  }));
  return nested.flat();
}

export async function findServerChunkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findServerChunkFiles(entryPath);
    return entry.name.endsWith('.js') ? [entryPath] : [];
  }));
  return nested.flat();
}

export async function findFfmpegTraceManifests(nextDirectory) {
  const serverDirectory = path.join(nextDirectory, 'server');
  const manifests = await findTraceManifests(serverDirectory);
  const matches = [];

  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (traceContainsFfmpeg(manifest.files)) matches.push(manifestPath);
  }

  return matches;
}

/** Manifests that ship ffmpeg-static's loader but not the binary it spawns. */
export async function findIncompleteFfmpegTraceManifests(nextDirectory) {
  const serverDirectory = path.join(nextDirectory, 'server');
  const manifests = await findTraceManifests(serverDirectory);
  const incomplete = [];

  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (traceContainsFfmpegModule(manifest.files) && !traceContainsFfmpeg(manifest.files)) {
      incomplete.push(manifestPath);
    }
  }

  return incomplete;
}

export async function findServerChunksWithInlinedRootPaths(nextDirectory) {
  const chunks = await findServerChunkFiles(path.join(nextDirectory, 'server'));
  const offenders = [];

  for (const chunk of chunks) {
    const paths = findInlinedRootPaths(await readFile(chunk, 'utf8'));
    if (paths.length > 0) offenders.push({ chunk, paths });
  }

  return offenders;
}

export async function findMissingRequiredFfmpegRoutes(nextDirectory) {
  const serverDirectory = path.join(nextDirectory, 'server');
  const missing = [];

  for (const relativeManifest of FFMPEG_REQUIRED_ROUTE_MANIFESTS) {
    const manifestPath = path.join(serverDirectory, relativeManifest);
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!traceContainsFfmpeg(manifest.files)) missing.push(relativeManifest);
    } catch {
      missing.push(relativeManifest);
    }
  }

  return missing;
}

export async function verifyFfmpegBuildArtifact({
  nextDirectory = path.resolve('.next'),
  ffmpegPath = ffmpegStaticPath,
  runBinary = true,
} = {}) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not install a binary for this platform.');
  }

  await access(ffmpegPath, fsConstants.X_OK);

  // The gate that matters: a bundled native dependency resolves its binary from
  // a build-time virtual root, so the file ships but the path does not exist at
  // runtime. Checking the emitted lambda code catches what a build-host check
  // structurally cannot.
  const inlinedRootChunks = await findServerChunksWithInlinedRootPaths(nextDirectory);
  if (inlinedRootChunks.length > 0) {
    const detail = inlinedRootChunks
      .slice(0, 5)
      .map(({ chunk, paths }) => `  ${path.relative(nextDirectory, chunk)}: ${paths.join(', ')}`)
      .join('\n');
    throw new Error(
      'Server output inlines build-root paths that will not exist at runtime:\n'
      + `${detail}\n`
      + 'Add the offending package to `serverExternalPackages` in next.config.ts so it '
      + 'stays a runtime require and resolves its own __dirname.',
    );
  }

  const incompleteManifests = await findIncompleteFfmpegTraceManifests(nextDirectory);
  if (incompleteManifests.length > 0) {
    throw new Error(
      'These bundles load ffmpeg-static but do not ship its binary:\n'
      + `${incompleteManifests.map((manifest) => `  ${path.relative(nextDirectory, manifest)}`).join('\n')}`,
    );
  }

  const missingRoutes = await findMissingRequiredFfmpegRoutes(nextDirectory);
  if (missingRoutes.length > 0) {
    throw new Error(
      'These routes must ship the FFmpeg binary but do not:\n'
      + `${missingRoutes.map((route) => `  ${route}`).join('\n')}\n`
      + 'Check `outputFileTracingIncludes` in next.config.ts — keys are globs, so a '
      + 'literal "[id]" reads as a character class and never matches its route.',
    );
  }

  const traceManifests = await findFfmpegTraceManifests(nextDirectory);

  if (runBinary) {
    // Build-host only. This proves the downloaded binary is valid, not that the
    // deployed function can find it — the checks above cover that.
    const result = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8' });
    if (result.error || result.status !== 0 || !result.stdout.toLowerCase().includes('ffmpeg version')) {
      throw result.error ?? new Error(`Packaged FFmpeg smoke check failed with status ${result.status ?? 'unknown'}.`);
    }
  }

  return { ffmpegPath, traceManifests };
}

async function main() {
  const result = await verifyFfmpegBuildArtifact();
  console.log(
    `FFmpeg is valid on the build host, traced by ${result.traceManifests.length} server bundle(s), `
    + `resolvable at runtime in all ${FFMPEG_REQUIRED_ROUTE_MANIFESTS.length} required routes.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
