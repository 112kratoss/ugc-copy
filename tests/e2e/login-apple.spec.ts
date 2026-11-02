import { expect, test, type Page } from '@playwright/test';

/**
 * Continue with Apple on /login: Supabase's Apple web flow (the runbook's "Sign in with Apple on
 * the web"). Both tabs draw the button, and a press leaves for Supabase's Apple authorize address
 * with the callback that finishes every provider sign-in here, the page's destination, and a PKCE
 * challenge, whose verifier stays in this browser for /auth/callback to exchange the code with.
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

test('/login: Continue with Apple, on either tab, leaves for Supabase’s Apple sign-in with the destination kept', async ({ page }) => {
  test.setTimeout(120_000);
  const authorizeUrls: URL[] = [];
  await page.route('https://example.supabase.co/auth/v1/authorize**', (route) => {
    authorizeUrls.push(new URL(route.request().url()));
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Apple</title>' });
  });

  // No timeout of its own: this can be the run's first request for the route, which waits for
  // its compile (.claude/rules/e2e.md).
  await page.goto('/login?returnUrl=%2Fcreate-video', { waitUntil: 'commit' });
  const apple = page.getByRole('button', { name: 'Continue with Apple' });
  await expect(apple).toBeVisible(COLD_PAGE);
  await expect(page.getByRole('button', { name: 'Sign in', pressed: true })).toBeVisible();
  // The agreement under Google is under Apple too: either button makes an account.
  await expect(apple).toHaveAccessibleDescription(/^By continuing you agree to the Terms and the Privacy Policy\./);
  await expect.poll(() => hydrationCommitted(page), { ...COLD_PAGE, message: 'React commits the page’s hydration' }).toBe(true);

  // The Sign-up tab, the page's own switch: no new visit.
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expect(apple).toBeVisible();
  await apple.click();

  await expect.poll(() => authorizeUrls.length, { message: 'the page leaves for Supabase’s authorize address' }).toBe(1);
  const [authorize] = authorizeUrls;
  expect(authorize.searchParams.get('provider')).toBe('apple');
  expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
  const redirectTo = new URL(authorize.searchParams.get('redirect_to') ?? '');
  expect(redirectTo.pathname).toBe('/auth/callback');
  expect(redirectTo.searchParams.get('next')).toBe('/create-video');
  await expect(page).toHaveTitle('Apple');
});
