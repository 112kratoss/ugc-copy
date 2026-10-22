#!/usr/bin/env node

// What Expo's live version list would change in this tree.
//
// CI's dependency check runs offline (EXPO_OFFLINE=1; why, and when Expo's
// newer patches are taken: __tests__/expo-install-exclude.test.ts). This asks
// the live list once more, with expo.install.exclude still honoured, and tells
// a list it read from one it could not. The CLI falls back to the installed
// expo's own list with nothing but a warning on stderr when it is offline,
// when the native-modules endpoint fails, and on a canary SDK, so any warning
// from the CLI counts as "not read".
//
// Usage (CI runs both; .github/workflows/quality.yml):
//   node ./scripts/expo-live-versions.mjs --gate     a release bump: fails unless the list was read and nothing differs
//   node ./scripts/expo-live-versions.mjs --report   main: job summary and a warning, never fails
//
// Like verify-ota-target.mjs, deliberately not an npm script: package.json's
// `scripts` are a fingerprint input.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseMode(argv) {
  if (argv.length === 1 && (argv[0] === '--gate' || argv[0] === '--report')) return argv[0].slice(2);
  throw new Error('Usage: node ./scripts/expo-live-versions.mjs --gate | --report');
}

/** The CLI's own warnings; Node's ("(node:123) [DEP0040] …" and its hint) say nothing about the list. */
function cliWarnings(stderr) {
  return stderr
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\(node:\d+\) /.test(line) && !line.startsWith('(Use `node --trace-'))
    .join('\n');
}

function readLiveList() {
  // Online; without the CLI loading .env files (it reports that on stdout,
  // ahead of the JSON) or Node printing its own warnings to stderr.
  const env = { ...process.env, EXPO_NO_DOTENV: '1', NODE_NO_WARNINGS: '1' };
  delete env.EXPO_OFFLINE;
  const run = spawnSync(path.join(projectRoot, 'node_modules/.bin/expo'), ['install', '--check', '--json'], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = run.stdout ?? '';
  const warnings = [cliWarnings(run.stderr ?? ''), run.error?.message ?? ''].filter(Boolean).join('\n');
  let report = null;
  try {
    report = JSON.parse(stdout);
  } catch {
    // Not the JSON report: handled below.
  }
  if (!report || typeof report.upToDate !== 'boolean' || !Array.isArray(report.dependencies)) {
    return { read: false, reason: `the check exited ${run.status ?? run.signal} without its JSON report`, warnings, stdout };
  }
  if (warnings) return { read: false, reason: 'the check warned and may have used the installed list instead', warnings, stdout };
  return { read: true, report };
}

function summarize(result) {
  const lines = ["### Expo's live version list", ''];
  if (!result.read) {
    lines.push(`Expo's live list could not be read (${result.reason}), so this says nothing about the patches Expo has published since the installed SDK.`);
  } else if (result.report.upToDate) {
    lines.push("Every checked package is at the version Expo's live list recommends.");
  } else {
    lines.push(
      "Expo's live list recommends versions this tree does not carry (packages in `expo.install.exclude` are left out). "
      + 'A release bump takes them; `ugc-mobile/__tests__/expo-install-exclude.test.ts` says how.',
      '',
      "| Package | Installed | Expo's live list |",
      '| --- | --- | --- |',
      ...result.report.dependencies.map((dependency) => (
        `| ${dependency.packageName} | ${dependency.actualVersion} | ${dependency.expectedVersionOrRange} |`
      )),
    );
  }
  for (const text of [result.warnings, result.read ? '' : result.stdout?.trim()]) {
    if (text) lines.push('', '```', text, '```');
  }
  return `${lines.join('\n')}\n`;
}

function publish(summary) {
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

function main() {
  const mode = parseMode(process.argv.slice(2));
  if (mode === 'report') {
    try {
      const result = readLiveList();
      publish(summarize(result));
      if (!result.read) process.stdout.write("::warning title=Expo's live list not read::See the job summary.\n");
      else if (!result.report.upToDate) process.stdout.write('::warning title=Expo patches not taken::See the job summary.\n');
    } catch (error) {
      process.stdout.write(`::warning title=Expo's live list not read::${String(error?.message ?? error).split('\n')[0]}\n`);
    }
    return;
  }

  const result = readLiveList();
  publish(summarize(result));
  if (!result.read) {
    process.stderr.write(
      "\nExpo's live list could not be read, so this release bump is unchecked. A network error in the output\n"
      + 'above clears on a rerun of the job; anything else needs fixing first.\n',
    );
    process.exitCode = 1;
  } else if (!result.report.upToDate) {
    process.stderr.write(
      "\nThis pull request changes the app's version, so new store binaries follow it and Expo's patches cost no\n"
      + 'over-the-air reach here. Take them: in ugc-mobile run `./node_modules/.bin/expo install --fix` (online),\n'
      + 'then repin what pins those versions (__tests__/expo-install-exclude.test.ts says what). A package that\n'
      + 'must stay behind gets a lasting entry in expo.install.exclude instead, with the reason beside its pin.\n',
    );
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
