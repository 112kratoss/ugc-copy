import { expect, test, type Page } from '@playwright/test';

// The profile's Mature content row read "Loading your setting…" beside a spinning switch for 0.3 to
// 0.9 seconds after the page was drawn, then its setting (live sweep of 941e2a55b, 2026-11-17): the
// browser asked for it after hydration, though the page reads the owner's profile on the server
// anyway. The server reads the setting beside the profile now, and the row draws it from the first
// frame; the browser's own read stays, as the way to it when the server could not read it and as a
// check of a page the router kept for Back.
//
// The dev server's stub answers the E2E user's setting as on (support/supabase-server-stub.cjs), so
// a first frame that draws it can only have had it from the server. The browser's read is answered
// late, as on a slow connection.

const ORIGIN = 'http://127.0.0.1:3100';
const USER_ID = 'workflow-user';
// Offline, the profile spends about 8 seconds failing its other reads before it draws.
const SLOW_PAGE = { timeout: 60_000 };
const ON = 'On. NSFW posts stay covered until you reveal one.';

test.describe.configure({ timeout: 180_000 });

function base64Url(text: string) {
  return Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const user = {
  id: USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'workflow-user@example.com',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { name: 'Workflow User' },
  identities: [],
  is_anonymous: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

async function signIn(page: Page) {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ sub: USER_ID, exp: 4_102_444_800, role: 'authenticated', aud: 'authenticated' }));
  const session = {
    access_token: `${header}.${payload}.c2lnbmF0dXJl`,
    refresh_token: 'e2e-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4_102_444_800,
    user,
  };
  await page.context().addCookies([
    { name: 'sb-example-auth-token', value: `base64-${base64Url(JSON.stringify(session))}`, url: ORIGIN },
    { name: 'e2e-auth', value: USER_ID, url: ORIGIN },
    { name: 'mb_name_step_shown', value: USER_ID, url: ORIGIN },
  ]);
  await page.route('https://example.supabase.co/auth/v1/user', (route) => route.fulfill({ json: user }));
  await page.route('https://example.supabase.co/rest/v1/profiles*', (route) => {
    const row = { display_name: 'Workflow User', avatar_url: null, credits: 617, username: null };
    const accept = route.request().headers().accept ?? '';
    return route.fulfill({ json: accept.includes('vnd.pgrst.object') ? row : [row] });
  });
}

type Frame = { t: number; detail: string; checked: string | null; busy: string | null };

/** From the document's first frame, every frame whose drawing of the Mature content row differs from the last. */
const RECORDER = `(() => {
  const frames = [];
  window.__matureFrames = frames;
  let last = '';
  function sample() {
    const detail = document.getElementById('mature-content-detail');
    if (detail && detail.getClientRects().length > 0) {
      const toggle = document.querySelector('[role="switch"][aria-labelledby="mature-content-label"]');
      const frame = {
        detail: detail.textContent.trim(),
        checked: toggle ? toggle.getAttribute('aria-checked') : null,
        busy: toggle ? toggle.getAttribute('aria-busy') : null,
      };
      const key = JSON.stringify(frame);
      if (key !== last) {
        last = key;
        frames.push({ t: Math.round(performance.now()), ...frame });
      }
    }
    if (!window.__matureFramesDone) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();`;

async function recordedFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const record = window as unknown as { __matureFrames: Frame[]; __matureFramesDone?: boolean };
    record.__matureFramesDone = true;
    return record.__matureFrames;
  });
}

test('the profile draws its Mature content setting from the first frame', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const reads: number[] = [];
  await page.route('**/api/content-preferences', async (route) => {
    if (route.request().method() !== 'GET') return route.abort();
    reads.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return route.fulfill({ json: { showMature: true }, headers: { 'Cache-Control': 'private, no-store' } });
  });
  await page.addInitScript(RECORDER);
  await page.goto('/profile', SLOW_PAGE);
  const toggle = page.getByRole('switch', { name: 'Mature content' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true', SLOW_PAGE);
  // The browser's own read has answered too, and changed nothing.
  await expect.poll(() => reads.length, SLOW_PAGE).toBeGreaterThan(0);
  await page.waitForTimeout(1_800);
  const frames = await recordedFrames(page);

  expect(frames.length, 'the row was drawn').toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame, JSON.stringify(frames)).toMatchObject({ detail: ON, checked: 'true' });
    expect(frame.busy, JSON.stringify(frames)).toBeNull();
  }
  await expect(toggle).toBeEnabled();
});
