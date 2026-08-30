#!/usr/bin/env node

// Last gate before a store upload: prove the built artifact actually carries
// the public client configuration.
//
// verify-production-build-env.mjs checks the *environment* a build starts
// from. This checks the *artifact* a build ends with, because the two can
// disagree silently: EXPO_PUBLIC_ values are inlined by Babel at bundle time,
// so a build path that cannot see the env files produces a perfectly valid,
// signed, installable app whose only symptom is "Mobile auth is not
// configured" on the sign-in screen. That is what shipped in
// magicbooklet-0.1.1-ea9888e.aab.
//
// Usage: node ./scripts/verify-bundled-client-env.mjs <path-to.aab|.apk|.ipa>

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseProjectEnv } from '@expo/env';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Values that must be reachable in the shipped bundle. Anything absent here
// leaves a feature dead on device with no crash and no log to find it by.
const REQUIRED_VALUES = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_REVENUECAT_IOS_API_KEY',
  'EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY',
];

function listArchive(artifactPath) {
  return execFileSync('unzip', ['-Z1', artifactPath], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** Locate the JS bundle inside an .aab (base/assets/), .apk (assets/) or .ipa (Payload/*.app/). */
function findBundleEntry(artifactPath) {
  const entries = listArchive(artifactPath);
  const entry = entries.find(
    (name) => name.endsWith('index.android.bundle') || name.endsWith('main.jsbundle'),
  );
  if (!entry) {
    throw new Error(`No JS bundle found inside ${artifactPath}`);
  }
  return entry;
}

/**
 * Read the bundle as latin1 text. Release bundles are Hermes bytecode, but the
 * string table stores inlined values verbatim, so a substring search finds
 * them the same way `strings` does.
 */
function readBundleText(artifactPath, entry) {
  return execFileSync('unzip', ['-p', artifactPath, entry], {
    encoding: 'latin1',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * The values this build was supposed to inline: the same production-mode
 * resolution the bundler performs, so the check can never drift from what
 * we ship. System environment wins, matching dotenv precedence, which keeps
 * this correct on EAS and in CI where the values arrive that way.
 */
export function resolveExpectedValues(systemEnv = process.env) {
  const { env } = parseProjectEnv(projectRoot, { mode: 'production', silent: true });
  return Object.fromEntries(
    REQUIRED_VALUES.map((key) => [key, (systemEnv[key] ?? env[key] ?? '').trim()]),
  );
}

/**
 * Decide whether a bundle is safe to ship.
 *
 * Presence-only on purpose: a value is required to exist and to appear in the
 * bundle, and nothing more is asserted. This catches the whole class of
 * "built without the env files" failures while staying incapable of blocking
 * a legitimate release — a rotated key that reaches both the build and the
 * artifact still passes, because the expected value is read from the same
 * source the bundler read.
 *
 * @param {string} bundleText   The bundle's raw text (latin1).
 * @param {Record<string, string>} expected  Env name -> the exact value this
 *        build was supposed to inline.
 * @returns {string[]} Human-readable problems; an empty array means ship it.
 */
export function findBundledEnvProblems(bundleText, expected) {
  const problems = [];

  for (const key of REQUIRED_VALUES) {
    const value = expected[key]?.trim();

    if (!value) {
      problems.push(
        `${key} has no expected value — cannot prove the bundle carries it. Check ugc-mobile/.env.production.`,
      );
    } else if (!bundleText.includes(value)) {
      problems.push(
        `${key} is not inlined in the bundle. The build could not read the env files; the app will start with this value empty.`,
      );
    }
  }

  return problems;
}

function runCli() {
  const artifactPath = process.argv[2];
  if (!artifactPath) {
    process.stderr.write('Usage: verify-bundled-client-env.mjs <artifact.aab|.apk|.ipa>\n');
    process.exitCode = 1;
    return;
  }

  const entry = findBundleEntry(artifactPath);
  const problems = findBundledEnvProblems(
    readBundleText(artifactPath, entry),
    resolveExpectedValues(),
  );

  if (problems.length > 0) {
    process.stderr.write(`${artifactPath} is not safe to upload:\n`);
    for (const problem of problems) {
      process.stderr.write(`- ${problem}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${artifactPath} (${entry}) carries all required client configuration.\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  runCli();
}
