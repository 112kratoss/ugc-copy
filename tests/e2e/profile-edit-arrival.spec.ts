import { expect, test, type Page } from '@playwright/test';

// Edit profile, opened from the profile at 1440x900 (live sweep of 941e2a55b, 2026-11-17): the
// editor waits for an idle moment and its code behind a placeholder much shorter than itself, and
// Connected apps was drawn right under the placeholder, at y 830 of the 900px window. When the
// editor arrived, Connected apps went below the fold: it showed for a moment and moved away
// (a layout shift of 0.029, its source the Connected apps section). Now nothing under the editor is
// drawn before the editor is, so whatever comes under it is drawn where it stays.
//
// Offline, the profile's server reads fail and the E2E user's starter profile is drawn (about 8
// seconds on each page). The browser's session is a cookie of the placeholder project's, answered
// below, so Connected apps reads an answer (no apps) rather than a missing session.

const ORIGIN = 'http://127.0.0.1:3100';
const USER_ID = 'workflow-user';
const SLOW_PAGE = { timeout: 60_000 };

test.describe.configure({ timeout: 240_000 });

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
  await page.route('https://example.supabase.co/auth/v1/user/oauth/grants*', (route) => route.fulfill({ json: [] }));
  // Connected apps reads the app's own authorization server's grants too (connected-apps.ts): none.
  await page.route('**/api/oauth/grants', (route) => route.fulfill({ json: { grants: [] } }));
  await page.route('https://example.supabase.co/auth/v1/user', (route) => route.fulfill({ json: user }));
  await page.route('https://example.supabase.co/rest/v1/profiles*', (route) => {
    const row = { display_name: 'Workflow User', avatar_url: null, credits: 617, username: null };
    const accept = route.request().headers().accept ?? '';
    return route.fulfill({ json: accept.includes('vnd.pgrst.object') ? row : [row] });
  });
}

type Frame = { t: number; appsTop: number | null; appsOnScreen: boolean; placeholder: boolean; editor: boolean };

/**
 * From the document's first frame, every frame of /profile/edit whose drawing differs from the
 * last: where Connected apps is laid out (null while it is not drawn), whether it is in the window,
 * and whether the editor's placeholder or the editor is drawn. And every layout shift, by its
 * sources. The place is the layout's, from the offsets: the section rises 8px into it as it enters
 * (`ui-enter`, a transform), which moves nothing else and which a layout shift does not count.
 */
const RECORDER = `(() => {
  const frames = [];
  const shifts = [];
  window.__editFrames = frames;
  window.__editShifts = shifts;
  let last = '';
  const layoutTop = (element) => {
    let top = 0;
    for (let node = element; node; node = node.offsetParent) top += node.offsetTop;
    return top;
  };
  function sample() {
    if (location.pathname === '/profile/edit') {
      const apps = document.querySelector('section[aria-label="Connected apps"]');
      const box = apps && apps.getClientRects().length > 0 ? apps.getBoundingClientRect() : null;
      const frame = {
        appsTop: box ? layoutTop(apps) : null,
        appsOnScreen: Boolean(box && box.top < window.innerHeight && box.bottom > 0),
        placeholder: Boolean(document.querySelector('[aria-label="Loading the profile editor"]')),
        editor: Boolean(document.getElementById('creator-profile-form')),
      };
      const key = JSON.stringify(frame);
      if (key !== last) {
        last = key;
        frames.push({ t: Math.round(performance.now()), ...frame });
      }
    }
    if (!window.__editFramesDone) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        shifts.push({
          path: location.pathname,
          value: entry.value,
          sources: (entry.sources || []).map((source) => {
            const node = source.node;
            if (!node || node.nodeType !== 1) return String(node && node.nodeName);
            const label = node.getAttribute('aria-label');
            return node.tagName.toLowerCase() + (label ? '[aria-label="' + label + '"]' : '') + '.' + String(node.className).trim().split(/\\s+/).join('.');
          }),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (error) {}
})();`;

async function recorded(page: Page) {
  return page.evaluate(() => {
    const record = window as unknown as {
      __editFrames: Frame[];
      __editShifts: Array<{ path: string; value: number; sources: string[] }>;
      __editFramesDone?: boolean;
    };
    record.__editFramesDone = true;
    return { frames: record.__editFrames, shifts: record.__editShifts };
  });
}

/** Waits for React to own the shell and the page: a click before then is a full page load. */
async function hydrated(page: Page) {
  await page.waitForFunction(() => ['header.app-shell-header', '#main-content > *'].every((selector) => {
    const element = document.querySelector(selector);
    return Boolean(element && Object.keys(element).some((key) => key.startsWith('__reactFiber$')));
  }), undefined, SLOW_PAGE);
}

function expectConnectedAppsDrawnWhereItStays(frames: Frame[], shifts: Array<{ path: string; value: number; sources: string[] }>) {
  expect(frames.length, 'the page was drawn').toBeGreaterThan(0);
  const final = frames[frames.length - 1];
  expect(final.editor, JSON.stringify(final)).toBe(true);
  expect(final.appsTop, JSON.stringify(final)).not.toBeNull();
  for (const frame of frames) {
    if (frame.appsTop === null) continue;
    // Drawn only where it stays: never under the placeholder, then pushed down by the editor.
    expect(Math.abs(frame.appsTop - final.appsTop!), `Connected apps moved: ${JSON.stringify(frame)}, then ${JSON.stringify(final)}`).toBeLessThanOrEqual(1);
  }
  const movedApps = shifts.filter((shift) => shift.path === '/profile/edit'
    && shift.sources.some((source) => source.includes('aria-label="Connected apps"')));
  expect(movedApps).toEqual([]);
}

test('Edit profile opened from the profile draws Connected apps only where it stays', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.addInitScript(RECORDER);
  // The editor's code compiles on its first request: asked for once, so the measured visit's wait is
  // the page's own idle wait and download, as on the live site.
  await page.goto('/profile/edit', SLOW_PAGE);
  await expect(page.locator('#creator-profile-form')).toBeVisible(SLOW_PAGE);

  await page.goto('/profile', SLOW_PAGE);
  const editLink = page.getByRole('link', { name: 'Edit profile', exact: true });
  await expect(editLink).toBeVisible(SLOW_PAGE);
  await hydrated(page);
  await editLink.click();
  await page.waitForURL('**/profile/edit', SLOW_PAGE);
  await expect(page.locator('#creator-profile-form')).toBeVisible(SLOW_PAGE);
  await expect(page.getByText('No apps connected')).toBeAttached();
  const { frames, shifts } = await recorded(page);

  expectConnectedAppsDrawnWhereItStays(frames, shifts);
});

test('a full load of Edit profile draws Connected apps only where it stays, on a phone too', async ({ page }) => {
  await signIn(page);
  await page.addInitScript(RECORDER);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/profile/edit', SLOW_PAGE);
  await expect(page.locator('#creator-profile-form')).toBeVisible(SLOW_PAGE);

  await page.reload();
  await expect(page.locator('#creator-profile-form')).toBeVisible(SLOW_PAGE);
  await expect(page.getByText('No apps connected')).toBeAttached();
  const { frames, shifts } = await recorded(page);

  expectConnectedAppsDrawnWhereItStays(frames, shifts);
});

// Connected apps waits in the editor's boundary, so an editor whose code did not load (a dropped
// connection, a deploy that rotated the chunk names) took it down too (review of #841). The editor's
// chunk fails its first request here: a card says so, Connected apps is still drawn, and Try again
// reloads the page, whose request for the chunk (the second) goes through and draws the editor. A
// reload and not a retry in place: after a deploy a retry asks for the old name again, and in
// production Turbopack's runtime hands a retry the same failed load; this server, `next dev
// --webpack`, would retry, so the spec holds the reload itself.
test('an editor whose code fails to load leaves Connected apps drawn, and Try again brings the editor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  // Compiled once, so the failed request is the browser's, not the compile's.
  await page.goto('/profile/edit', SLOW_PAGE);
  await expect(page.locator('#creator-profile-form')).toBeVisible(SLOW_PAGE);

  const editorChunks: string[] = [];
  await page.route(/CreatorProfileCard/, (route) => {
    if (route.request().resourceType() !== 'script') return route.continue();
    editorChunks.push(route.request().url());
    return editorChunks.length === 1 ? route.abort('connectionfailed') : route.continue();
  });
  await page.reload();
  const failed = page.getByRole('alert').filter({ hasText: 'The profile editor did not load.' });
  await expect(failed).toBeVisible(SLOW_PAGE);
  expect(editorChunks).toHaveLength(1);
  await expect(page.locator('#creator-profile-form')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Connected apps' })).toBeVisible();
  await expect(page.getByText('No apps connected')).toBeVisible();
  // The card stands where the editor would: above Connected apps.
  const [cardBottom, appsTop] = await Promise.all([
    failed.evaluate((card) => card.getBoundingClientRect().bottom),
    page.getByRole('region', { name: 'Connected apps' }).evaluate((apps) => apps.getBoundingClientRect().top),
  ]);
  expect(cardBottom).toBeLessThanOrEqual(appsTop);

  // The document Try again leaves is marked, so the editor that follows is shown to be a new
  // document's, not the old one's retry.
  await page.evaluate(() => {
    (window as unknown as { __beforeTryAgain?: boolean }).__beforeTryAgain = true;
  });
  const reloaded = page.waitForEvent('load', SLOW_PAGE);
  await page.getByRole('button', { name: 'Try again' }).click();
  await reloaded;
  await expect(page.locator('#creator-profile-form')).toBeVisible(SLOW_PAGE);
  expect(await page.evaluate(() => (window as unknown as { __beforeTryAgain?: boolean }).__beforeTryAgain ?? false)).toBe(false);
  expect(editorChunks.length).toBeGreaterThan(1);
  await expect(failed).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Connected apps' })).toBeVisible();
});
