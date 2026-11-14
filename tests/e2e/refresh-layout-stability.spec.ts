import { expect, test, type Page } from '@playwright/test';

// A refresh drew the top bar in a shape it then left (owner's recording, 2026-11-14): Home's title
// read "Workspace" until the shell mounted and its search field moved 117px, and a signed-in
// visitor's account slot drew "Sign in", then "Credits", then the balance, moving the controls
// beside it each time. Pricing then pushed its content down 110px (174px on a phone) when its
// balance card arrived. The unit tests hold the markup and the CSS rules; this holds what a
// browser draws from its first frame on, with the stylesheet and the pre-paint script applied.

const ORIGIN = 'http://127.0.0.1:3100';
const USER_ID = 'workflow-user';
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };

test.describe.configure({ timeout: 120_000 });

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

/**
 * A session cookie for the placeholder project (`https://example.supabase.co`), sent with every
 * request as a browser sends it, with the E2E bypass for the server's own reads. Its JWT is never
 * checked offline: the browser's `/auth/v1/user` and `profiles` reads are answered below.
 */
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
  // Answered after a delay, as production answers them: the first frames come before the account.
  await page.route('https://example.supabase.co/auth/v1/user*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ json: user });
  });
  await page.route('https://example.supabase.co/rest/v1/profiles*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const row = { display_name: 'Workflow User', avatar_url: null, credits: 617 };
    const accept = route.request().headers().accept ?? '';
    await route.fulfill({ json: accept.includes('vnd.pgrst.object') ? row : [row] });
  });
}

type Frame = {
  title: string | null;
  searchX: number | null;
  rightX: number | null;
  inviteY: number | null;
  balanceCard: boolean;
  authHint: string | null;
};

/**
 * Records, from the document's first frame, every frame whose drawing of the top bar (and, on
 * Pricing, of the invite banner) differs from the last. The page's own scripts have not run at the
 * first frames: what they hold is the server's HTML under the stylesheet and the pre-paint script.
 */
const RECORDER = `(() => {
  const frames = [];
  window.__layoutFrames = frames;
  let last = '';
  const x = (element) => (element ? Math.round(element.getBoundingClientRect().x) : null);
  function sample() {
    const header = document.querySelector('header.app-shell-header');
    if (header) {
      const invite = document.querySelector('section[aria-label="Invite and earn bonus credits"]');
      const frame = {
        title: header.firstElementChild ? header.firstElementChild.textContent.replace(/\\s+/g, ' ').trim() : null,
        searchX: x(header.querySelector('form.app-shell-search')),
        rightX: x(header.lastElementChild),
        inviteY: invite ? Math.round(invite.getBoundingClientRect().y + window.scrollY) : null,
        balanceCard: Boolean(document.querySelector('#main-content')?.textContent.includes('Available balance')),
        authHint: document.documentElement.dataset.authHint || null,
      };
      const key = JSON.stringify(frame);
      if (key !== last) {
        last = key;
        frames.push(frame);
      }
    }
    if (!window.__layoutFramesDone) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();`;

async function recordedFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const record = window as unknown as { __layoutFrames: Frame[]; __layoutFramesDone?: boolean };
    record.__layoutFramesDone = true;
    return record.__layoutFrames;
  });
}

test('a signed-in refresh of Pricing draws the top bar and the page where they stay', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.addInitScript(RECORDER);
  await page.goto('/pricing', COLD_PAGE);
  await expect(page.getByRole('link', { name: '617 credits' })).toBeVisible(COLD_PAGE);

  // The measured load: the route is compiled, so its first frames are a refresh's.
  await page.reload();
  await expect(page.getByRole('link', { name: '617 credits' })).toBeVisible();
  await expect(page.locator('#main-content').getByText('617 credits')).toBeVisible();
  const frames = await recordedFrames(page);

  expect(frames.length).toBeGreaterThan(0);
  // The pre-paint script marked the session before the first frame.
  expect(frames[0].authHint).toBe('signed-in');
  const final = frames[frames.length - 1];
  for (const frame of frames) {
    // The controls beside the balance: one digit's width each from the placeholder to the figure.
    expect(Math.abs((frame.rightX ?? 0) - (final.rightX ?? 0)), JSON.stringify(frame)).toBeLessThanOrEqual(2);
    expect(frame.searchX, JSON.stringify(frame)).toBe(final.searchX);
    if (frame.inviteY !== null) {
      // The balance card is drawn from the first frame the page is, so nothing below it moves.
      expect(frame.balanceCard, JSON.stringify(frame)).toBe(true);
      expect(frame.inviteY, JSON.stringify(frame)).toBe(final.inviteY);
    }
  }
});

test("a signed-out refresh of Home reads Home from the first frame", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(RECORDER);
  // The shell has mounted once its account slot draws "Sign in" without the server's mark, which
  // only the browser's render after hydration takes off (DeferredAppShellAccount).
  const mountedSignIn = page.locator('header.app-shell-header a[href^="/login"]:not(.app-shell-when-signed-out)');
  await page.goto('/', COLD_PAGE);
  await expect(mountedSignIn).toBeVisible(COLD_PAGE);

  await page.reload();
  await expect(mountedSignIn).toBeVisible();
  const frames = await recordedFrames(page);

  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame.title, JSON.stringify(frame)).toContain('Home');
    expect(frame.searchX, JSON.stringify(frame)).toBe(frames[frames.length - 1].searchX);
    expect(frame.authHint, JSON.stringify(frame)).toBeNull();
  }
});
