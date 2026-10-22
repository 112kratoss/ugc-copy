import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stepScript, workflowJob, workflowStep } from './fixtures/workflow-steps';

/**
 * The checks CI added around Expo's patches (why: expo-install-exclude.test.ts)
 * are bash in quality.yml and two scripts. These run that bash, read from the
 * workflow, as GitHub Actions does (`bash -e`), and the scripts in a scratch
 * project, each with the tool it wraps replaced by a stand-in, through every
 * outcome: an advisory step never fails its job, the release-bump gate fails
 * unless Expo's live list was read and has nothing to add, and nothing says
 * "nothing to take" when it could not tell.
 */
const mobileRoot = path.resolve(__dirname, '..');

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-expo-checks-'));
  scratch.push(dir);
  return dir;
}

function writeExecutable(file: string, lines: string[]) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
  chmodSync(file, 0o755);
}

/** A stand-in that prints what the test asks, exits with its code, and records its call. */
function writeStub(file: string) {
  writeExecutable(file, [
    '#!/bin/bash',
    'printf "%s" "$*" > "$STUB_DIR/args"',
    'printf "%s" "${EXPO_OFFLINE-unset}" > "$STUB_DIR/expo-offline"',
    'printf "%s %s" "${EXPO_NO_DOTENV-unset}" "${NODE_NO_WARNINGS-unset}" > "$STUB_DIR/quiet"',
    'printf "%s" "$STUB_STDOUT"',
    'printf "%s" "$STUB_STDERR" >&2',
    'exit "$STUB_CODE"',
  ]);
}

type Outcome = { stdout?: string; stderr?: string; code: number };

/** The test's own environment without EXPO_OFFLINE or a step summary, plus the stub's outcome and `extra`. */
function stubEnv(dir: string, outcome: Outcome, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.EXPO_OFFLINE;
  delete env.GITHUB_STEP_SUMMARY;
  return {
    ...env,
    STUB_DIR: dir,
    STUB_STDOUT: outcome.stdout ?? '',
    STUB_STDERR: outcome.stderr ?? '',
    STUB_CODE: String(outcome.code),
    ...extra,
  };
}

const recorded = (dir: string, name: string) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : null);

describe("the Mobile app job's fingerprint step", () => {
  const name = 'Compare the runtime fingerprint with the store builds';
  const script = stepScript('quality.yml', name);

  function run(outcome: Outcome) {
    const dir = scratchDir();
    writeStub(path.join(dir, 'bin/node'));
    const summary = path.join(dir, 'summary.md');
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd: mobileRoot,
      env: stubEnv(dir, outcome, {
        PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: summary,
      }),
      encoding: 'utf8',
    });
    return { status: result.status, log: `${result.stdout}${result.stderr}`, summary: readFileSync(summary, 'utf8'), args: recorded(dir, 'args') };
  }

  it('never fails its job', () => {
    expect(workflowStep('quality.yml', name)).toContain('continue-on-error: true');
  });

  it('says an update reaches every store build when verify-ota-target passes', () => {
    const result = run({ stdout: 'OK   android: 02b8fe85\n', code: 0 });
    expect(result.status).toBe(0);
    expect(result.args).toBe('./scripts/verify-ota-target.mjs --set-aside');
    expect(result.summary).toContain('would reach every store build');
    expect(result.summary).toContain('OK   android: 02b8fe85');
    expect(result.log).not.toContain('::warning');
  });

  it('warns, and still passes, when a fingerprint moved or could not be computed', () => {
    const result = run({ stdout: 'FAIL ios: 53989c8f\n', stderr: 'Refusing to publish.\n', code: 1 });
    expect(result.status).toBe(0);
    expect(result.summary).toContain('would not reach every store build');
    expect(result.summary).toContain('FAIL ios: 53989c8f');
    expect(result.summary).toContain('Refusing to publish.');
    expect(result.log).toContain('::warning title=Over-the-air reach not confirmed::');
  });
});

describe('the release-bump check of the live list', () => {
  const name = "Check Expo's live version list at a release bump";
  const script = stepScript('quality.yml', name);

  /** A merge commit at `head` whose first parent says `base`, with git and the script stood in for. */
  function run(base: string | null, head: string, gate: Outcome) {
    const dir = scratchDir();
    writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ expo: { version: head } }));
    writeExecutable(path.join(dir, 'bin/git'), [
      '#!/bin/bash',
      'printf "%s" "$*" > "$STUB_DIR/git-args"',
      base === null
        ? 'echo "fatal: bad revision" >&2; exit 128'
        : `printf '%s' '${JSON.stringify({ expo: { version: base } })}'`,
    ]);
    writeExecutable(path.join(dir, 'scripts/expo-live-versions.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(`${process.env.STUB_DIR}/args`, process.argv.slice(2).join(' '));",
      'process.exit(Number(process.env.STUB_CODE));',
    ]);
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd: dir,
      env: stubEnv(dir, gate, { PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` }),
      encoding: 'utf8',
    });
    return {
      status: result.status,
      log: `${result.stdout}${result.stderr}`,
      args: recorded(dir, 'args'),
      gitArgs: recorded(dir, 'git-args'),
    };
  }

  it('runs only on pull requests, fails the job when it fails, and has the base it reads', () => {
    const step = workflowStep('quality.yml', name);
    expect(step).toContain("if: github.event_name == 'pull_request'");
    expect(step).not.toContain('continue-on-error');
    expect(workflowJob('quality.yml', 'mobile')).toMatch(/uses: actions\/checkout@v6\n {8}with:\n {10}fetch-depth: 2\n/);
  });

  it('reads the base from the merge commit it runs on, not from the base branch now', () => {
    expect(run('0.1.8', '0.1.8', { code: 0 }).gitArgs).toBe('show HEAD^1:ugc-mobile/app.json');
  });

  it.each([
    ['keeps the version', '0.1.8', '0.1.8'],
    ['takes the version back', '0.1.9', '0.1.8'],
  ])('leaves a pull request that %s alone', (_label, base, head) => {
    const result = run(base, head, { code: 1 });
    expect(result.status).toBe(0);
    expect(result.args).toBeNull();
    expect(result.log).toContain('Not a release bump');
  });

  it('gates a pull request that raises the version on the live list', () => {
    expect(run('0.1.8', '0.1.9', { code: 0 })).toMatchObject({ status: 0, args: '--gate' });
    expect(run('0.1.9', '0.1.10', { code: 0 })).toMatchObject({ status: 0, args: '--gate' });
    expect(run('0.1.8', '0.1.9', { code: 1 }).status).not.toBe(0);
  });

  it('fails, rather than skipping, when it cannot read the base', () => {
    const result = run(null, '0.1.9', { code: 0 });
    expect(result.status).not.toBe(0);
    expect(result.args).toBeNull();
  });
});

describe("the live-list report on main's runs", () => {
  it('runs only on pushes and never fails its job', () => {
    const step = workflowStep('quality.yml', "Report Expo's live version list");
    expect(step).toContain("if: github.event_name == 'push'");
    expect(step).toContain('continue-on-error: true');
    expect(step).toContain('node ./scripts/expo-live-versions.mjs --report');
  });
});

describe('scripts/expo-live-versions.mjs', () => {
  const upToDate = JSON.stringify({ dependencies: [], upToDate: true });
  const outdated = JSON.stringify({
    dependencies: [
      { packageName: 'expo', packageType: 'dependencies', expectedVersionOrRange: '~55.0.32', actualVersion: '55.0.31' },
    ],
    upToDate: false,
  });

  function run(mode: string, outcome: Outcome) {
    const dir = scratchDir();
    mkdirSync(path.join(dir, 'scripts'));
    copyFileSync(path.join(mobileRoot, 'scripts/expo-live-versions.mjs'), path.join(dir, 'scripts/expo-live-versions.mjs'));
    writeStub(path.join(dir, 'node_modules/.bin/expo'));
    const summary = path.join(dir, 'summary.md');
    writeFileSync(summary, '');
    const result = spawnSync(process.execPath, [path.join(dir, 'scripts/expo-live-versions.mjs'), mode], {
      env: stubEnv(dir, outcome, { EXPO_OFFLINE: '1', GITHUB_STEP_SUMMARY: summary }),
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: readFileSync(summary, 'utf8'),
      args: recorded(dir, 'args'),
      expoOffline: recorded(dir, 'expo-offline'),
      quiet: recorded(dir, 'quiet'),
    };
  }

  it('asks the live list online, with no .env output or Node warnings in the way', () => {
    const result = run('--report', { stdout: upToDate, code: 0 });
    expect(result.args).toBe('install --check --json');
    expect(result.expoOffline).toBe('unset');
    expect(result.quiet).toBe('1 1');
  });

  it('lists what the live list would add: a warning on main, a failure at a release bump', () => {
    const report = run('--report', { stdout: outdated, code: 1 });
    expect(report.status).toBe(0);
    expect(report.summary).toContain('| expo | 55.0.31 | ~55.0.32 |');
    expect(report.stdout).toContain('::warning title=Expo patches not taken::');

    const gate = run('--gate', { stdout: outdated, code: 1 });
    expect(gate.status).toBe(1);
    expect(gate.summary).toContain('| expo | 55.0.31 | ~55.0.32 |');
    expect(gate.stderr).toContain('expo install --fix');
  });

  it('says nothing is left out only when the live list was read and matched', () => {
    for (const outcome of [
      { stdout: upToDate, code: 0 },
      {
        stdout: upToDate,
        stderr: '(node:4242) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n'
          + '(Use `node --trace-deprecation ...` to show where the warning was created)\n',
        code: 0,
      },
    ]) {
      const report = run('--report', outcome);
      expect(report.status).toBe(0);
      expect(report.summary).toContain('Every checked package is at the version');
      expect(report.stdout).not.toContain('::warning');
      expect(run('--gate', outcome).status).toBe(0);
    }
  });

  it.each<[string, Outcome]>([
    ['it fell back to offline mode', { stdout: upToDate, stderr: 'Dependency validation is unreliable in offline-mode\n', code: 0 }],
    [
      'the native-modules endpoint failed',
      {
        stdout: upToDate,
        stderr: 'Unable to reach well-known versions endpoint. Using local dependency map expo/bundledNativeModules.json for version validation\n',
        code: 0,
      },
    ],
    ['the SDK is a canary', { stdout: upToDate, stderr: 'Dependency validation might be unreliable when using canary SDK versions\n', code: 0 }],
    ['the network failed', { stderr: 'AggregateError [ECONNREFUSED]\n', code: 1 }],
    ['its output is not the JSON report', { stdout: 'Dependencies are up to date\n', code: 0 }],
  ])('calls the list unread when %s: a warning on main, a failure at a release bump', (_label, outcome) => {
    const report = run('--report', outcome);
    expect(report.status).toBe(0);
    expect(report.summary).toContain("Expo's live list could not be read");
    expect(report.summary).not.toContain('Every checked package');
    expect(report.stdout).toContain("::warning title=Expo's live list not read::");

    const gate = run('--gate', outcome);
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain('could not be read');
  });

  it('refuses to guess a mode', () => {
    expect(run('--both', { stdout: upToDate, code: 0 }).status).toBe(2);
  });
});

describe('scripts/verify-ota-target.mjs --set-aside', () => {
  const PATCH = 'patches/ios-only.patch';

  /** A project with the two scripts, two targets, and an npx whose hash depends on PATCH. */
  function project({ setAside = [PATCH], npxFailsWithoutPatch = false } = {}) {
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
          android: { fingerprint: 'without-patch', appVersion: '0.1.9', buildNumber: 79, setAside },
          ios: { fingerprint: 'with-patch', appVersion: '0.1.8', buildNumber: 59 },
        },
      }),
    );
    writeExecutable(path.join(dir, 'bin/npx'), [
      '#!/bin/bash',
      `if [ -e ${PATCH} ]; then echo '{"hash":"with-patch"}'; exit 0; fi`,
      npxFailsWithoutPatch ? 'echo "fingerprint failed" >&2; exit 1' : `echo '{"hash":"without-patch"}'`,
    ]);
    const run = (...args: string[]) => spawnSync(process.execPath, [path.join(dir, 'scripts/verify-ota-target.mjs'), ...args], {
      env: { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    return { dir, run };
  }

  it('fingerprints each platform without its set-aside files, then puts them back', () => {
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
    expect(run('--set-aside').status).toBe(1);
    expect(readFileSync(path.join(dir, PATCH), 'utf8')).toBe('iOS only\n');
  });

  it('fails on a listed file that is missing, as publish-ota does, and removes nothing', () => {
    const { dir, run } = project({ setAside: [PATCH, 'patches/removed-on-main.patch'] });
    const result = run('--set-aside');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('removed-on-main.patch');
    expect(readFileSync(path.join(dir, PATCH), 'utf8')).toBe('iOS only\n');
  });

  it('puts a symlinked file back as the same symlink', () => {
    const { dir, run } = project();
    rmSync(path.join(dir, PATCH));
    writeFileSync(path.join(dir, 'patches/real.patch'), 'iOS only\n');
    symlinkSync('real.patch', path.join(dir, PATCH));
    expect(run('--set-aside').status).toBe(0);
    expect(lstatSync(path.join(dir, PATCH)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(dir, PATCH))).toBe('real.patch');
  });
});
