import { expect, test, type Page } from '@playwright/test';

// After a click on Alerts the page drew its heading and Mark all read over an empty body, a spinner
// and no list, for 0.5 to 1.3 seconds, then "0 unread alerts", then the whole list at once (live
// sweep of 941e2a55b, 2026-11-17). Mark all read was drawn before the count was known, and stayed,
// lit on hover, with nothing unread. On a phone a full load drew the heading without its controls
// until the session check, and the row they then took pushed the page's body down 64px.
//
// The list's place now holds rows in the shape of the list's own from the first frame the page
// draws, and the rows arrive where they stood. Mark all read is plainly off until the count says
// something is unread. The browser's session is a cookie of the placeholder project's, answered
// below, and the list is answered from here after a delay, as production answers it.

const ORIGIN = 'http://127.0.0.1:3100';
const USER_ID = 'workflow-user';
// In `next dev` a page compiles on its first request, and the signed-in half on its first import().
const COLD_PAGE = { timeout: 45_000 };
const LIST_DELAY_MS = 1_200;

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

/**
 * A session cookie for the placeholder project, as a signed-in browser holds one, with the E2E
 * bypass for the server's own reads. Its JWT is never checked offline: the browser's account reads
 * are answered here, and the list's read is answered before it leaves the browser.
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
  await page.route('https://example.supabase.co/auth/v1/user*', (route) => route.fulfill({ json: user }));
  await page.route('https://example.supabase.co/rest/v1/profiles*', (route) => {
    const row = { display_name: 'Workflow User', avatar_url: null, credits: 617, username: null };
    const accept = route.request().headers().accept ?? '';
    return route.fulfill({ json: accept.includes('vnd.pgrst.object') ? row : [row] });
  });
}

const CATEGORIES = ['generation', 'social', 'commerce', 'system'] as const;

/** Six read alerts of one line each, as most alerts are: newest first. */
function alerts(count = 6) {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.UTC(2026, 10, 16, 12, 0, 0) - index * 3_600_000).toISOString();
    return {
      id: `e2e-alert-${index + 1}`,
      type: 'generation_completed',
      category: CATEGORIES[index % CATEGORIES.length],
      title: `E2E alert ${index + 1}`,
      body: 'They finished a new creation from it.',
      deepLink: null,
      isRead: true,
      eventCount: 1,
      createdAt: at,
      updatedAt: at,
    };
  });
}

/** The list's read, answered after a delay, and the shell's own unread count (`limit=1`) at once. */
async function answerAlerts(page: Page, unreadCount: number) {
  let listReads = 0;
  await page.route(/\/api\/mobile\/notifications(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('limit') === '1') {
      return route.fulfill({ json: { success: true, notifications: [], unreadCount } });
    }
    listReads += 1;
    await new Promise((resolve) => setTimeout(resolve, LIST_DELAY_MS));
    return route.fulfill({ json: { success: true, notifications: alerts(), unreadCount } });
  });
  return () => listReads;
}

type Frame = {
  t: number;
  headerHeight: number;
  subtitle: string;
  rows: number;
  placeholderRows: number;
  rowTops: number[];
  signInCard: boolean;
  markAll: 'none' | 'enabled' | 'disabled';
};

/**
 * Records, from the document's first frame, every frame whose drawing of Alerts differs from the
 * last: the header's height and subtitle, the rows of the list and of its placeholder, and Mark all
 * read. A row of the list is an alert's button; a placeholder's row is marked for this reading.
 */
const RECORDER = `(() => {
  const frames = [];
  window.__alertsFrames = frames;
  let last = '';
  const drawn = (element) => Boolean(element && element.getClientRects().length > 0);
  const top = (element) => Math.round(element.getBoundingClientRect().top + window.scrollY);
  function sample() {
    const heading = [...document.querySelectorAll('#main-content h1')].find((h) => h.textContent.trim() === 'Alerts');
    if (heading && drawn(heading)) {
      const header = heading.parentElement.parentElement;
      const rows = [...document.querySelectorAll('#main-content h3')]
        .filter((title) => /^E2E alert \\d+$/.test(title.textContent.trim()))
        .map((title) => title.closest('button'))
        .filter(drawn);
      const placeholderRows = [...document.querySelectorAll('[data-alerts-placeholder-row]')].filter(drawn);
      const markAll = [...document.querySelectorAll('#main-content button')]
        .find((button) => button.textContent.trim() === 'Mark all read' && drawn(button));
      const frame = {
        headerHeight: Math.round(header.getBoundingClientRect().height),
        subtitle: heading.nextElementSibling ? heading.nextElementSibling.textContent.trim() : '',
        rows: rows.length,
        placeholderRows: placeholderRows.length,
        rowTops: (rows.length ? rows : placeholderRows).slice(0, 3).map(top),
        signInCard: [...document.querySelectorAll('#main-content h3')]
          .some((title) => title.textContent.trim() === 'Sign in required' && drawn(title)),
        markAll: markAll ? (markAll.disabled ? 'disabled' : 'enabled') : 'none',
      };
      const key = JSON.stringify(frame);
      if (key !== last) {
        last = key;
        frames.push({ t: Math.round(performance.now()), ...frame });
      }
    }
    if (!window.__alertsFramesDone) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();`;

/**
 * Waits for React to own the shell and the page, and for Next's router: a click before then is a
 * full page load, which would measure another thing.
 */
async function hydrated(page: Page) {
  await page.waitForFunction(() => ['header.app-shell-header', '#main-content > *'].every((selector) => {
    const element = document.querySelector(selector);
    return Boolean(element && Object.keys(element).some((key) => key.startsWith('__reactFiber$')));
  }) && Boolean((window as unknown as { next?: { router?: unknown } }).next?.router), undefined, COLD_PAGE);
}

async function recordedFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const record = window as unknown as { __alertsFrames: Frame[]; __alertsFramesDone?: boolean };
    record.__alertsFramesDone = true;
    return record.__alertsFrames;
  });
}

async function resetRecording(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __alertsFrames: Frame[] }).__alertsFrames.length = 0;
  });
}

/** What the frames say once the list is drawn, and every frame from the page's first. */
function expectListArrivedInPlace(frames: Frame[]) {
  expect(frames.length, 'the page was drawn').toBeGreaterThan(0);
  const final = frames[frames.length - 1];
  expect(final.rows, JSON.stringify(final)).toBe(6);
  for (const frame of frames) {
    const shown = JSON.stringify(frame);
    // Never an empty body: the placeholder's rows hold the list's place until its rows arrive.
    expect(frame.signInCard, shown).toBe(false);
    expect(frame.rows + frame.placeholderRows, `the list's place is empty: ${shown}`).toBeGreaterThan(0);
    // Nothing above the list moves, and the rows arrive where the placeholder's stood.
    expect(Math.abs(frame.headerHeight - final.headerHeight), shown).toBeLessThanOrEqual(1);
    frame.rowTops.forEach((rowTop, index) => {
      expect(Math.abs(rowTop - final.rowTops[index]), `row ${index + 1} moved: ${shown}`).toBeLessThanOrEqual(1);
    });
  }
}

test('a click on Alerts draws the list\'s place from the first frame and the rows arrive in it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const listReads = await answerAlerts(page, 0);
  await page.addInitScript(RECORDER);
  // The Alerts route and its signed-in half compile first, then a light page of the shell. From
  // 768px the top bar's bell is Alerts' one control.
  await page.goto('/notifications', COLD_PAGE);
  await expect(page.getByRole('heading', { name: 'E2E alert 6' })).toBeVisible(COLD_PAGE);
  await page.goto('/developers/mcp', COLD_PAGE);
  const bell = page.getByRole('link', { name: 'Open alerts' });
  await expect(bell).toBeVisible(COLD_PAGE);
  await hydrated(page);
  const readsBefore = listReads();

  await resetRecording(page);
  await bell.click();
  await page.waitForURL('**/notifications');
  await expect(page.getByRole('heading', { name: 'E2E alert 6' })).toBeVisible();
  // The rows came from this visit's own read, answered late.
  expect(listReads()).toBeGreaterThan(readsBefore);
  const frames = await recordedFrames(page);

  expectListArrivedInPlace(frames);
  // Nothing is unread: Mark all read is never on offer, before the count or after it.
  for (const frame of frames) expect(frame.markAll, JSON.stringify(frame)).not.toBe('enabled');
  expect(frames[frames.length - 1].subtitle).toBe('0 unread alerts');
});

test('a phone\'s full load of Alerts draws its controls and the list\'s place before the session check', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  await answerAlerts(page, 0);
  await page.addInitScript(RECORDER);
  // Compiled once, so the measured load's first frames are the server's HTML and the stylesheet.
  await page.goto('/notifications', COLD_PAGE);
  await expect(page.getByRole('heading', { name: 'E2E alert 6' })).toBeVisible(COLD_PAGE);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'E2E alert 6' })).toBeVisible();
  const frames = await recordedFrames(page);

  expectListArrivedInPlace(frames);
  for (const frame of frames) expect(frame.markAll, JSON.stringify(frame)).not.toBe('enabled');
});

test('Mark all read neither acts nor lights up with nothing unread, and turns on once something is', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  let unread = 0;
  await page.route(/\/api\/mobile\/notifications(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('limit') !== '1') await new Promise((resolve) => setTimeout(resolve, 300));
    return route.fulfill({ json: { success: true, notifications: url.searchParams.get('limit') === '1' ? [] : alerts(), unreadCount: unread } });
  });
  let markAllRequests = 0;
  await page.route('**/api/mobile/notifications/read-all', (route) => {
    markAllRequests += 1;
    return route.fulfill({ json: { success: true } });
  });
  await page.goto('/notifications', COLD_PAGE);
  await expect(page.getByText('0 unread alerts')).toBeVisible(COLD_PAGE);

  const markAll = page.getByRole('button', { name: 'Mark all read' });
  await expect(markAll).toBeDisabled();
  const look = () => markAll.evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      color: style.color,
      background: style.backgroundColor,
      border: style.borderColor,
      opacity: style.opacity,
      cursor: style.cursor,
    };
  });
  const resting = await look();
  await markAll.hover({ force: true });
  // A pointer over it changes nothing: it is not a control that can be pressed now. Read once the
  // button's colour transition (150ms) would have run.
  await page.waitForTimeout(400);
  expect(await look()).toEqual(resting);
  expect(resting.cursor).not.toBe('pointer');
  await markAll.click({ force: true });
  expect(markAllRequests).toBe(0);

  // Something unread, read again by Refresh: the control turns on and acts.
  unread = 2;
  await page.getByRole('button', { name: 'Refresh alerts' }).click();
  await expect(page.getByText('2 unread alerts')).toBeVisible();
  await expect(markAll).toBeEnabled();
  expect(await look()).not.toEqual(resting);
  await markAll.click();
  await expect(page.getByText('0 unread alerts')).toBeVisible();
  expect(markAllRequests).toBe(1);
  await expect(markAll).toBeDisabled();
});
