import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  // One worker in CI, so that only one page is open at a time. `next dev` sends its
  // "sync" message to every open page whenever any page connects, and a page reloads
  // itself when that message names a build other than the one it loaded. With two
  // workers, one worker's test compiling a route and then opening a page reloads the
  // page under the other worker's test, and whatever that test had typed is gone
  // (the third E2E gotcha in AGENTS.md).
  workers: process.env.CI ? 1 : undefined,
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
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      E2E_AUTH_BYPASS: '1',
      NEXT_PUBLIC_E2E_AUTH_BYPASS: '1',
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
