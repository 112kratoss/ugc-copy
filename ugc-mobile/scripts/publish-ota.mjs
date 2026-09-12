#!/usr/bin/env node

// Publishes a JS-only over-the-air update the one way that has proven safe, so
// no step can be skipped or drift again. Dry run by default: it builds and
// verifies the exact artifact, and only `--publish` uploads it.
//
// Each step is here because skipping it once cost something:
//
// - It builds in a throwaway detached worktree at a commit on origin/main, with
//   a real `npm ci`. A symlinked or `npm install`ed node_modules fingerprints
//   differently, and a working checkout ships whatever happens to be in it.
// - That tree has no ugc-mobile/.env.local. The local copy carries EMPTY
//   RevenueCat keys, and an update built from it turns purchases off for every
//   user without a single crash. Values come from `eas env:exec production`.
// - Fingerprints are checked against origin/main's ota-targets.json, the
//   binaries actually in users' hands. An update at any other runtime version
//   reports success and reaches nobody.
// - Files a target lists under "setAside" are removed from the tree before that
//   platform is fingerprinted. They landed on main after that binary was built
//   and only touch another platform's native code (Android build 71 predates
//   the iOS-only expo-video patch). The list is dropped when a new binary ships.
// - Each export gets a private, empty Metro cache. The shared one is keyed
//   without EXPO_PUBLIC values, so it can serve another tree's placeholders.
// - It exports with --source-maps. Without that flag hermesc embeds -g1 debug
//   info, about 40% of the bundle (7.23 MB against 4.44 MB for the same code),
//   which nothing on a phone reads; `eas update`'s own bundler already asks for
//   maps. The .map stays in the artifacts directory: metadata.json never lists
//   it, so phones never download it.
// - The artifact is checked inside `eas env:exec production`: every production
//   EXPO_PUBLIC value inlined (reported only as a prefix and a length), nothing
//   local or placeholder, no embedded debug info, and any --expect markers.
//   `eas update --skip-bundler` then uploads those exact bytes.
// - It refuses to publish over a newer live update, which would silently roll
//   back someone else's release, and refuses a release with no mobile changes,
//   which would only make phones download the same code again.
//
// Usage (from ugc-mobile/):
//   node ./scripts/publish-ota.mjs --platform all                  # dry run
//   node ./scripts/publish-ota.mjs --platform all --publish --rollout 20
//   node ./scripts/publish-ota.mjs --platform ios --ref <sha> --expect "An ASCII marker" --publish
//
// Not an npm script, for the reason in verify-ota-target.mjs: package.json is a
// fingerprint input in its entirety.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLATFORMS = ['ios', 'android'];
const BRANCH = 'production';

// Mirrors REQUIRED_PRODUCTION_CLIENT_ENV in app.config.ts; a test keeps them equal.
export const REQUIRED_PRODUCTION_CLIENT_ENV = [
  'EXPO_PUBLIC_SITE_URL',
  'EXPO_PUBLIC_API_BASE_URL',
  'EXPO_PUBLIC_WEB_API_BASE_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_REVENUECAT_IOS_API_KEY',
  'EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY',
];

// Local stacks, dev servers and CI placeholders: none of these may reach a phone.
export const FORBIDDEN_BUNDLE_STRINGS = [
  'ci-placeholder',
  'example.supabase.co',
  ':54321',
  'localhost:3111',
  '127.0.0.1:8081',
  '127.0.0.1:8082',
  '127.0.0.1:8083',
  '127.0.0.1:8084',
];

// hermesc -g0 leaves a 48-byte debug-info tail; -g1 leaves megabytes.
export const MAX_DEBUG_INFO_BYTES = 4096;

// Where the header stores debugInfoOffset, per bytecode version. Verified for
// v96 (React Native 0.83) against hermesc -g0/-g1/-g2 output of the same code.
const DEBUG_INFO_OFFSET_FIELD = { 96: 104 };

export function parseArgs(argv) {
  const options = {
    platforms: null,
    ref: 'origin/main',
    message: null,
    rollout: null,
    expect: [],
    artifactsDir: null,
    targetsFile: null,
    publish: false,
    allowUnmerged: false,
    allowRollback: false,
    allowRepublish: false,
    keepWorktree: false,
  };
  const valueOf = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--platform': {
        const value = valueOf(i, arg);
        i += 1;
        if (value === 'all') options.platforms = [...PLATFORMS];
        else if (PLATFORMS.includes(value)) options.platforms = [value];
        else throw new Error('--platform must be ios, android, or all.');
        break;
      }
      case '--ref':
        options.ref = valueOf(i, arg);
        i += 1;
        break;
      case '--message':
        options.message = valueOf(i, arg);
        i += 1;
        break;
      case '--rollout': {
        const value = Number(valueOf(i, arg));
        i += 1;
        if (!Number.isInteger(value) || value < 1 || value > 100) {
          throw new Error('--rollout must be a whole percentage from 1 to 100.');
        }
        options.rollout = value;
        break;
      }
      case '--expect': {
        const value = valueOf(i, arg);
        i += 1;
        assertAsciiMarker(value);
        options.expect.push(value);
        break;
      }
      case '--artifacts-dir':
        options.artifactsDir = path.resolve(valueOf(i, arg));
        i += 1;
        break;
      case '--targets-file':
        options.targetsFile = path.resolve(valueOf(i, arg));
        i += 1;
        break;
      case '--publish':
        options.publish = true;
        break;
      case '--allow-unmerged':
        options.allowUnmerged = true;
        break;
      case '--allow-rollback':
        options.allowRollback = true;
        break;
      case '--allow-republish':
        options.allowRepublish = true;
        break;
      case '--keep-worktree':
        options.keepWorktree = true;
        break;
      default:
        throw new Error(`Unrecognised argument: ${arg}`);
    }
  }

  if (!options.platforms) throw new Error('--platform is required: ios, android, or all.');
  return options;
}

export function assertAsciiMarker(marker) {
  if (!/^[\x20-\x7e]+$/.test(marker)) {
    throw new Error(
      `--expect ${JSON.stringify(marker)} must be printable ASCII: Hermes stores other text `
      + 'as UTF-16, so a byte search would never find it.',
    );
  }
}

/** The files a shipped target was built without, validated as paths inside ugc-mobile. */
export function setAsideFor(targets, platform) {
  const list = targets?.[platform]?.setAside ?? [];
  if (!Array.isArray(list)) throw new Error(`ota-targets.json: ${platform}.setAside must be an array.`);
  for (const entry of list) {
    if (
      typeof entry !== 'string'
      || entry.length === 0
      || path.isAbsolute(entry)
      || entry.split(/[\\/]/).includes('..')
    ) {
      throw new Error(`ota-targets.json: ${platform}.setAside entry ${JSON.stringify(entry)} must be a path inside ugc-mobile.`);
    }
  }
  return list;
}

/** Tags the update so a later publish can tell exactly which commit is live. */
export function formatMessage(message, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Not a full commit SHA: ${sha}`);
  return `${message.trim()} [src:${sha}]`;
}

/**
 * Commits an update message may name, most reliable first. Updates from this
 * script carry `[src:<sha>]`; earlier ones only mention a short SHA in prose,
 * so any hex token of seven or more characters with a letter in it qualifies.
 */
export function sourceCommitCandidates(message) {
  const tagged = message.match(/\[src:([0-9a-f]{40})\]/);
  if (tagged) return [tagged[1]];
  return [...message.matchAll(/\b[0-9a-f]{7,40}\b/g)]
    .map((match) => match[0])
    .filter((token) => /[a-f]/.test(token));
}

/** `eas update:list` is newest first; keep the first update seen for each platform. */
export function latestUpdatePerPlatform(updates) {
  const latest = {};
  for (const update of updates) {
    for (const platform of String(update.platforms ?? '').split(',').map((p) => p.trim())) {
      if (PLATFORMS.includes(platform) && !latest[platform]) latest[platform] = update;
    }
  }
  return latest;
}

/**
 * Bytes of debug info embedded in a Hermes bundle; null when this bytecode
 * version's header layout is unknown, undefined when it is not Hermes at all.
 */
export function hermesDebugInfoBytes(bytes) {
  if (bytes.length < 128 || bytes.readUInt32LE(0) !== 0x03bc1fc6 || bytes.readUInt32LE(4) !== 0x1f1903c1) {
    return undefined;
  }
  const field = DEBUG_INFO_OFFSET_FIELD[bytes.readUInt32LE(8)];
  if (field === undefined) return null;
  return bytes.readUInt32LE(32) - bytes.readUInt32LE(field);
}

/** Every check the artifact must pass. Labels never contain a value, only its prefix and length. */
export function inspectBundle({ bytes, hasSourceMap, env, expect = [] }) {
  const results = [];
  const text = bytes.toString('latin1');

  results.push({ ok: hasSourceMap, label: 'source map written beside the bundle (hermesc -output-source-map)' });
  const debugInfo = hermesDebugInfoBytes(bytes);
  if (debugInfo === undefined) {
    results.push({ ok: false, label: 'bundle is Hermes bytecode' });
  } else if (debugInfo === null) {
    results.push({ ok: true, label: 'embedded debug info not measured: bytecode layout unknown here, the source-map check stands in' });
  } else {
    results.push({ ok: debugInfo <= MAX_DEBUG_INFO_BYTES, label: `embedded debug info ${debugInfo} bytes (limit ${MAX_DEBUG_INFO_BYTES})` });
  }

  for (const name of REQUIRED_PRODUCTION_CLIENT_ENV) {
    const value = (env[name] ?? '').trim();
    results.push({
      ok: value.length > 0 && text.includes(value),
      label: `${name} inlined (prefix ${value.slice(0, 4) || '∅'}…, length ${value.length})`,
    });
  }
  for (const forbidden of FORBIDDEN_BUNDLE_STRINGS) {
    results.push({ ok: !text.includes(forbidden), label: `absent: ${forbidden}` });
  }
  for (const marker of expect) {
    results.push({ ok: text.includes(marker), label: `marker present: ${marker}` });
  }
  return results;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function findBundles(dir) {
  const found = [];
  const visit = (current) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (entry.endsWith('.hbc')) found.push(full);
    }
  };
  visit(dir);
  return found;
}

// `check-bundle` runs inside `eas env:exec production`, where process.env holds
// the real values; it is how the main flow checks an export.
function checkBundleCommand(argv) {
  const [dir, ...rest] = argv;
  const expect = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== '--expect' || rest[i + 1] === undefined) throw new Error(`Unrecognised argument: ${rest[i]}`);
    assertAsciiMarker(rest[i + 1]);
    expect.push(rest[i + 1]);
    i += 1;
  }

  const bundles = findBundles(dir);
  if (bundles.length !== 1) throw new Error(`Expected exactly one .hbc bundle in ${dir}, found ${bundles.length}.`);
  const [bundle] = bundles;
  const results = inspectBundle({
    bytes: readFileSync(bundle),
    hasSourceMap: existsSync(`${bundle}.map`),
    env: process.env,
    expect,
  });

  process.stdout.write(`bundle ${path.basename(bundle)} (${statSync(bundle).size} bytes)\n`);
  for (const result of results) process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} ${result.label}\n`);
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(failed.length === 0 ? 'RESULT: PASS\n' : `RESULT: FAIL (${failed.length})\n`);
  if (failed.length > 0) process.exitCode = 1;
}

function run(command, args, { cwd, env = {}, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} … exited with status ${result.status}.`);
  return capture ? result.stdout : '';
}

function succeeds(command, args, cwd) {
  return spawnSync(command, args, { cwd, stdio: 'ignore' }).status === 0;
}

function step(text) {
  process.stdout.write(`\n▸ ${text}\n`);
}

// The same computation as verify-ota-target.mjs and the build itself.
function fingerprintOf(mobileDir, platform) {
  const stdout = run('npx', ['expo-updates', 'fingerprint:generate', '--platform', platform], { cwd: mobileDir, capture: true });
  const hash = JSON.parse(stdout)?.hash;
  if (typeof hash !== 'string' || hash.length === 0) throw new Error(`expo-updates returned no fingerprint for ${platform}.`);
  return hash;
}

function liveCommitFor(update, repoRoot) {
  for (const candidate of sourceCommitCandidates(update.message ?? '')) {
    const resolved = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { cwd: repoRoot, encoding: 'utf8' });
    if (resolved.status === 0) return resolved.stdout.trim();
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = run('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(SCRIPT_PATH), capture: true }).trim();

  step('Resolving the commit');
  run('git', ['fetch', 'origin', 'main', '--quiet'], { cwd: repoRoot });
  const sha = run('git', ['rev-parse', '--verify', `${options.ref}^{commit}`], { cwd: repoRoot, capture: true }).trim();
  const subject = run('git', ['log', '-1', '--format=%s', sha], { cwd: repoRoot, capture: true }).trim();
  process.stdout.write(`${sha.slice(0, 7)} ${subject}\n`);
  if (!succeeds('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], repoRoot) && !options.allowUnmerged) {
    throw new Error(`${sha.slice(0, 7)} is not on origin/main. Publish reviewed code, or pass --allow-unmerged.`);
  }

  const targetsJson = options.targetsFile
    ? readFileSync(options.targetsFile, 'utf8')
    : run('git', ['show', 'origin/main:ugc-mobile/ota-targets.json'], { cwd: repoRoot, capture: true });
  const targets = JSON.parse(targetsJson).targets;
  for (const platform of options.platforms) {
    if (!targets?.[platform]?.fingerprint) throw new Error(`ota-targets.json records no shipped ${platform} binary.`);
    setAsideFor(targets, platform);
  }

  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'magicbooklet-ota-tree-'));
  const worktree = path.join(workRoot, 'tree');
  const mobileDir = path.join(worktree, 'ugc-mobile');
  const artifactsDir = options.artifactsDir ?? mkdtempSync(path.join(os.tmpdir(), `magicbooklet-ota-${sha.slice(0, 7)}-`));
  const summary = [];

  step(`Building a throwaway tree at ${sha.slice(0, 7)}`);
  run('git', ['worktree', 'add', '--detach', worktree, sha], { cwd: repoRoot });
  try {
    if (existsSync(path.join(mobileDir, '.env.local'))) {
      throw new Error('The publish tree has a ugc-mobile/.env.local; refusing to build from local values.');
    }
    run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: mobileDir });
    const cliVersion = JSON.parse(readFileSync(path.join(mobileDir, 'eas.json'), 'utf8'))?.cli?.version;
    if (!cliVersion) throw new Error('eas.json pins no cli.version.');
    const eas = (args) => ['--yes', `eas-cli@${cliVersion}`, ...args];

    step('Checking what is live');
    const listing = JSON.parse(run('npx', eas(['update:list', '--branch', BRANCH, '--limit', '25', '--json', '--non-interactive']), { cwd: mobileDir, capture: true }));
    const live = latestUpdatePerPlatform(listing.currentPage ?? listing);
    // A dry run reports what a publish would refuse, then still builds and checks.
    const refuse = (reason) => {
      if (options.publish) throw new Error(reason);
      process.stdout.write(`a publish would refuse: ${reason}\n`);
    };
    for (const platform of options.platforms) {
      if (!live[platform]) {
        process.stdout.write(`${platform}: nothing published on "${BRANCH}" yet\n`);
        continue;
      }
      const liveSha = liveCommitFor(live[platform], repoRoot);
      if (!liveSha) {
        process.stdout.write(`${platform}: live group ${live[platform].group} names no commit this checkout knows; check the dashboard before publishing\n`);
        continue;
      }
      process.stdout.write(`${platform}: live group ${live[platform].group} is ${liveSha.slice(0, 7)}\n`);
      if (!succeeds('git', ['merge-base', '--is-ancestor', liveSha, sha], repoRoot) && !options.allowRollback) {
        refuse(`${platform}'s live update (${liveSha.slice(0, 7)}) is not an ancestor of ${sha.slice(0, 7)}, so publishing would roll it back. Pass --allow-rollback if that is the point.`);
      } else if (succeeds('git', ['diff', '--quiet', liveSha, sha, '--', 'ugc-mobile'], repoRoot) && !options.allowRepublish) {
        refuse(`${platform}: nothing under ugc-mobile changed since the live update (${liveSha.slice(0, 7)}), so phones would download the same code again. Pass --allow-republish if that is the point.`);
      }
    }

    for (const platform of options.platforms) {
      const setAside = setAsideFor(targets, platform);
      const exportDir = path.join(artifactsDir, platform);
      try {
        step(`${platform}: fingerprint`);
        for (const file of setAside) rmSync(path.join(mobileDir, file));
        if (setAside.length > 0) process.stdout.write(`set aside for this binary: ${setAside.join(', ')}\n`);
        const expected = targets[platform].fingerprint;
        const actual = fingerprintOf(mobileDir, platform);
        process.stdout.write(`${actual === expected ? 'OK  ' : 'FAIL'} ${actual} (shipped ${targets[platform].appVersion} (${targets[platform].buildNumber}) → ${expected})\n`);
        if (actual !== expected) {
          throw new Error(`${platform} fingerprint does not match the shipped binary, so the update would reach nobody. Something native changed, or ota-targets.json is stale.`);
        }

        // A set-aside file is a deleted tracked file, and eas.json requires a clean tree.
        const vcs = setAside.length > 0 ? { EAS_NO_VCS: '1' } : {};

        // Metro's transform cache lives in os.tmpdir()/metro-cache for every project
        // on the machine, and its key is a file's relative path, content and
        // transform options: not the project root, not EXPO_PUBLIC values, not the
        // Babel plugin. So an export can inline another tree's placeholder values
        // and pre-#152 icon imports; a dry run did exactly that on 2026-09-12.
        // A private TMPDIR gives each export its own empty cache.
        const metroTmp = mkdtempSync(path.join(workRoot, `tmp-${platform}-`));

        step(`${platform}: export`);
        run('npx', eas([
          'env:exec', 'production',
          `CI=1 TMPDIR=${shellQuote(metroTmp)} ./node_modules/.bin/expo export --platform ${platform} --output-dir ${shellQuote(exportDir)} --dump-assetmap --source-maps --clear`,
          '--non-interactive',
        ]), { cwd: mobileDir, env: vcs });

        step(`${platform}: check the artifact against production values`);
        const expectArgs = options.expect.map((marker) => `--expect ${shellQuote(marker)}`).join(' ');
        run('npx', eas([
          'env:exec', 'production',
          `node ${shellQuote(SCRIPT_PATH)} check-bundle ${shellQuote(exportDir)} ${expectArgs}`.trim(),
          '--non-interactive',
        ]), { cwd: mobileDir, env: vcs });

        if (!options.publish) {
          summary.push({ platform, result: 'verified, not published (dry run)', artifact: exportDir });
          continue;
        }

        step(`${platform}: publish`);
        const publishArgs = [
          'update', '--branch', BRANCH, '--environment', 'production', '--platform', platform,
          '--skip-bundler', '--input-dir', exportDir,
          '--message', formatMessage(options.message ?? subject, sha),
          '--non-interactive', '--json',
        ];
        if (options.rollout) publishArgs.push('--rollout-percentage', String(options.rollout));
        const output = run('npx', eas(publishArgs), { cwd: mobileDir, env: { CI: '1', ...vcs }, capture: true });
        const published = JSON.parse(output).find((update) => update.platform === platform);
        if (!published) throw new Error(`eas update printed no ${platform} update:\n${output}`);
        if (published.runtimeVersion !== expected) {
          throw new Error(`Published ${platform} group ${published.group} at runtime ${published.runtimeVersion}, not the shipped ${expected}: it reaches nobody. Roll it back from the dashboard.`);
        }
        summary.push({
          platform,
          result: `published group ${published.group} at ${published.runtimeVersion.slice(0, 8)}…${options.rollout ? `, ${options.rollout}% rollout` : ''}`,
          artifact: exportDir,
        });
      } finally {
        if (setAside.length > 0) run('git', ['checkout', '--', ...setAside], { cwd: mobileDir });
      }
    }
  } finally {
    if (options.keepWorktree) {
      process.stdout.write(`\nKept the publish tree at ${worktree}\n`);
    } else {
      run('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot });
      rmSync(workRoot, { recursive: true, force: true });
    }
  }

  step(options.publish ? 'Published' : 'Dry run complete: pass --publish to upload these exact artifacts');
  for (const row of summary) process.stdout.write(`${row.platform}: ${row.result}\n  artifact and source map: ${row.artifact}\n`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (invokedDirectly) {
  const entry = process.argv[2] === 'check-bundle'
    ? () => checkBundleCommand(process.argv.slice(3))
    : main;
  Promise.resolve()
    .then(entry)
    .catch((error) => {
      process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
