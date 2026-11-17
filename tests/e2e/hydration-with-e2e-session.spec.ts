import { expect, test, type BrowserContext } from '@playwright/test';

import freeRemixPost from './fixtures/creation-post-free-recipe.json';

// A cached page (post, creator, marketplace) is drawn once for everyone, so the server's render
// holds no session even for the E2E user. The auth bypass used to hand the client its session in
// the hydration render, which the server's HTML never had: React threw the HTML away and drew the
// tree again ("Hydration failed ... didn't match", first at ReportPostButton's creator rows). In
// production the session reaches such a page after hydration; the bypass now does the same.

const COLD_PAGE = { timeout: 45_000 };

test.describe.configure({ timeout: 180_000 });

function base64url(value: string) {
  return Buffer.from(value).toString('base64url');
}

// The E2E user (src/lib/e2e-auth.ts) as Supabase's auth describes them to the browser.
const user = {
  id: 'workflow-user',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'workflow-user@example.com',
  is_anonymous: false,
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
const session = {
  access_token: [
    base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64url(JSON.stringify({
      sub: user.id, aud: 'authenticated', role: 'authenticated', exp: EXPIRES_AT,
      email: user.email, is_anonymous: false, session_id: 'e2e-session',
    })),
    'e2e-signature',
  ].join('.'),
  token_type: 'bearer',
  expires_in: 365 * 24 * 3600,
  expires_at: EXPIRES_AT,
  refresh_token: 'e2e-refresh-token',
  user,
};

/** Signed in as the E2E user, who is not the post's creator and has not taken its recipe. */
async function signIn(context: BrowserContext) {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  const cookie = `sb-example-auth-token=base64-${base64url(JSON.stringify(session))}`;
  await context.addInitScript((value) => {
    document.cookie = `${value}; path=/; SameSite=Lax`;
  }, cookie);
  await context.route('https://example.supabase.co/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') return route.fulfill({ json: user });
    if (pathname === '/auth/v1/token') return route.fulfill({ json: session });
    const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
    if (pathname === '/rest/v1/profiles') {
      const row = { display_name: 'E2E Creator', avatar_url: null, credits: 25 };
      return route.fulfill({ json: single ? row : [row] });
    }
    if (pathname.startsWith('/rest/v1/')) return route.fulfill(single ? { status: 406, json: {} } : { json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
}

test('a signed-in visit to a cached post page hydrates the server\'s HTML without a mismatch', async ({ page, context }) => {
  const problems: string[] = [];
  const note = (text: string) => {
    if (/Hydration failed|didn't match|did not match|hydrat/i.test(text)) problems.push(text.slice(0, 300));
  };
  page.on('pageerror', (error) => note(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') note(message.text());
  });

  await signIn(context);
  // The dev server's /api answers 401 to the bypass user, which the comments draw as "Your session
  // ended. Sign in again" (a second Sign in link); the other post specs answer it offline too.
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/showcase/${freeRemixPost.post.id}`);
  await expect(page.getByRole('heading', { level: 1, name: freeRemixPost.post.title })).toBeVisible(COLD_PAGE);

  // The session still arrives, after hydration: the signed-in-only row and the shell's Sign in.
  await expect(page.getByRole('link', { name: /^Sign in/ })).toHaveCount(0, COLD_PAGE);
  await expect(page.getByRole('button', { name: /^Report user/ })).toBeVisible(COLD_PAGE);

  // Hydration errors are logged during the first seconds; give a late one time to show.
  await page.waitForTimeout(3_000);
  expect(problems).toEqual([]);
});
