// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// The local gate stands in for CI before every merge, and agents run it from worktrees. Started from the folder
// above the repo it ran vitest there (2026-10-23), and its --build failed in every worktree, which has no
// .env.local, while CI's Build step sets placeholders. These tests run copies of it in throwaway checkouts with
// npm, npx and pgrep stubbed, so nothing in them builds or tests anything.

const repoRoot = process.cwd();
const GATE = '.agents/skills/local-checks/scripts/run.sh';
const GUARD = 'tests/e2e/support/no-env-files.cjs';
const fromNext = createRequire(createRequire(path.join(repoRoot, 'package.json')).resolve('next/package.json'));
const SLOW = { timeout: 30_000 };

function read(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/** The variables .env.example lists, commented out or not. */
function appEnvNames() {
  return [...read('.env.example').matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map(([, name]) => name);
}

/**
 * The env of the web job's Build step in quality.yml, read as YAML reads the block under its `env:`: the lines
 * indented past it, blank and comment lines skipped, quotes and trailing comments taken off the values.
 */
function ciBuildEnv() {
  const steps = read('.github/workflows/quality.yml').split(/\n(?= *- name: )/);
  const build = steps.filter((step) => /^ *- name: Build *$/.test(step.split('\n', 1)[0]));
  expect(build).toHaveLength(1);
  expect(build[0]).toMatch(/^ +run: npm run build$/m);
  const lines = build[0].split('\n');
  const at = lines.findIndex((line) => /^ +env: *$/.test(line));
  expect(at).toBeGreaterThan(0);
  const env: Record<string, string> = {};
  for (const line of lines.slice(at + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (line.search(/\S/) <= lines[at].search(/\S/)) break;
    const [, name = '', raw = ''] = /^\s+(\S+?):\s*(.*?)\s*$/.exec(line) ?? [];
    expect(name, line).toMatch(/^[A-Z][A-Z0-9_]*$/);
    env[name] = /^["']/.test(raw) ? raw.slice(1, raw.indexOf(raw[0], 1)) : raw.replace(/\s+#.*$/, '');
  }
  return env;
}

const made: string[] = [];

/** A folder of its own by its real path, as git prints it, with a space in it as the primary checkout's has. */
function tempDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local checks-')));
  made.push(dir);
  return dir;
}

/** The test's env without git's own variables (a hook running the suite sets them) or a stale PWD. */
function shellEnv(extra: Record<string, string> = {}) {
  const env = Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && !/^(GIT_|PWD$|OLDPWD$)/.test(entry[0]));
  return { ...Object.fromEntries(env), ...extra } as unknown as NodeJS.ProcessEnv;
}

/** git with a throwaway identity, and none of a laptop's commit signing or hooks. */
function git(cwd: string, ...args: string[]) {
  const config = ['user.name=gate', 'user.email=gate@example.com', 'commit.gpgsign=false', 'core.hooksPath=/dev/null'];
  const result = spawnSync('git', [...config.flatMap((entry) => ['-c', entry]), ...args], {
    cwd,
    env: shellEnv(),
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
}

// Each npm or npx call writes what it was asked, where, with which env, and which preloads NODE_OPTIONS loaded
// into it (the .env guard, or the one a test's shell names), then succeeds without doing anything.
const RECORD_CALL = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.GATE_CALLS, process.hrtime.bigint() + '.json'), JSON.stringify({
  command: [path.basename(process.argv[1]), ...process.argv.slice(2)].join(' '),
  cwd: process.cwd(),
  env: process.env,
  guard: globalThis.__e2eNoEnvFiles === true,
  shellPreload: globalThis.__shellPreload === true,
}));
`;

type Call = { command: string; cwd: string; env: Record<string, string>; guard: boolean; shellPreload: boolean };

/** A git checkout holding the gate and the files it reads, beside a folder of stubs (pgrep finds no next dev). */
function setUp(workflow = read('.github/workflows/quality.yml')) {
  const dir = tempDir();
  const checkout = path.join(dir, 'checkout');
  const files: Record<string, string> = {
    [GATE]: read(GATE),
    '.github/workflows/quality.yml': workflow,
    '.env.example': read('.env.example'),
    [GUARD]: read(GUARD),
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    fs.writeFileSync(path.join(checkout, file), text);
  }
  git(checkout, 'init', '-q');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-qm', 'gate');
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls');
  fs.mkdirSync(bin);
  fs.mkdirSync(calls);
  for (const name of ['npm', 'npx']) fs.writeFileSync(path.join(bin, name), RECORD_CALL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return { dir, checkout, bin, calls };
}

/** Runs a copy of the gate from `cwd` under the Mac's bash (3.2), with the stubs first on PATH. */
function runGate(
  cwd: string,
  gate: string,
  args: string[],
  { bin, calls }: { bin: string; calls: string },
  env: Record<string, string> = {},
) {
  const result = spawnSync('/bin/bash', [gate, ...args], {
    cwd,
    encoding: 'utf8',
    env: shellEnv({
      ...env,
      GATE_CALLS: calls,
      PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    }),
  });
  const recorded = fs.readdirSync(calls)
    .map((file) => BigInt(path.basename(file, '.json')))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((time) => JSON.parse(fs.readFileSync(path.join(calls, `${time}.json`), 'utf8')) as Call);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: recorded };
}

/** Runs `script` in a fresh node with only PATH and the env given, and parses what it prints. */
function runNode(script: string, env: Record<string, string> = {}) {
  const child = spawnSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as unknown;
}

describe('the local gate', () => {
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to start from a folder in no checkout, and runs nothing', SLOW, () => {
    const setup = setUp();
    const outside = path.join(setup.dir, 'outside');
    const out = path.join(setup.dir, 'out');
    fs.mkdirSync(outside);
    expect(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: outside, env: shellEnv() }).status).not.toBe(0);

    const gate = runGate(outside, path.join(setup.checkout, GATE), ['--out', out], setup);

    expect(gate.status).toBe(2);
    expect(gate.stderr).toContain(`refused, nothing run: ${outside} is in no git checkout.`);
    expect(gate.stderr).toContain(`(cd "${setup.checkout}" && .agents/skills/local-checks/scripts/run.sh --out ${out})`);
    expect(gate.calls).toEqual([]);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  // A worktree's copy started from the primary checkout would have checked the primary checkout.
  it('refuses to start from a checkout other than its own, and runs nothing', SLOW, () => {
    const setup = setUp();
    const other = path.join(setup.dir, 'other');
    fs.mkdirSync(other);
    git(other, 'init', '-q');

    const gate = runGate(other, path.join(setup.checkout, GATE), ['--web-only'], setup);

    expect(gate.status).toBe(2);
    expect(gate.stderr)
      .toContain(`refused, nothing run: this copy checks ${setup.checkout}, and the current directory is in ${other}.`);
    // Either may be the one meant, so it names both rather than steer to one.
    expect(gate.stderr).toContain(`(cd "${other}" && .agents/skills/local-checks/scripts/run.sh --web-only)   # the current directory's checkout`);
    expect(gate.stderr).toContain(`(cd "${setup.checkout}" && .agents/skills/local-checks/scripts/run.sh --web-only)   # this copy's checkout`);
    expect(gate.calls).toEqual([]);
  });

  // The refusals above would pass for a gate that never runs anything. A git hook exports GIT_DIR, which makes
  // --show-toplevel answer the folder it is asked from.
  it.each([
    { from: '.', hook: false },
    { from: 'src/lib', hook: false },
    { from: '.', hook: true },
  ])('runs every step at the root of its own checkout, started from $from in it (from a git hook: $hook)', SLOW, ({ from, hook }) => {
    const setup = setUp();
    const cwd = path.join(setup.checkout, from);
    fs.mkdirSync(cwd, { recursive: true });

    const gate = runGate(
      cwd,
      path.join(setup.checkout, GATE),
      ['--web-only', '--out', path.join(setup.dir, 'out')],
      setup,
      hook ? { GIT_DIR: path.join(setup.checkout, '.git') } : {},
    );

    expect(gate.status, gate.stdout + gate.stderr).toBe(0);
    expect(gate.stdout).toMatch(/^== ALL GREEN/m);
    // Quality's four media audits follow its tests; two read /proc and assert Linux, so a Mac runs the other two.
    const linuxOnly = (file: string) => (process.platform === 'linux' ? [`npx tsx --tsconfig tsconfig.scripts.json scripts/audits/${file}`] : []);
    expect(gate.calls.map((call) => call.command)).toEqual([
      'npx vitest run --reporter=dot --silent=passed-only',
      'npx tsx --tsconfig tsconfig.scripts.json scripts/audits/audit-video-poster-owner-lifetime.ts --verify-reader-lease',
      ...linuxOnly('audit-media-scratch-lifetime.ts'),
      'npx tsx --tsconfig tsconfig.scripts.json scripts/audits/audit-media-output-limits.ts',
      ...linuxOnly('audit-staging-admission.ts'),
      'npm run lint',
      'npm run typecheck',
      'npm run typecheck:scripts',
      'npm run typecheck:tests',
      'npm run perf:load:self-test',
      'npm run perf:lighthouse:self-test',
    ]);
    expect(gate.calls.map((call) => call.cwd)).toEqual(gate.calls.map(() => setup.checkout));
  });

  it('runs the mobile job in ugc-mobile, the release-env self-test first, as Quality does', SLOW, () => {
    const setup = setUp();
    fs.mkdirSync(path.join(setup.checkout, 'ugc-mobile'));

    const gate = runGate(setup.checkout, path.join(setup.checkout, GATE), ['--mobile-only', '--out', path.join(setup.dir, 'out')], setup);

    expect(gate.status, gate.stdout + gate.stderr).toBe(0);
    expect(gate.calls.map((call) => call.command)).toEqual(['npm run release-env:self-test', 'npm test', 'npm run typecheck']);
    expect(gate.calls.map((call) => call.cwd)).toEqual(gate.calls.map(() => path.join(setup.checkout, 'ugc-mobile')));
  });

  // CI builds with the Build step's env on a runner that has no other variable of the app and no .env file. A
  // worktree has no .env.local, so without the step's placeholders prerendering fails; the primary checkout's can
  // point at production.
  it('builds with the env of quality.yml\'s Build step and none of the app\'s variables from the shell', SLOW, () => {
    const setup = setUp();
    const ci = ciBuildEnv();
    // The E2E bypass flags are kept out of .env.example (e2e-smoke-readiness.test.ts), and a production build
    // refuses them.
    const shell = Object.fromEntries([...appEnvNames(), ...Object.keys(ci), 'E2E_AUTH_BYPASS', 'NEXT_PUBLIC_E2E_AUTH_BYPASS']
      .map((name) => [name, `from-the-shell-${name}`]));
    // A preload of the shell's, in the form Next's worker rebuild glues onto the guard's path.
    const preload = path.join(setup.dir, 'shell-preload.cjs');
    fs.writeFileSync(preload, 'globalThis.__shellPreload = true;\n');
    fs.mkdirSync(path.join(setup.checkout, '.next/cache/fetch-cache'), { recursive: true });
    fs.mkdirSync(path.join(setup.checkout, '.next/cache/images'), { recursive: true });

    const gate = runGate(
      setup.checkout,
      path.join(setup.checkout, GATE),
      ['--web-only', '--build', '--out', path.join(setup.dir, 'out')],
      setup,
      {
        ...shell,
        // `next build` keeps a NODE_ENV it inherits; CI's runner sets none.
        NODE_ENV: 'development',
        NODE_OPTIONS: `--max-old-space-size=4096 --require ${JSON.stringify(preload)}`,
        // npm hands its scripts this setting as their NODE_OPTIONS, from the env or any npmrc.
        npm_config_node_options: 'from-the-shell-npm_config_node_options',
        NPM_CONFIG_NODE_OPTIONS: 'from-the-shell-NPM_CONFIG_NODE_OPTIONS',
      },
    );
    const builds = gate.calls.filter((call) => /^npm run build(:verify)?$/.test(call.command));
    const guardOnly = `--require=${JSON.stringify(path.join(setup.checkout, GUARD))}`;

    expect(gate.status, gate.stdout + gate.stderr).toBe(0);
    expect(builds.map((call) => call.command)).toEqual(['npm run build', 'npm run build:verify']);
    // The steps before them get the shell's env as it is, so a value from the shell is seen where it arrives.
    expect(gate.calls[0].env.NEXT_PUBLIC_SUPABASE_URL).toBe('from-the-shell-NEXT_PUBLIC_SUPABASE_URL');
    expect(gate.calls[0].env.NODE_ENV).toBe('development');
    expect(gate.calls[0].shellPreload).toBe(true);
    for (const build of builds) {
      expect(Object.fromEntries(Object.keys(ci).map((name) => [name, build.env[name]]))).toEqual(ci);
      expect(Object.entries(build.env).filter(([, value]) => value.startsWith('from-the-shell-'))).toEqual([]);
      expect(build.env.NODE_ENV).toBeUndefined();
      // The guard alone, quoted as a checkout's path can hold a space (this one's does), and loaded by node.
      expect(build.env.NODE_OPTIONS).toBe(guardOnly);
      expect(build.env.npm_config_node_options).toBe(guardOnly);
      expect(build.guard).toBe(true);
      expect(build.shellPreload).toBe(false);
    }
    // CI's checkout has no .next; earlier builds keep unstable_cache entries here under keys that do not name
    // the project.
    expect(fs.existsSync(path.join(setup.checkout, '.next/cache/fetch-cache'))).toBe(false);
    expect(fs.existsSync(path.join(setup.checkout, '.next/cache/images'))).toBe(true);
  });

  it('refuses to build when it reads no env from the Build step, rather than build with the shell\'s', SLOW, () => {
    const setup = setUp(['jobs:', '  web:', '    steps:', '      - name: Build', '        run: npm run build', ''].join('\n'));

    const gate = runGate(
      setup.checkout,
      path.join(setup.checkout, GATE),
      ['--web-only', '--build', '--out', path.join(setup.dir, 'out')],
      setup,
    );

    expect(gate.status).toBe(1);
    expect(gate.stdout).toContain('build              refused: no env read from the Build step of .github/workflows/quality.yml');
    expect(gate.calls.map((call) => call.command)).not.toContain('npm run build');
  });

  // The gate builds with the step's own values as written. A secret or an expression has a value only on the
  // runner, and an env of the web job or of the whole workflow would reach CI's build but not the gate's.
  it('reads all the env CI\'s Build step gets, every value written out in the workflow', () => {
    const workflow = read('.github/workflows/quality.yml');
    const start = workflow.indexOf('\n  web:\n');
    const next = workflow.slice(start + 1).search(/\n {2}[\w-]+:\n/);
    const job = workflow.slice(start, next === -1 ? undefined : start + 1 + next);
    const ci = ciBuildEnv();

    expect(ci.NEXT_PUBLIC_SUPABASE_URL).toBe('https://example.supabase.co');
    expect(Object.values(ci).filter((value) => value.includes('${{'))).toEqual([]);
    expect(job).toContain('\n      - name: Build\n');
    expect(job).not.toMatch(/^ {4}env:/m);
    expect(workflow).not.toMatch(/^env:/m);
  });

  // The gate keeps .env files from the build with the E2E server's guard, loaded as it loads it: through
  // NODE_OPTIONS, quoted, from a path with a space. Next's own loader, in a build's mode, applies all four files
  // of a checkout without the guard (so a zero below means something) and none with it; Sentry's bundler plugin
  // reads its token file directly. .env.example, which CI's checkout has too, stays readable.
  it('keeps a checkout\'s .env files from the build', () => {
    const checkout = tempDir();
    const files = ['.env.production.local', '.env.local', '.env.production', '.env'];
    files.forEach((file, index) => fs.writeFileSync(path.join(checkout, file), `BUILD_ENV_FILE_${index}=read\n`));
    fs.writeFileSync(path.join(checkout, '.env.sentry-build-plugin'), 'SENTRY_AUTH_TOKEN=read\n');
    fs.writeFileSync(path.join(checkout, '.env.example'), 'NEXT_PUBLIC_SUPABASE_URL=\n');
    fs.mkdirSync(path.dirname(path.join(checkout, GUARD)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, GUARD), path.join(checkout, GUARD));
    const script = `
      const fs = require('node:fs');
      const { loadEnvConfig } = require(${JSON.stringify(fromNext.resolve('@next/env'))});
      loadEnvConfig(${JSON.stringify(checkout)}, false, { info() {}, warn() {}, error() {} });
      const readable = (file) => { try { return fs.readFileSync(${JSON.stringify(checkout)} + '/' + file, 'utf8') !== ''; } catch { return false; } };
      console.log(JSON.stringify({
        applied: ${JSON.stringify(files)}.map((file, index) => process.env['BUILD_ENV_FILE_' + index] ?? null),
        sentryToken: readable('.env.sentry-build-plugin'),
        example: readable('.env.example'),
      }));
    `;

    expect(runNode(script, { NODE_ENV: 'production' }))
      .toEqual({ applied: ['read', 'read', 'read', 'read'], sentryToken: true, example: true });
    expect(runNode(script, { NODE_ENV: 'production', NODE_OPTIONS: `--require=${JSON.stringify(path.join(checkout, GUARD))}` }))
      .toEqual({ applied: [null, null, null, null], sentryToken: false, example: true });
  });

  // A build's workers read the env files again (the main process found none, so nothing marks the env as
  // processed). Next starts them with NODE_OPTIONS rebuilt from its own (next/dist/lib/worker.js), which has to
  // keep the gate's, the guard alone, quoted.
  it('hands the guard on to the build\'s workers', () => {
    const dir = tempDir();
    const guard = path.join(dir, GUARD);
    fs.mkdirSync(path.dirname(guard), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, GUARD), guard);
    const nodeOptions = `--require=${JSON.stringify(guard)}`;
    // A file, not `node -e`: Next folds node's own arguments (execArgv) in too.
    const script = path.join(dir, 'worker-node-options.cjs');
    fs.writeFileSync(script, `
      const { formatNodeOptions, getParsedNodeOptions } = require(${JSON.stringify(fromNext.resolve('next/dist/server/lib/utils.js'))});
      console.log(JSON.stringify(formatNodeOptions(getParsedNodeOptions()).nodeOptions));
    `);
    const child = spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: nodeOptions } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toBe(nodeOptions);
  });
});
