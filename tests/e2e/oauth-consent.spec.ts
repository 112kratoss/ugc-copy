import { expect, test } from '@playwright/test';

import consentRequests from './fixtures/oauth-consent-requests.json';

/**
 * The consent page's gate, offline (.claude/rules/e2e.md): a request with no authorization id
 * is told the link is incomplete; a signed-out visitor is sent to sign in with a `next` that
 * keeps the id; a signed-in account (the E2E bypass user) given an id of another shape, such as
 * one Supabase's OAuth server issued before 2026-11-26, is told in words that it cannot be
 * answered.
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

test('a signed-in account given a request of no server the app runs is answered in words', async ({ page, context }) => {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  await page.goto(CONSENT_PATH, { waitUntil: 'commit' });
  // Not an `mbar_` id, so nothing is read for it: the page says so without asking anyone.
  await expect(page.getByRole('heading', { level: 1, name: 'This connection could not be made' })).toBeVisible(COLD_PAGE);
  await expect(page.getByText('Go back to the app that asked and connect again.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/oauth/consent\\?authorization_id=${AUTHORIZATION_ID}$`));
});

/**
 * A request of the app's own authorization server (`mbar_…`,
 * docs/archive/agent-token-broker-plan-2026-11-26.md): the page reads it on the server for the
 * signed-in account (the dev server answers those two reads, supabase-server-stub.cjs) and
 * arrives with the request drawn: who asks, what the grant's server allows, where the browser
 * goes back to, and the two answers. The answer itself needs a real session and is covered by
 * the service's and the route adapter's unit tests.
 */
test("an account is shown a request of the app's own server: the full list, and a warning for a program on this computer", async ({ page, context }) => {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  const { authorization, client } = consentRequests.full;
  await page.goto(`/oauth/consent?authorization_id=${authorization.id}`, { waitUntil: 'commit' });

  await expect(page.getByRole('heading', { level: 1, name: `Allow ${client.client_name} to use your Magicbooklet account?` })).toBeVisible(COLD_PAGE);
  await expect(page.getByRole('link', { name: 'agent.example.test' })).toHaveAttribute('href', client.client_uri as string);
  const access = page.getByRole('list', { name: 'It will be able to' });
  await expect(access.getByRole('listitem')).toHaveCount(3);
  await expect(access).toContainText('Create images and videos with your credits');
  await expect(access).toContainText('Publish posts as you');
  await expect(access).toContainText('Read your creations');
  await expect(page.getByText('Returns to localhost:8976, a program on your computer')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
  // The page did not leave, and its address carries the request's id and nothing else.
  expect(new URL(page.url()).search).toBe(`?authorization_id=${authorization.id}`);
});

test('a request for the posting server lists the posting access, and names the site it returns to', async ({ page, context }) => {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  const { authorization, client } = consentRequests.posts;
  await page.goto(`/oauth/consent?authorization_id=${authorization.id}`, { waitUntil: 'commit' });

  await expect(page.getByRole('heading', { level: 1, name: `Allow ${client.client_name} to use your Magicbooklet account?` })).toBeVisible(COLD_PAGE);
  const access = page.getByRole('list', { name: 'It will be able to' });
  await expect(access.getByRole('listitem')).toHaveCount(4);
  await expect(access).toContainText('No tool that spends credits');
  await expect(access).not.toContainText('Create images and videos with your credits');
  await expect(page.getByText('Afterwards you return to hosted-agent.example.test')).toBeVisible();
  await expect(page.getByText('a program on your computer')).toHaveCount(0);
});

test("a request of the app's own server that the database does not hold is answered in words, with nothing to allow", async ({ page, context }) => {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  await page.goto(`/oauth/consent?authorization_id=mbar_${'u'.repeat(43)}`, { waitUntil: 'commit' });
  await expect(page.getByRole('heading', { level: 1, name: 'This connection could not be made' })).toBeVisible(COLD_PAGE);
  await expect(page.getByText('Go back to the app that asked and connect again.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0);
});
