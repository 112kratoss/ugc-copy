import { expect, test } from '@playwright/test';

/**
 * The consent page's gate, offline (.claude/rules/e2e.md): a request with no authorization id
 * is told the link is incomplete; a signed-out visitor is sent to sign in with a `next` that
 * keeps the id; a signed-in account (the E2E bypass user) is handed the request, whose read
 * against the placeholder project then fails in words. The approve and deny answers need
 * GoTrue and are covered by the service's unit tests and the spike.
 */

const AUTHORIZATION_ID = 'e2e1e2e1e2e1e2e1e2e1e2e1e2e1e2e1';
const CONSENT_PATH = `/oauth/consent?authorization_id=${AUTHORIZATION_ID}`;
const COLD_PAGE = { timeout: 45_000 };

test('a signed-out visitor is sent to sign in and comes back to the same request', async ({ page }) => {
  // No timeout of its own: the first request for the route waits for its compile.
  await page.goto(CONSENT_PATH, { waitUntil: 'commit' });
  await expect(page).toHaveURL(/\/login\?/, COLD_PAGE);
  const url = new URL(page.url());
  expect(url.searchParams.get('next')).toBe(CONSENT_PATH);
});

test('a request with no authorization id is told the link is incomplete', async ({ page }) => {
  await page.goto('/oauth/consent', { waitUntil: 'commit' });
  await expect(page.getByRole('heading', { level: 1, name: 'This link is incomplete' })).toBeVisible(COLD_PAGE);
  await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0);
});

test('a signed-in account is handed the request, and an unreadable one is answered in words', async ({ page, context }) => {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  await page.goto(CONSENT_PATH, { waitUntil: 'commit' });
  // The page's script reads the request with the session; against the placeholder project the
  // read fails, and the page says so without exposing the error.
  await expect(page.getByRole('heading', { level: 1, name: 'This connection could not be made' })).toBeVisible(COLD_PAGE);
  await expect(page.getByText('Go back to the app that asked and connect again.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/oauth/consent\\?authorization_id=${AUTHORIZATION_ID}$`));
});
