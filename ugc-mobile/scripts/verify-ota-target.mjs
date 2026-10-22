#!/usr/bin/env node

// Last gate before `eas update`: prove the update can actually reach a device.
//
// `runtimeVersion` uses the fingerprint policy, so an update is only served to
// a binary whose fingerprint matches it exactly. Publish to any other value and
// EAS reports "Published!", prints a runtime version, and reaches nobody — no
// error, no warning, nothing in the dashboard that reads as broken. Two updates
// were published that way on 2026-08-31 before anyone noticed.
//
// The fingerprint is computed from the native surface: app config, plugins,
// native dependencies, patches — and `.gitignore`, which is how a one-line
// tidy-up silently invalidated a target that day. It is NOT computed from app
// JS, which is exactly why JS-only fixes can ship over the air at all.
//
// Usage:
//   node ./scripts/verify-ota-target.mjs                    # every platform in ota-targets.json
//   node ./scripts/verify-ota-target.mjs --platform android
//   node ./scripts/verify-ota-target.mjs --json
//   node ./scripts/verify-ota-target.mjs --set-aside
//
// --set-aside fingerprints each platform without the files its target lists
// under "setAside", as scripts/publish-ota.mjs does in its throwaway tree, and
// puts them back afterwards (CI's advisory step uses it). Without it a target
// with such files never matches a plain tree, which is expected and says
// nothing about reach.
//
// Deliberately NOT wired to an npm script. package.json feeds the fingerprint
// in more ways than it looks: its `scripts` directly, so adding
// `"ota:preflight": "..."` to it moves the runtime version — verified on
// 2026-08-31: the identical tree fingerprinted 9e59d85d… without the script
// line and d832ccd9… with it, which would have left no JS-only descendant of
// main able to reach the shipped build 64 — its native dependencies and
// `expo.autolinking` through autolinking, and "description" through the app
// config, which copies it while app.json has none (both fingerprints moved,
// 2026-10-22). A convenience alias is not worth surrendering the ability to
// ship an update. Treat any package.json edit as moving it until measured
// (`expo.install` is one that does not).

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setAsideFor } from './publish-ota.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS_FILE = 'ota-targets.json';

function parseArgs(argv) {
  const args = { platforms: null, json: false, setAside: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--set-aside') args.setAside = true;
    else if (argv[i] === '--platform') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--platform needs a value: ios or android');
      }
      args.platforms = [value];
      i += 1;
    } else if (argv[i].startsWith('--platform=')) {
      args.platforms = [argv[i].slice('--platform='.length)];
    } else {
      throw new Error(`Unrecognised argument: ${argv[i]}`);
    }
  }
  return args;
}

function readTargets() {
  const raw = readFileSync(path.join(projectRoot, TARGETS_FILE), 'utf8');
  const parsed = JSON.parse(raw);
  const targets = parsed?.targets;
  if (!targets || typeof targets !== 'object') {
    throw new Error(`${TARGETS_FILE} has no "targets" object.`);
  }
  return targets;
}

/**
 * Ask expo-updates for the fingerprint of the working tree. This is the same
 * computation the build performs, so it answers "what would a binary built
 * from this tree right now be stamped with".
 */
function computeFingerprint(platform) {
  const stdout = execFileSync(
    'npx',
    ['expo-updates', 'fingerprint:generate', '--platform', platform],
    { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  // The command prints the full source list as JSON; only the top-level hash
  // matters here. Parsing rather than regexing so a format change fails loudly.
  const hash = JSON.parse(stdout)?.hash;
  if (typeof hash !== 'string' || hash.length === 0) {
    throw new Error(`expo-updates returned no fingerprint hash for ${platform}.`);
  }
  return hash;
}

function present(absolute) {
  try {
    lstatSync(absolute);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `compute` with `files` (paths inside the project) removed, then put
 * them back from memory (a symlink as a symlink), so uncommitted edits
 * survive. A listed file that is missing throws before anything is removed,
 * as publish-ota.mjs's removal does.
 */
function withFilesSetAside(files, compute) {
  const held = files.map((file) => {
    const absolute = path.join(projectRoot, file);
    const stats = lstatSync(absolute);
    return stats.isSymbolicLink()
      ? { absolute, link: readlinkSync(absolute) }
      : { absolute, contents: readFileSync(absolute), mode: stats.mode };
  });
  if (held.length === 0) return compute();
  // The fingerprint runs synchronously, so no listener body runs until it
  // ends; registering one only stops a signal killing Node mid-way, which
  // would leave the files removed. Ctrl-C also reaches the child, whose
  // failure then runs `finally`.
  const keepAlive = () => {};
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, keepAlive);
  try {
    for (const file of held) rmSync(file.absolute);
    return compute();
  } finally {
    for (const file of held) {
      if (present(file.absolute)) continue;
      if (file.link !== undefined) symlinkSync(file.link, file.absolute);
      else writeFileSync(file.absolute, file.contents, { mode: file.mode });
    }
    for (const signal of signals) process.removeListener(signal, keepAlive);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = readTargets();

  const platforms = args.platforms ?? Object.keys(targets);
  const unknown = platforms.filter((platform) => !targets[platform]);
  if (unknown.length > 0) {
    throw new Error(
      `No shipped target recorded for: ${unknown.join(', ')}. `
      + `Add it to ${TARGETS_FILE} when that binary ships.`,
    );
  }

  const results = platforms.map((platform) => {
    const target = targets[platform];
    const setAside = setAsideFor(targets, platform);
    const actual = args.setAside
      ? withFilesSetAside(setAside, () => computeFingerprint(platform))
      : computeFingerprint(platform);
    return {
      platform,
      expected: target.fingerprint,
      actual,
      matches: actual === target.fingerprint,
      shippedAs: `${target.appVersion} (${target.buildNumber})`,
      tracks: target.tracks ?? [],
      setAside,
    };
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      const mark = result.matches ? 'OK  ' : 'FAIL';
      process.stdout.write(
        `${mark} ${result.platform}: ${result.actual}\n`
        + `     shipped ${result.shippedAs} → ${result.expected}`
        + `${result.tracks.length > 0 ? ` (${result.tracks.join(', ')})` : ''}\n`
        + `${args.setAside && result.setAside.length > 0 ? `     fingerprinted without ${result.setAside.join(', ')} (set aside)\n` : ''}`,
      );
    }
  }

  const failed = results.filter((result) => !result.matches);
  if (failed.length === 0) {
    process.stdout.write('\nSafe to publish: every fingerprint matches a shipped build.\n');
    return;
  }

  for (const result of failed.filter((entry) => !args.setAside && entry.setAside.length > 0)) {
    process.stderr.write(
      `\n${result.platform}: its binary was built without ${result.setAside.join(', ')}, which this tree`
      + ' carries, so a mismatch here is expected. scripts/publish-ota.mjs sets those files aside'
      + ' in a throwaway tree before it fingerprints and publishes; --set-aside does the same here.\n',
    );
  }

  process.stderr.write(
    `\nRefusing to publish. ${failed.length} platform(s) do not match the shipped build.\n\n`
    + 'An update published now would report success and reach zero devices.\n\n'
    + 'The usual causes, in order of likelihood:\n'
    + '  - node_modules differs from the lockfile. Run `npm ci`, never `npm install`.\n'
    + '  - Something native changed: a dependency, a config plugin, app.json,\n'
    + '    patches/, eas.json, or .gitignore. That needs a new binary, not an update.\n'
    + `  - A new binary shipped and ${TARGETS_FILE} was not updated with it.\n`,
  );
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
