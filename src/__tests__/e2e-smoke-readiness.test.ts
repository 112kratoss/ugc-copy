// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRoot = process.cwd();
const PLACEHOLDER_PROJECT = 'https://example.supabase.co';

function read(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/** The variables .env.example lists, commented out or not. */
function appEnvNames() {
  return [...read('.env.example').matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map(([, name]) => name);
}

/** The names the app's own code reads as `process.env.NAME` or `process.env['NAME']`, comment lines left out. */
function namesTheAppReads() {
  const sources = fs.readdirSync(path.join(repoRoot, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file) && !file.startsWith(`__tests__${path.sep}`))
    .map((file) => path.join('src', file))
    .concat('next.config.ts');
  const names = new Set<string>();
  for (const file of sources) {
    const code = read(file).split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n');
    for (const match of code.matchAll(/process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])/g)) {
      names.add(match[1] ?? match[2]);
    }
  }
  return [...names].sort();
}

// Read by the app but not its configuration: Next sets the first three and the CI runner sets CI, so
// they pass through; the config sets the bypass flags itself.
const SET_BY_THE_RUNTIME = ['NODE_ENV', 'NEXT_RUNTIME', 'NEXT_PHASE', 'CI'];
const SET_BY_THE_CONFIG = ['E2E_AUTH_BYPASS', 'NEXT_PUBLIC_E2E_AUTH_BYPASS'];

/**
 * playwright.config.ts as Playwright reads it under the shell env given, and the env its dev server
 * starts with: Playwright spreads its own process.env under webServer.env, and Node's spawn leaves out
 * a variable whose value is undefined (node_modules/playwright/lib/plugins/webServerPlugin.js).
 */
async function loadConfig(shell: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(shell)) vi.stubEnv(key, value);
  vi.resetModules();
  const { default: config } = await import('../../playwright.config');
  const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
  expect(server).toBeDefined();
  const merged: Record<string, string | undefined> = { ...process.env, ...server!.env };
  const serverEnv = Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { config, server: server!, serverEnv };
}

/** Runs `script` in a fresh node with only PATH and NODE_ENV as `next dev` sets it, and parses what it prints. */
function runNode(args: string[], script: string, env: Record<string, string> = {}) {
  const child = spawnSync(process.execPath, [...args, '-e', script], {
    env: { PATH: process.env.PATH, NODE_ENV: 'development', ...env },
    encoding: 'utf8',
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as unknown;
}

// A failed Quality run on main skips the production release without a word, so
// the E2E job has to fail only for a reason in the code. The local gate's --e2e
// runs the same config, so a run anywhere is the job's run.
describe('E2E smoke job', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Two pages open on one `next dev` reload each other (the third gotcha in
  // .claude/rules/e2e.md): with two workers every cold run reloaded a page under a test.
  it.each(['', 'true'])('runs the suite on one worker (CI=%j)', async (ci) => {
    const { config } = await loadConfig({ CI: ci });

    expect(config.workers).toBe(1);
  });

  // A server already on the port could have any project and any keys; a data cache the checkout's own
  // `next dev` filled can hold a real project's data under keys that do not name the project.
  it.each(['', 'true'])('starts a dev server of its own, on an empty data cache (CI=%j)', async (ci) => {
    const { server } = await loadConfig({ CI: ci });

    expect(server.reuseExistingServer).toBe(false);
    expect(server.command).toMatch(/^rm -rf \.next\/dev\/cache\/fetch-cache && npm run dev -- /);
  });

  // So that no E2E server starts against a real project or with real keys, whatever a shell exports:
  // every variable the server gets that the shell set otherwise is the config's own, and Next takes a
  // variable in the server's env over any .env file (the load order in its environment-variables guide).
  it('gives the dev server the placeholder project and keys, and no app variable of the shell', async () => {
    const config = read('playwright.config.ts');
    // NODE_OPTIONS is the one the server keeps from the shell, with the preload added (the next test).
    const configKeys = [...config.matchAll(/^ {2,6}([A-Z][A-Z0-9_]*): /gm)].map(([, key]) => key)
      .filter((key) => key !== 'NODE_OPTIONS');
    const shell = Object.fromEntries(
      [...new Set([...appEnvNames(), ...namesTheAppReads(), ...configKeys])]
        .filter((name) => !SET_BY_THE_RUNTIME.includes(name))
        .map((name) => [name, `from-the-shell-${name}`]),
    );
    const { serverEnv } = await loadConfig(shell);
    const fromTheShell = Object.keys(serverEnv).filter((key) => serverEnv[key]?.startsWith('from-the-shell-'));
    const setByTheConfig = Object.keys(serverEnv)
      .filter((key) => key !== 'NODE_OPTIONS' && serverEnv[key] !== process.env[key])
      .map((key) => `${key}=${serverEnv[key]}`);

    expect(configKeys).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(fromTheShell).toEqual([]);
    expect(serverEnv.NEXT_PUBLIC_SUPABASE_URL).toBe(PLACEHOLDER_PROJECT);
    for (const entry of setByTheConfig) {
      expect(entry).toMatch(/^[A-Z0-9_]+=(ci-placeholder-[a-z-]+|1|http:\/\/127\.0\.0\.1:3100|https:\/\/example\.supabase\.co)$/);
    }
  });

  // The config unsets every name .env.example lists, so a name the app reads that it does not list
  // would still reach the dev server from a shell that exports it.
  it('lists every variable the app reads in .env.example', () => {
    const listed = new Set(appEnvNames());

    expect(namesTheAppReads().length).toBeGreaterThan(40);
    expect(namesTheAppReads().filter((name) => !listed.has(name)
      && !SET_BY_THE_RUNTIME.includes(name) && !SET_BY_THE_CONFIG.includes(name))).toEqual([]);
  });

  // `next dev` keeps only the last --require of NODE_OPTIONS for its server process, so the config's
  // preload goes last, and the preload brings in both the .env guard and the Supabase stub.
  it('preloads the .env guard and the Supabase stub into the dev server', async () => {
    const preload = path.join(repoRoot, 'tests/e2e/support/dev-server.cjs');
    const { serverEnv } = await loadConfig({ NODE_OPTIONS: '--max-old-space-size=4096' });

    expect(serverEnv.NODE_OPTIONS).toBe(`--max-old-space-size=4096 --require=${JSON.stringify(preload)}`);
    expect(runNode(['--require', preload], 'console.log(JSON.stringify([globalThis.__e2eNoEnvFiles, globalThis.__e2eSupabaseServerStub]))'))
      .toEqual([true, true]);
  });

  // CI's checkout has no .env file; a laptop's often has one pointing at a real project (the primary
  // checkout's .env.local points at production), and Next applies every key in it that the server's env
  // leaves unset, at start and again on every forced env reload (an env file saved, a route added or
  // removed). This runs Next's own loader on a checkout of the four files `next dev` reads, at start and
  // on a forced reload: without the guard all four are applied (so a zero below means something), with
  // it none.
  it('keeps a checkout\'s .env files from the dev server, at start and on a reload', () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-env-files-'));
    const files = ['.env.development.local', '.env.local', '.env.development', '.env'];
    files.forEach((file, index) => fs.writeFileSync(path.join(checkout, file), `E2E_ENV_FILE_${index}=read\n`));
    // The guard hides the files at the root of the checkout it sits in.
    const guard = path.join(checkout, 'tests/e2e/support/no-env-files.cjs');
    fs.mkdirSync(path.dirname(guard), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'tests/e2e/support/no-env-files.cjs'), guard);
    // @next/env as `next dev` resolves it.
    const fromRoot = createRequire(path.join(repoRoot, 'package.json'));
    const nextEnv = createRequire(fromRoot.resolve('next/package.json')).resolve('@next/env');
    // The project directory as `next dev` resolves it (realpathSync.native, next/dist/lib/realpath.js).
    const script = `
      const { loadEnvConfig } = require(${JSON.stringify(nextEnv)});
      const dir = require('node:fs').realpathSync.native(${JSON.stringify(checkout)});
      const quiet = { info() {}, warn() {}, error() {} };
      const applied = () => ${JSON.stringify(files)}.map((file, index) => process.env['E2E_ENV_FILE_' + index] ?? null);
      loadEnvConfig(dir, true, quiet);
      const atStart = applied();
      loadEnvConfig(dir, true, quiet, true);
      console.log(JSON.stringify({ atStart, afterReload: applied() }));
    `;
    const none = { atStart: [null, null, null, null], afterReload: [null, null, null, null] };
    // The guard required by a path in another case, as a config reached that way would require it.
    const recased = guard.replace('e2e-env-files-', 'E2E-ENV-FILES-');

    try {
      expect(runNode([], script)).toEqual({ atStart: ['read', 'read', 'read', 'read'], afterReload: ['read', 'read', 'read', 'read'] });
      expect(runNode(['--require', guard], script)).toEqual(none);
      // Only a case-insensitive disk (macOS's default) has that path.
      if (fs.existsSync(recased)) expect(runNode(['--require', recased], script)).toEqual(none);
    } finally {
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  });

  it('keeps the trace of a failed test after the runner is gone', async () => {
    const { config } = await loadConfig();
    const workflow = read('.github/workflows/quality.yml');
    const run = workflow.indexOf('run: npm run test:e2e');
    const start = workflow.indexOf('- name: Upload the traces of failed tests');
    // The step, up to the job that follows it.
    const upload = workflow.slice(start, workflow.indexOf('\n  mobile:', start));

    expect(config.use?.trace).toBe('retain-on-failure');
    expect(run).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(run);
    expect(upload).toContain('if: ${{ failure() }}');
    expect(upload).toContain('path: test-results/');
    // A second attempt of the same run must not collide with the first one's upload.
    expect(upload).toContain('name: e2e-test-results-attempt-${{ github.run_attempt }}');
  });

  // The dev server answers the server-side Supabase reads of the pages specs draw (the creator
  // page) from a stub it loads, which answers only one host: pointed at any other, it answers
  // nothing, and those pages draw their error state again.
  it('answers the server\'s Supabase reads on the project the config points the app at', async () => {
    const { serverEnv } = await loadConfig();

    expect(read('tests/e2e/support/supabase-server-stub.cjs')).toContain(`const HOST = '${new URL(PLACEHOLDER_PROJECT).host}';`);
    expect(serverEnv.NEXT_PUBLIC_SUPABASE_URL).toBe(PLACEHOLDER_PROJECT);
  });
});
