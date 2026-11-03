import { expect, test, type BrowserContext } from '@playwright/test';

/**
 * /delete-account for an account with an Apple identity (src/lib/apple-web-reauthentication.ts):
 * Continue with Apple leaves for Apple's authorize page as the website's Services ID (a
 * placeholder in playwright.config.ts), Apple sends the person back with a one-time code in the
 * address's fragment, and the deletion request carries that code for the website's client.
 *
 * Apple is out of reach offline, so its authorize address is answered with a page that sends the
 * browser back as Apple does once the person has confirmed. The browser's Supabase session is a
 * made-up one in its cookie, and every API the page calls is answered here, so the made-up token
 * never reaches the server. The account is a Google one that Supabase linked a website Apple
 * sign-in to, which only an email request could delete before.
 */

const ORIGIN = 'http://127.0.0.1:3100';
// The route compiles on its first request, and the section waits for the page's script after it.
const COLD_PAGE = { timeout: 45_000 };

function base64url(value: string) {
  return Buffer.from(value).toString('base64url');
}

const user = {
  id: 'e2e-apple-linked-user',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'apple-linked@example.com',
  is_anonymous: false,
  app_metadata: { provider: 'google', providers: ['google', 'apple'] },
  user_metadata: {},
  identities: [
    { identity_id: 'e2e-google-identity', id: 'google-user-1', user_id: 'e2e-apple-linked-user', provider: 'google', identity_data: { sub: 'google-user-1' } },
    { identity_id: 'e2e-apple-identity', id: 'apple-user-1', user_id: 'e2e-apple-linked-user', provider: 'apple', identity_data: { sub: 'apple-user-1' } },
  ],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
const session = {
  access_token: [
    base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64url(JSON.stringify({
      sub: user.id, aud: 'authenticated', role: 'authenticated', exp: EXPIRES_AT,
      email: user.email, is_anonymous: false, session_id: 'e2e-apple-session',
    })),
    'e2e-signature',
  ].join('.'),
  token_type: 'bearer',
  expires_in: 365 * 24 * 3600,
  expires_at: EXPIRES_AT,
  refresh_token: 'e2e-refresh-token',
  user,
};

/** Signs the browser in and answers what the page asks for; returns the deletion requests it sends. */
async function signIn(context: BrowserContext) {
  const deletions: Array<{ authorization?: string; body: unknown }> = [];
  const cookie = `sb-example-auth-token=base64-${base64url(JSON.stringify(session))}`;
  await context.addInitScript((value) => {
    document.cookie = `${value}; path=/; SameSite=Lax`;
  }, cookie);
  await context.route('https://example.supabase.co/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') return route.fulfill({ json: user });
    if (pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 404, json: {} });
  });
  await context.route('**/api/**', (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/account' && request.method() === 'DELETE') {
      deletions.push({ authorization: request.headers().authorization, body: request.postDataJSON() });
      return route.fulfill({ status: 202, json: { success: true, deleted: false, deletionScheduled: true } });
    }
    if (pathname === '/api/creator/payouts') {
      return route.fulfill({ json: { availableTokenSubunits: 0, availableUsd: '$0.00', canRequest: false } });
    }
    return route.fulfill({ status: 503, json: { error: 'Not answered offline' } });
  });
  return deletions;
}

/** Apple's authorize page, as it behaves once the person has confirmed; returns the addresses asked for. */
async function answerAppleAsConfirmed(context: BrowserContext) {
  const authorizeUrls: URL[] = [];
  await context.route('https://appleid.apple.com/auth/authorize**', (route) => {
    const url = new URL(route.request().url());
    authorizeUrls.push(url);
    const back = `${url.searchParams.get('redirect_uri')}#code=e2e-apple-code&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}`;
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Apple</title><script>location.replace(${JSON.stringify(back)})</script>`,
    });
  });
  return authorizeUrls;
}

test('/delete-account: an account with an Apple identity continues with Apple, and deletes with the code Apple brings back', async ({ context, page }) => {
  test.setTimeout(150_000);
  const deletions = await signIn(context);
  const authorizeUrls = await answerAppleAsConfirmed(context);

  // No timeout of its own: this can be the run's first request for the route, which waits for its
  // compile (.claude/rules/e2e.md).
  await page.goto('/delete-account', { waitUntil: 'commit' });
  const section = page.getByRole('region', { name: 'Delete your account now' });
  // Only the page's script draws the section, once it has read the session.
  await expect(section.getByRole('heading', { name: 'Confirm with Apple' })).toBeVisible(COLD_PAGE);
  await expect(section.getByLabel('Type DELETE to confirm')).toHaveCount(0);

  await section.getByRole('button', { name: 'Continue with Apple' }).click();

  await expect.poll(() => authorizeUrls.length, { message: 'the page leaves for Apple’s authorize page' }).toBe(1);
  const [authorize] = authorizeUrls;
  expect(Object.fromEntries(authorize.searchParams)).toEqual({
    client_id: 'ci-placeholder-apple-services-id',
    redirect_uri: `${ORIGIN}/delete-account`,
    response_type: 'code',
    response_mode: 'fragment',
    state: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });

  // Back from Apple: the page reads the code and takes it out of the address.
  await expect(section.getByText('Apple confirmed it is you. Type DELETE to finish deleting the account.')).toBeVisible(COLD_PAGE);
  await expect(page).toHaveURL(`${ORIGIN}/delete-account`);
  expect(deletions).toHaveLength(0);

  // Next's router keeps the address the page opened on and writes its own copy back at every
  // commit: the page hands it the clean address too, so a refresh brings no code back.
  type RouterWindow = { e2eAddresses: string[]; next: { router: { refresh(): void } } };
  await page.evaluate(() => {
    const routerWindow = window as unknown as RouterWindow;
    const replaceState = window.history.replaceState.bind(window.history);
    routerWindow.e2eAddresses = [];
    window.history.replaceState = (state, unused, url) => {
      routerWindow.e2eAddresses.push(String(url));
      replaceState(state, unused, url);
    };
    routerWindow.next.router.refresh();
  });
  await expect.poll(
    () => page.evaluate(() => (window as unknown as RouterWindow).e2eAddresses.length),
    { message: "the refresh's commit writes the router's address", timeout: 30_000 },
  ).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as RouterWindow).e2eAddresses)).toEqual(
    expect.not.arrayContaining([expect.stringContaining('code=')]),
  );
  await expect(page).toHaveURL(`${ORIGIN}/delete-account`);
  await expect(section.getByText('Apple confirmed it is you. Type DELETE to finish deleting the account.')).toBeVisible();

  await section.getByLabel('Type DELETE to confirm').fill('DELETE');
  await section.getByRole('button', { name: 'Permanently delete account' }).click();

  await expect(page.getByText('Your account is being deleted. You have been signed out.')).toBeVisible();
  expect(deletions).toEqual([{
    authorization: `Bearer ${session.access_token}`,
    body: { confirmation: 'DELETE', appleAuthorizationCode: 'e2e-apple-code', appleAuthorizationClient: 'web' },
  }]);
});

// Anyone can send a person to Apple's page for this site and back here with a code: only the start
// this tab kept when the person pressed Continue with Apple lets a code through.
test('/delete-account: a code this tab did not ask Apple for deletes nothing', async ({ context, page }) => {
  test.setTimeout(150_000);
  const deletions = await signIn(context);

  await page.goto('/delete-account#code=forged-code&state=forged-state', { waitUntil: 'commit' });
  const section = page.getByRole('region', { name: 'Delete your account now' });

  await expect(section.getByRole('alert')).toHaveText(
    'That Apple confirmation was not started on this page, so nothing was deleted. Continue with Apple here to delete this account.',
    COLD_PAGE,
  );
  await expect(section.getByRole('button', { name: 'Continue with Apple' })).toBeVisible();
  await expect(section.getByLabel('Type DELETE to confirm')).toHaveCount(0);
  await expect(page).toHaveURL(`${ORIGIN}/delete-account`);
  expect(deletions).toHaveLength(0);
});
