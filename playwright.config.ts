import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// The E2E job's env (.github/workflows/quality.yml, "Run E2E smoke tests"), given to the dev server
// over the shell's, so that a run anywhere gets the job's placeholder project and keys and no shell
// can point the server at a real project. The project has no DNS record; the stub below answers the
// server reads specs need. e2e-smoke-readiness.test.ts keeps this copy equal to the job's.
const E2E_JOB_ENV = {
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3100',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'ci-placeholder-anon-key',
  NEXT_PUBLIC_RAZORPAY_KEY_ID: 'ci-placeholder-razorpay-key',
  SUPABASE_SERVICE_ROLE_KEY: 'ci-placeholder-service-role-key',
  KIE_AI_API_KEY: 'ci-placeholder-kie-key',
  WEBHOOK_SECRET: 'ci-placeholder-webhook-secret',
  CRON_SECRET: 'ci-placeholder-cron-secret',
  RAZORPAY_KEY_SECRET: 'ci-placeholder-razorpay-secret',
  RAZORPAY_WEBHOOK_SECRET: 'ci-placeholder-razorpay-webhook-secret',
  REVENUECAT_REST_API_KEY: 'ci-placeholder-revenuecat-key',
  REVENUECAT_WEBHOOK_AUTH_TOKEN: 'ci-placeholder-revenuecat-webhook-token',
};

// Loaded into the dev server, where it answers the Supabase reads of the pages specs draw whose
// server render reads them (the creator page): Playwright's routes reach only the browser. The
// file says which reads, and why every other request goes on as before. Quoted, as a checkout's
// path can hold a space; `next dev` hands its server process only the last --require it was
// given, so this one goes last.
const SUPABASE_SERVER_STUB = `--require=${JSON.stringify(path.join(__dirname, 'tests/e2e/support/supabase-server-stub.cjs'))}`;

export default defineConfig({
  testDir: './tests/e2e',
  // One worker, as in CI, so that only one page is open at a time. `next dev` sends its
  // "sync" message to every open page whenever any page connects, and a page reloads
  // itself when that message names a build other than the one its previous "sync"
  // named. With two workers, one worker's test compiling a route and then opening a
  // page reloads the page under the other worker's test, and whatever that test had
  // typed is gone (the third gotcha in .claude/rules/e2e.md). `--workers` still overrides it.
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${PORT}`,
    url: BASE_URL,
    // Always a server of its own, as in CI: one already on the port could have any project
    // and any keys, and the specs would run against it.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      ...E2E_JOB_ENV,
      // Next reads this as "the .env files are applied already" (processEnv in @next/env) and
      // applies none, as in CI, whose checkout has none: a checkout's .env.local (the primary
      // checkout's points at production) never reaches this server. Not a documented switch, so
      // e2e-smoke-readiness.test.ts checks this Next still honours it. An env file changed during
      // a run is applied after all (Next's forceReload ignores the flag), but only to keys this env
      // leaves unset: the project and its keys stay the placeholder's.
      __NEXT_PROCESSED_ENV: 'true',
      E2E_AUTH_BYPASS: '1',
      NEXT_PUBLIC_E2E_AUTH_BYPASS: '1',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, SUPABASE_SERVER_STUB].filter(Boolean).join(' '),
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
