// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRoot = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/** The env of the E2E job's "Run E2E smoke tests" step in quality.yml, key by key. */
function jobEnv(): Record<string, string> {
  const workflow = read('.github/workflows/quality.yml');
  const step = workflow.slice(
    workflow.indexOf('- name: Run E2E smoke tests'),
    workflow.indexOf('- name: Upload the traces of failed tests'),
  );
  const block = step.slice(step.indexOf('env:'));
  return Object.fromEntries(
    [...block.matchAll(/^ {10}([A-Z0-9_]+): (.+)$/gm)].map(([, key, value]) => [key, value.trim().replace(/^"(.*)"$/, '$1')]),
  );
}

/** playwright.config.ts as Playwright reads it under the shell env given. */
async function loadConfig(shell: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(shell)) vi.stubEnv(key, value);
  vi.resetModules();
  const { default: config } = await import('../../playwright.config');
  const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
  expect(server).toBeDefined();
  return { config, server: server!, serverEnv: server!.env ?? {} };
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
  it('runs the suite on one worker, in CI and out of it', async () => {
    const { config } = await loadConfig({ CI: '' });

    expect(config.workers).toBe(1);
  });

  // A server already on the port could have any project and any keys.
  it('starts a dev server of its own', async () => {
    const { server } = await loadConfig({ CI: '' });

    expect(server.reuseExistingServer).toBe(false);
  });

  // So that no E2E server starts against a real project, whatever a shell exports: Next takes a
  // variable the server's env sets over any .env file (the load order in its environment-variables
  // guide). The project is a host with no DNS record.
  it('gives the dev server the job\'s env over the shell\'s', async () => {
    const job = jobEnv();
    const { serverEnv } = await loadConfig(
      Object.fromEntries(Object.keys(job).map((key) => [key, `from-the-shell-${key}`])),
    );
    const setByTheConfig = Object.keys(serverEnv).filter((key) => serverEnv[key] !== process.env[key]);

    expect(job.NEXT_PUBLIC_SUPABASE_URL).toBe('https://example.supabase.co');
    for (const [key, value] of Object.entries(job)) expect(serverEnv[key], key).toBe(value);
    // The job's keys and the config's own four, nothing else.
    expect(setByTheConfig.sort()).toEqual(
      [...Object.keys(job), '__NEXT_PROCESSED_ENV', 'E2E_AUTH_BYPASS', 'NEXT_PUBLIC_E2E_AUTH_BYPASS', 'NODE_OPTIONS'].sort(),
    );
  });

  // CI's checkout has no .env file; the primary checkout's .env.local points at production, and Next
  // would add every variable in it that the server's env leaves unset. No Next doc promises that
  // __NEXT_PROCESSED_ENV stops it, so this runs Next's own loader on a folder with the four files
  // `next dev` reads, without the flag (all four read, so a zero below means something) and with it.
  it('keeps a checkout\'s .env files from the dev server', async () => {
    const { serverEnv } = await loadConfig();
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-env-files-'));
    const files = ['.env.development.local', '.env.local', '.env.development', '.env'];
    files.forEach((file, index) => fs.writeFileSync(path.join(folder, file), `E2E_ENV_FILE_${index}=read\n`));
    // @next/env as `next dev` resolves it.
    const fromRoot = createRequire(path.join(repoRoot, 'package.json'));
    const nextEnv = createRequire(fromRoot.resolve('next/package.json')).resolve('@next/env');
    const script = `
      const { loadEnvConfig } = require(${JSON.stringify(nextEnv)});
      loadEnvConfig(${JSON.stringify(folder)}, true, { info() {}, warn() {}, error() {} });
      console.log(JSON.stringify(${JSON.stringify(files)}.map((file, index) => process.env['E2E_ENV_FILE_' + index] ?? null)));
    `;
    // NODE_ENV as `next dev` sets it: vitest's `test` would make Next skip .env.local by itself.
    const applied = (env: Record<string, string | undefined>) => {
      const child = spawnSync(process.execPath, ['-e', script], {
        env: { PATH: process.env.PATH, NODE_ENV: 'development', ...env },
        encoding: 'utf8',
      });
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout) as (string | null)[];
    };

    try {
      expect(serverEnv.__NEXT_PROCESSED_ENV).toBeDefined();
      expect(applied({})).toEqual(['read', 'read', 'read', 'read']);
      expect(applied({ __NEXT_PROCESSED_ENV: serverEnv.__NEXT_PROCESSED_ENV })).toEqual([null, null, null, null]);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('keeps the trace of a failed test after the runner is gone', () => {
    const workflow = read('.github/workflows/quality.yml');
    const run = workflow.indexOf('run: npm run test:e2e');
    const start = workflow.indexOf('- name: Upload the traces of failed tests');
    // The step, up to the job that follows it.
    const upload = workflow.slice(start, workflow.indexOf('\n  mobile:', start));

    expect(read('playwright.config.ts')).toContain("trace: 'retain-on-failure'");
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
  it('answers the server\'s Supabase reads on the project the job points the app at', () => {
    const projectUrl = jobEnv().NEXT_PUBLIC_SUPABASE_URL;
    const config = read('playwright.config.ts');

    expect(projectUrl).toBeDefined();
    expect(read('tests/e2e/support/supabase-server-stub.cjs')).toContain(`const HOST = '${new URL(projectUrl).host}';`);
    expect(config).toContain("'tests/e2e/support/supabase-server-stub.cjs'");
    expect(config).toContain('NODE_OPTIONS: [process.env.NODE_OPTIONS, SUPABASE_SERVER_STUB]');
  });
});
