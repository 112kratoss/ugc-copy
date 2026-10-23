// Keeps the checkout's .env files from the E2E dev server, as CI's checkout has none.
//
// A checkout's .env.local can point at a real project (the primary checkout's points at production),
// and Next applies every key in its .env files that the server's env leaves unset: at start, and again
// whenever it reloads its env during a run, which it does when an env file is saved and when a route is
// added or removed (`forceReload` in next/dist/server/lib/router-utils/setup-dev-bundler.js), a branch
// switch in that checkout included. Next reads the files with fs.statSync and fs.readFileSync
// (loadEnvConfig in @next/env); for the files named below, at the root of the checkout this file sits
// in, both answer as if the file did not exist. e2e-smoke-readiness.test.ts runs Next's loader with this
// file required, at start and on a forced reload.
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path');

// Compared by real path in the disk's own case, as Next resolves its project directory
// (realpathSync.native, next/dist/lib/realpath.js): the path this file was required by can go through
// a symlink (macOS's /var is /private/var) or differ in case on a case-insensitive disk.
const realpath = fs.realpathSync.native;
const ROOT = realpath(path.resolve(__dirname, '../../..'));
const NAMES = new Set(
  ['', '.local', '.development', '.development.local', '.test', '.test.local', '.production', '.production.local']
    .map((suffix) => `.env${suffix}`),
);

function hidden(file) {
  if (typeof file !== 'string' || !NAMES.has(path.basename(file))) return false;
  try {
    return realpath(path.dirname(path.resolve(file))) === ROOT;
  } catch {
    return false;
  }
}

function missing(syscall, file) {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${file}'`), {
    code: 'ENOENT',
    errno: -2,
    syscall,
    path: file,
  });
}

if (!globalThis.__e2eNoEnvFiles) {
  globalThis.__e2eNoEnvFiles = true;
  const { statSync, readFileSync } = fs;

  fs.statSync = function statSyncWithoutEnvFiles(file, options) {
    if (!hidden(file)) return statSync.apply(this, arguments);
    if (options && options.throwIfNoEntry === false) return undefined;
    throw missing('stat', file);
  };
  fs.readFileSync = function readFileSyncWithoutEnvFiles(file) {
    if (hidden(file)) throw missing('open', file);
    return readFileSync.apply(this, arguments);
  };
}
