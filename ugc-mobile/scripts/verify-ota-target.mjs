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
//
// Deliberately NOT wired to an npm script. package.json is a fingerprint input
// in its entirety, so adding `"ota:preflight": "..."` to it moves the runtime
// version — verified on 2026-08-31: the identical tree fingerprinted
// 9e59d85d… without the script line and d832ccd9… with it, which would have
// left no JS-only descendant of main able to reach the shipped build 64. A
// convenience alias is not worth surrendering the ability to ship an update.
// The same applies to renaming a script, editing "description", or any other
// package.json edit that looks harmless.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS_FILE = 'ota-targets.json';

function parseArgs(argv) {
  const args = { platforms: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
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
    const actual = computeFingerprint(platform);
    return {
      platform,
      expected: target.fingerprint,
      actual,
      matches: actual === target.fingerprint,
      shippedAs: `${target.appVersion} (${target.buildNumber})`,
      tracks: target.tracks ?? [],
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
        + `${result.tracks.length > 0 ? ` (${result.tracks.join(', ')})` : ''}\n`,
      );
    }
  }

  const failed = results.filter((result) => !result.matches);
  if (failed.length === 0) {
    process.stdout.write('\nSafe to publish: every fingerprint matches a shipped build.\n');
    return;
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
