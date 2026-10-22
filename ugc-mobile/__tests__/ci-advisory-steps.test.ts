import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * The two advisory steps CI added for Expo's patches (see
 * expo-install-exclude.test.ts) are bash in workflow files. These run that
 * bash, read from the workflows, as GitHub Actions does (`bash -e`), with the
 * tool each one wraps replaced by a stand-in, so every outcome is covered:
 * neither step may fail its job, and neither may say "nothing to take" when it
 * could not tell.
 */
const mobileRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(mobileRoot, '..');

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-advisory-'));
  scratch.push(dir);
  return dir;
}

/** The `run: |` block of one step, dedented as Actions hands it to bash. */
function stepScript(workflow: string, name: string) {
  const text = readFileSync(path.join(repoRoot, '.github/workflows', workflow), 'utf8');
  const start = text.indexOf(`      - name: ${name}\n`);
  expect(start, `${workflow}: ${name}`).toBeGreaterThan(-1);
  const end = text.indexOf('\n      - name: ', start + 1);
  const body = text.slice(start, end === -1 ? undefined : end).split('        run: |\n')[1];
  expect(body, `${workflow}: ${name} runs a script`).toBeDefined();
  return body
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

/** A stand-in that prints what the test asks, exits with its code, and records its call. */
function writeStub(bin: string, command: string) {
  const file = path.join(bin, command);
  writeFileSync(
    file,
    [
      '#!/bin/bash',
      'printf "%s" "$*" > "$STUB_DIR/args"',
      'printf "%s" "${EXPO_OFFLINE-unset}" > "$STUB_DIR/expo-offline"',
      'printf "%s" "$STUB_STDOUT"',
      'printf "%s" "$STUB_STDERR" >&2',
      'exit "$STUB_CODE"',
      '',
    ].join('\n'),
  );
  chmodSync(file, 0o755);
}

type Outcome = { stdout?: string; stderr?: string; code: number };

function runStep(script: string, command: string, outcome: Outcome) {
  const dir = scratchDir();
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeStub(bin, command);
  const scriptFile = path.join(dir, 'step.sh');
  writeFileSync(scriptFile, script);
  const summaryFile = path.join(dir, 'summary.md');
  writeFileSync(summaryFile, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    RUNNER_TEMP: dir,
    GITHUB_STEP_SUMMARY: summaryFile,
    STUB_DIR: dir,
    STUB_STDOUT: outcome.stdout ?? '',
    STUB_STDERR: outcome.stderr ?? '',
    STUB_CODE: String(outcome.code),
  };
  delete env.EXPO_OFFLINE;
  const result = spawnSync('bash', ['-e', scriptFile], { cwd: mobileRoot, env, encoding: 'utf8' });
  return {
    status: result.status,
    log: `${result.stdout}${result.stderr}`,
    summary: readFileSync(summaryFile, 'utf8'),
    args: readFileSync(path.join(dir, 'args'), 'utf8'),
    expoOffline: readFileSync(path.join(dir, 'expo-offline'), 'utf8'),
  };
}

describe("the Mobile app job's fingerprint step", () => {
  const script = stepScript('quality.yml', 'Compare the runtime fingerprint with the store builds');

  it('says an update reaches every store build when verify-ota-target passes', () => {
    const run = runStep(script, 'node', { stdout: 'OK   android: 02b8fe85\n', code: 0 });
    expect(run.status).toBe(0);
    expect(run.args).toBe('./scripts/verify-ota-target.mjs --set-aside');
    expect(run.summary).toContain('would reach every store build');
    expect(run.summary).toContain('OK   android: 02b8fe85');
    expect(run.log).not.toContain('::warning');
  });

  it('warns without failing the job when a fingerprint moved or could not be computed', () => {
    const run = runStep(script, 'node', { stdout: 'FAIL ios: 53989c8f\n', stderr: 'Refusing to publish.\n', code: 1 });
    expect(run.status).toBe(0);
    expect(run.summary).toContain('would not reach every store build');
    expect(run.summary).toContain('FAIL ios: 53989c8f');
    expect(run.summary).toContain('Refusing to publish.');
    expect(run.summary).not.toContain('would reach every store build');
    expect(run.log).toContain('::warning title=Over-the-air reach not confirmed::');
  });
});

describe("the store release's live-list report", () => {
  const script = stepScript('mobile-store-release.yml', "Report Expo's live version list");
  const upToDate = JSON.stringify({ dependencies: [], upToDate: true });
  const outdated = JSON.stringify({
    dependencies: [
      { packageName: 'expo', packageType: 'dependencies', expectedVersionOrRange: '~55.0.32', actualVersion: '55.0.31' },
    ],
    upToDate: false,
  });

  it('lists what the live list would add, with a warning, online', () => {
    const run = runStep(script, 'npx', { stdout: outdated, code: 1 });
    expect(run.status).toBe(0);
    expect(run.args).toBe('expo install --check --json');
    expect(run.expoOffline).toBe('unset');
    expect(run.summary).toContain('recommends versions this build does not carry');
    expect(run.summary).toContain('| expo | 55.0.31 | ~55.0.32 |');
    expect(run.log).toContain('::warning title=Expo patches not in this build::');
  });

  it('says nothing is left out only when the live list was read and matched', () => {
    const run = runStep(script, 'npx', { stdout: upToDate, code: 0 });
    expect(run.status).toBe(0);
    expect(run.summary).toContain('Every checked package is at the version');
    expect(run.log).not.toContain('::warning');
  });

  it.each<[string, Outcome, string]>([
    [
      'the check fell back to offline mode',
      { stdout: upToDate, stderr: 'Dependency validation is unreliable in offline-mode\n', code: 0 },
      'fell back to offline mode',
    ],
    ['the network failed', { stderr: 'AggregateError [ECONNREFUSED]\n', code: 1 }, 'the check exited 1'],
    ['the output is not the JSON report', { stdout: 'Dependencies are up to date\n', code: 0 }, 'the check exited 0'],
  ])('reports the list as unread, without failing the job, when %s', (_label, outcome, detail) => {
    const run = runStep(script, 'npx', outcome);
    expect(run.status).toBe(0);
    expect(run.summary).toContain("Expo's live list could not be read");
    expect(run.summary).toContain(detail);
    expect(run.summary).not.toContain('Every checked package');
    expect(run.log).toContain("::warning title=Expo's live list not read::");
  });
});

describe('verify-ota-target.mjs --set-aside', () => {
  const PATCH = 'patches/ios-only.patch';

  /** A project with the two scripts, two targets, and an npx whose hash depends on PATCH. */
  function project({ npxFailsWithoutPatch = false } = {}) {
    const dir = scratchDir();
    mkdirSync(path.join(dir, 'scripts'));
    for (const script of ['verify-ota-target.mjs', 'publish-ota.mjs']) {
      copyFileSync(path.join(mobileRoot, 'scripts', script), path.join(dir, 'scripts', script));
    }
    mkdirSync(path.join(dir, 'patches'));
    writeFileSync(path.join(dir, PATCH), 'iOS only\n');
    writeFileSync(
      path.join(dir, 'ota-targets.json'),
      JSON.stringify({
        targets: {
          android: { fingerprint: 'without-patch', appVersion: '0.1.9', buildNumber: 79, setAside: [PATCH] },
          ios: { fingerprint: 'with-patch', appVersion: '0.1.8', buildNumber: 59 },
        },
      }),
    );
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'npx'),
      [
        '#!/bin/bash',
        `if [ -e ${PATCH} ]; then echo '{"hash":"with-patch"}'; exit 0; fi`,
        npxFailsWithoutPatch ? 'echo "fingerprint failed" >&2; exit 1' : `echo '{"hash":"without-patch"}'`,
        '',
      ].join('\n'),
    );
    chmodSync(path.join(bin, 'npx'), 0o755);
    const run = (...args: string[]) => spawnSync(process.execPath, [path.join(dir, 'scripts/verify-ota-target.mjs'), ...args], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    return { dir, run };
  }

  it('fingerprints each platform without its set-aside files, as publish-ota does, and puts them back', () => {
    const { dir, run } = project();
    const result = run('--set-aside');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK   android: without-patch');
    expect(result.stdout).toContain(`fingerprinted without ${PATCH} (set aside)`);
    expect(result.stdout).toContain('OK   ios: with-patch');
    expect(readFileSync(path.join(dir, PATCH), 'utf8')).toBe('iOS only\n');
  });

  it('without it, still calls a set-aside mismatch expected and refuses', () => {
    const { dir, run } = project();
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL android: with-patch');
    expect(result.stderr).toContain('a mismatch here is expected');
    expect(existsSync(path.join(dir, PATCH))).toBe(true);
  });

  it('puts the files back when the fingerprint fails', () => {
    const { dir, run } = project({ npxFailsWithoutPatch: true });
    const result = run('--set-aside');
    expect(result.status).toBe(1);
    expect(readFileSync(path.join(dir, PATCH), 'utf8')).toBe('iOS only\n');
  });
});
