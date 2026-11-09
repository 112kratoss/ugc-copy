import { expect, test, type Page } from '@playwright/test';

/**
 * Continue with Apple on /login: Supabase's Apple web flow (the runbook's "Sign in with Apple on
 * the web"). The page draws it on its choices and again under its email form, and a press leaves
 * for Supabase's Apple authorize address with the callback that finishes every provider sign-in
 * here, the page's destination, and a PKCE challenge, whose verifier stays in this browser for
 * /auth/callback to exchange the code with. The page has no Sign in / Sign up tabs: Apple and
 * Google make an account or sign into one (owner, 2026-11-09, the app's page on the web).
 *
 * Apple is out of reach offline, so the authorize address is answered with a page of its own and
 * the spec reads what the page asked for. The press waits for React to have committed the page's
 * hydration: a press before that is dropped (.claude/rules/e2e.md).
 */

const COLD_PAGE = { timeout: 45_000 };

/** Whether React has committed the page's hydration (as in login-typed-before-script.spec.ts). */
function hydrationCommitted(page: Page) {
  return page.evaluate(() => {
    type HostRoot = { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } };
    const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
    const root = key ? (document as unknown as Record<string, HostRoot>)[key] : undefined;
    return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
  });
}

test('/login: Continue with Apple leaves for Supabase’s Apple sign-in with the destination kept, from the email form too', async ({ page }) => {
  test.setTimeout(120_000);
  const authorizeUrls: URL[] = [];
  await page.route('https://example.supabase.co/auth/v1/authorize**', (route) => {
    authorizeUrls.push(new URL(route.request().url()));
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Apple</title>' });
  });

  // No timeout of its own: this can be the run's first request for the route, which waits for
  // its compile (.claude/rules/e2e.md).
  await page.goto('/login?returnUrl=%2Fcreate-video', { waitUntil: 'commit' });
  const choices = page.getByRole('region', { name: 'Start filling your Magic Booklet' });
  const apple = choices.getByRole('button', { name: 'Continue with Apple' });
  await expect(apple).toBeVisible(COLD_PAGE);
  await expect(page.getByRole('tab')).toHaveCount(0);
  // The agreement goes with Apple as with Google: either button makes an account.
  await expect(apple).toHaveAccessibleDescription(/^By continuing you agree to the Terms and the Privacy Policy\./);
  await expect.poll(() => hydrationCommitted(page), { ...COLD_PAGE, message: 'React commits the page’s hydration' }).toBe(true);

  // The email form, in place: the page's own turn, no new visit, Apple under the form.
  await choices.getByRole('link', { name: 'Made an account with email? Sign in' }).click();
  const form = page.getByRole('region', { name: 'Sign in with email' });
  await expect(form.getByLabel('Email')).toBeVisible();
  await expect(page).toHaveURL(/\/login\?returnUrl=%2Fcreate-video&email=1$/);
  await form.getByRole('button', { name: 'Continue with Apple' }).click();

  await expect.poll(() => authorizeUrls.length, { message: 'the page leaves for Supabase’s authorize address' }).toBe(1);
  const [authorize] = authorizeUrls;
  expect(authorize.searchParams.get('provider')).toBe('apple');
  expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
  const redirectTo = new URL(authorize.searchParams.get('redirect_to') ?? '');
  expect(redirectTo.pathname).toBe('/auth/callback');
  expect(redirectTo.searchParams.get('next')).toBe('/create-video');
  await expect(page).toHaveTitle('Apple');
});
