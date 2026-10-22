import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import creator from './fixtures/creator-profile.json';

// The owner's Edit profile on their creator page. Below 768px the app shell's bottom navigation
// floats over the page (`.app-shell-bottom-nav`, z-index 60 in globals.css). The editor's
// backdrop was z-50, so the nav was drawn over the dialog's lower part, undimmed, and took every
// tap there. It is z-[80] now, the layer of the app's other modals.
//
// The page reads its creator on the server, which Playwright's routes do not reach: the dev
// server answers those reads itself (support/supabase-server-stub.cjs), with the creator in
// fixtures/creator-profile.json, whom the E2E user owns.

const PHONE = { width: 390, height: 844 };
// In `next dev` the page compiles on its first request, and the owner's controls wait for
// hydration after that.
const COLD_PAGE = { timeout: 45_000 };

test.describe.configure({ timeout: 180_000 });

function base64url(value: string) {
  return Buffer.from(value).toString('base64url');
}

// The E2E user (src/lib/e2e-auth.ts) as Supabase's auth describes them to the browser.
const user = {
  id: creator.id,
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
// The owner's own copy of the profile, which the editor reads when it opens (GET /api/profile).
const ownProfile = {
  id: creator.id,
  username: creator.username,
  suggestedUsername: creator.username,
  displayName: creator.display_name,
  bio: creator.bio,
  avatarUrl: null,
  coverUrl: null,
  websiteUrl: null,
  twitterHandle: null,
  instagramHandle: null,
  tiktokHandle: null,
  location: null,
  credits: 25,
};

/**
 * The owner, signed in twice over: the e2e-auth cookie signs in the server, and the browser's
 * Supabase client reads a session from a cookie of its own, which the page's ownership check
 * compares with the creator (ProfileActions). That cookie is written after each document
 * request, and Supabase and every API the browser calls are answered here, so the made-up token
 * never reaches the server. Returns the bodies of the profile saves the page sends.
 */
async function signInAsTheCreator(context: BrowserContext) {
  const saves: Record<string, unknown>[] = [];
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  const cookie = `sb-example-auth-token=base64-${base64url(JSON.stringify(session))}`;
  await context.addInitScript((value) => {
    document.cookie = `${value}; path=/; SameSite=Lax`;
  }, cookie);
  await context.route('https://example.supabase.co/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') return route.fulfill({ json: user });
    if (pathname === '/auth/v1/token') return route.fulfill({ json: session });
    // The top bar's account slot.
    if (pathname === '/rest/v1/profiles') {
      const row = { display_name: creator.display_name, avatar_url: null, credits: 25, username: creator.username };
      const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
      return route.fulfill({ json: single ? row : [row] });
    }
    if (pathname.startsWith('/rest/v1/')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  await context.route('**/api/**', (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/profile' && request.method() === 'GET') return route.fulfill({ json: ownProfile });
    if (pathname === '/api/profile/validate') return route.fulfill({ json: {} });
    if (pathname === '/api/profile' && request.method() === 'PATCH') {
      const saved = request.postDataJSON() as Record<string, unknown>;
      saves.push(saved);
      return route.fulfill({ json: { ...ownProfile, ...saved } });
    }
    return route.fulfill({ status: 503, json: { error: 'Not answered offline' } });
  });
  return saves;
}

// Something else is drawn at the centre of every bottom-nav link and at the nav's two ends: an
// overlay that covers the page covers the nav too. `next dev` draws its own badge over the
// bottom-left corner, which is skipped. The check of the same name in
// app-shell-short-pages.spec.ts, for the workflow canvas's overlays.
async function expectOverTheBottomNav(page: Page, name: string) {
  const showing = await page.evaluate(() => {
    const nav = document.querySelector('nav.app-shell-bottom-nav')!;
    const box = nav.getBoundingClientRect();
    const points = [...nav.querySelectorAll('a')].map((link) => {
      const r = link.getBoundingClientRect();
      return { name: link.getAttribute('aria-label') || link.textContent?.trim() || '', x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    points.push(
      { name: 'its left end', x: box.left + 6, y: box.top + box.height / 2 },
      { name: 'its right end', x: box.right - 6, y: box.top + box.height / 2 },
    );
    return points.filter(({ x, y }) => {
      const hit = document.elementsFromPoint(x, y).find((element) => !element.closest('nextjs-portal'));
      return Boolean(hit && nav.contains(hit));
    }).map((point) => point.name);
  });
  expect.soft(showing, `the bottom navigation shows over ${name} at`).toEqual([]);
}

test('the owner\'s Edit profile is drawn over the bottom navigation, and its Close and Save take their taps', async ({ page, context }) => {
  const saves = await signInAsTheCreator(context);
  await page.setViewportSize(PHONE);
  await page.goto(`/creators/${creator.username}`);
  await expect(page.getByRole('heading', { level: 1, name: creator.display_name })).toBeVisible(COLD_PAGE);

  const edit = page.getByRole('button', { name: 'Edit profile' });
  const editor = page.getByRole('dialog', { name: 'Edit profile' });
  const form = editor.locator('#creator-profile-form');
  await expect(edit, 'the owner is offered Edit profile').toBeVisible(COLD_PAGE);
  await edit.click();
  await expect(form).toBeVisible();
  await expectOverTheBottomNav(page, 'the profile editor');

  // Close, on the editor as it opened, closes it.
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toBeHidden();

  // Save, once something has changed, sends the change, and the editor closes on its answer.
  await edit.click();
  await expect(form).toBeVisible();
  const bio = 'A bio the end-to-end suite typed.';
  await form.locator('#profile-bio').fill(bio);
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor).toBeHidden();
  expect(saves.map((save) => save.bio), 'the bios the saves sent').toEqual([bio]);
});
