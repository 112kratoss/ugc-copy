import fs from 'node:fs';
import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// The project and keys of every E2E run, CI's E2E job included (it sets none of its own): a
// placeholder project with no DNS record, whose server reads the specs need the stub below answers,
// and keys that open nothing.
const PLACEHOLDER_ENV = {
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_SITE_URL: BASE_URL,
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

// Every variable the app reads is listed in .env.example. The dev server gets none of them from the
// shell, as on CI's runner, only the ones above: a shell that exported a real project or real keys
// reaches nothing. Playwright spreads its own process.env under webServer.env, so each name is set to
// undefined there, which Node's spawn leaves out of the server's env.
const UNSET_APP_ENV = Object.fromEntries(
  [...fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8').matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)]
    .map(([, name]) => [name, undefined]),
) as unknown as Record<string, string>;

// Loaded into the dev server: it keeps the checkout's .env files from Next
// (tests/e2e/support/no-env-files.cjs) and answers the Supabase reads of the pages specs draw whose
// server render reads them, which Playwright's routes cannot reach (supabase-server-stub.cjs). Quoted,
// as a checkout's path can hold a space; `next dev` hands its server process only the last --require
// it was given, so this one goes last.
const DEV_SERVER_PRELOAD = `--require=${JSON.stringify(path.join(__dirname, 'tests/e2e/support/dev-server.cjs'))}`;

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
    // Starts from an empty data cache, as CI's checkout does. The checkout's own `next dev` keeps
    // unstable_cache entries in .next/dev/cache/fetch-cache under keys that do not name the project
    // (the primary checkout's hold production's feed), and Next serves such an entry stale when its
    // refresh fails, which every refresh against the placeholder does.
    command: `rm -rf .next/dev/cache/fetch-cache && npm run dev -- --hostname 127.0.0.1 --port ${PORT}`,
    url: BASE_URL,
    // Always a server of its own, as in CI: one already on the port could have any project
    // and any keys, and the specs would run against it.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...UNSET_APP_ENV,
      ...PLACEHOLDER_ENV,
      E2E_AUTH_BYPASS: '1',
      NEXT_PUBLIC_E2E_AUTH_BYPASS: '1',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, DEV_SERVER_PRELOAD].filter(Boolean).join(' '),
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
