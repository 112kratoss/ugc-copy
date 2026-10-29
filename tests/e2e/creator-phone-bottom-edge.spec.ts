import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * The phone-width web while creating (the owner's decision, 2026-10-28: "Hide it while creating";
 * PR 5 of the creator redesign). Below 768px the image, video and motion creators hide the shell's
 * bottom navigation; the creator's own bar holds the window's bottom edge where it floated over
 * the navigation, the safe area inside it; and the top bar's menu reaches every page the
 * navigation did. From 768px no page has the bottom navigation, and every other page keeps it.
 *
 * The shell's rule and its stylesheet are app-shell-client.test.tsx and
 * app-shell-bottom-nav-while-creating.test.ts; this draws them in a browser at 390px and at the
 * 767/768 edge. The safe area is Chromium's override of `env(safe-area-inset-bottom)`.
 */

const CREATORS = ['/create-video', '/create-image', '/create-motion'] as const;
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 90_000 };
// Short enough that each creator's column runs past the window, so its bar is held at the foot.
const SHORT_WINDOW = 600;
const SAFE_AREA_BOTTOM = 34;

test.describe.configure({ timeout: 240_000 });

async function open(page: Page, path: string) {
  await page.goto(path);
  // `next dev` draws its badge over the bottom-left corner.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

function bottomNav(page: Page) {
  return page.locator('nav.app-shell-bottom-nav');
}

function creatorBar(page: Page) {
  return page.locator('[data-creator-bar]');
}

/** The bar's main button, for a visitor (Sign up to generate) or an account (Generate · N credits). */
function barAction(page: Page) {
  return creatorBar(page).getByRole('button', { name: /^(Sign up to generate|Generate)/ });
}

// On screen, and what the browser draws along its middle is the element itself, not anything over it.
async function expectPressable(locator: Locator, name: string, { ratio = 1 } = {}) {
  await expect(locator, `${name} is on screen`).toBeInViewport({ ratio });
  const covered = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const inset = Math.min(box.height / 2, box.width / 2);
    const y = box.top + box.height / 2;
    return Array.from({ length: 7 }, (_, i) => box.left + inset + ((box.width - 2 * inset) * i) / 6).flatMap((x) => {
      const hit = document.elementsFromPoint(x, y).find((candidate) => !candidate.closest('nextjs-portal'));
      return hit && element.contains(hit) ? [] : [`${Math.round(x)}px: ${hit?.className || 'nothing'}`];
    });
  });
  expect.soft(covered, `what is drawn over ${name}`).toEqual([]);
}

/** Every control outside the bars that a bar covers, with the page scrolled to its end. */
function controlsUnderTheBarsAtTheEnd(page: Page) {
  return page.evaluate(async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bars = [...document.querySelectorAll('[data-creator-bar], [data-testid="creator-publish-bar"]')]
      .map((bar) => bar.getBoundingClientRect())
      .filter((box) => box.height > 0);
    return [...document.querySelectorAll<HTMLElement>('main a[href], main button, main input, main textarea')]
      .filter((element) => !element.closest('[data-creator-bar], [data-testid="creator-publish-bar"]'))
      .flatMap((element) => {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return [];
        const under = bars.some((bar) => box.bottom > bar.top + 1 && box.top < bar.bottom - 1 && box.right > bar.left && box.left < bar.right);
        return under ? [(element.getAttribute('aria-label') ?? element.textContent ?? element.tagName).trim().slice(0, 40)] : [];
      });
  });
}

for (const width of [390, 767]) {
  test(`at ${width}px the creators hide the bottom navigation, and their bar holds the bottom edge with the safe area inside it`, async ({ page }) => {
    await page.setViewportSize({ width, height: SHORT_WINDOW });
    const cdp = await page.context().newCDPSession(page);
    // Every side set: an inset left unset is undefined, not 0, and a rule that reads it is dropped.
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: SAFE_AREA_BOTTOM } });

    for (const path of CREATORS) {
      await open(page, path);
      await expect(barAction(page), `${path}: the bar draws`).toBeVisible(COLD_PAGE);
      await expect(bottomNav(page), `${path}: no bottom navigation`).toBeHidden();

      const bar = creatorBar(page);
      const box = await bar.evaluate((element) => {
        const surface = element.firstElementChild!;
        return {
          gap: window.innerHeight - element.getBoundingClientRect().bottom,
          safeArea: getComputedStyle(surface).paddingBottom,
        };
      });
      expect(box.gap, `${path}: the bar ends on the window's bottom edge`).toBeCloseTo(0, 0);
      expect(box.safeArea, `${path}: the safe area is inside the bar`).toBe(`${SAFE_AREA_BOTTOM}px`);
      const actionBottom = await barAction(page).evaluate((element) => element.getBoundingClientRect().bottom);
      expect(actionBottom, `${path}: the bar's button clears the safe area`).toBeLessThanOrEqual(SHORT_WINDOW - SAFE_AREA_BOTTOM);
      await expectPressable(barAction(page), `${path}: the bar's button`);
      expect(await controlsUnderTheBarsAtTheEnd(page), `${path}: what the bar covers at the page's end`).toEqual([]);
    }
  });
}

test('from 768px no page has the bottom navigation, and the creator\'s bar floats just above the edge as before', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: SHORT_WINDOW });
  await open(page, '/create-video');
  await expect(barAction(page)).toBeVisible(COLD_PAGE);
  await expect(bottomNav(page)).toBeHidden();
  const gap = await creatorBar(page).evaluate((element) => window.innerHeight - element.getBoundingClientRect().bottom);
  expect(gap, 'the bar floats 0.75rem above the edge').toBeCloseTo(12, 0);
});

test('every other page keeps the bottom navigation below 768px', async ({ page, context }) => {
  // Signed in, so the workflow canvas draws its library: its path starts as the creators' do.
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  for (const width of [390, 767]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/showcase', '/notifications', '/create-workflow']) {
      await open(page, path);
      await expect(bottomNav(page), `${path} at ${width}px`).toBeVisible(COLD_PAGE);
      await expect(page.locator('.app-shell-root')).not.toHaveAttribute('data-bottom-nav');
    }
  }
});

test('on the creators the top bar\'s menu reaches every page the bottom navigation did', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pathnames = (links: Locator) => links.evaluateAll((elements) => elements.map((link) => new URL((link as HTMLAnchorElement).href).pathname));

  // What the navigation reaches on Explore: its tabs, and the two choices of the Create menu its + opens.
  await open(page, '/showcase');
  const nav = bottomNav(page);
  await expect(nav).toBeVisible(COLD_PAGE);
  const tabs = await pathnames(nav.getByRole('link'));
  expect(tabs).toEqual(['/', '/showcase', '/notifications', '/profile']);
  await nav.getByRole('button', { name: 'Create' }).click();
  const createMenu = page.getByRole('dialog', { name: 'Create or publish' });
  await expect(createMenu).toBeVisible();
  const choices = await pathnames(createMenu.getByRole('link'));
  expect(choices).toEqual(['/create', '/post/new']);

  for (const path of CREATORS) {
    await open(page, path);
    await expect(barAction(page)).toBeVisible(COLD_PAGE);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();
    const places = await pathnames(drawer.getByRole('link'));
    for (const place of [...tabs, ...choices, '/marketplace', '/creations', '/create-workflow']) {
      expect(places, `${path}: the menu reaches ${place}`).toContain(place);
    }
    for (const link of await drawer.getByRole('link').all()) {
      await link.scrollIntoViewIfNeeded();
      await expectPressable(link, `${path}: the menu's ${(await link.textContent())?.trim()}`);
    }
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  }

  // And a place only the navigation held, followed from a creator: Alerts, where it is back.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name: 'Alerts' }).click();
  await expect(page).toHaveURL(/\/notifications$/, COLD_PAGE);
  await expect(bottomNav(page)).toBeVisible(COLD_PAGE);
});

test.describe('signed in', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  });

  test('the model picker\'s phone sheet stands above the bottom edge, and its last model can be pressed', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, '/create-image');
    // The model chip at the head of the creator's column.
    const trigger = page.locator('button[aria-haspopup="listbox"]');
    await expect(trigger).toBeVisible(COLD_PAGE);
    await trigger.click();
    const sheet = page.getByTestId('studio-model-picker');
    await expect(sheet).toBeVisible();
    // Its entrance has run: it is where it settles.
    await expect.poll(() => sheet.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    const models = sheet.getByRole('option');
    await expect.poll(() => models.count(), { message: 'the picker lists models', timeout: 15_000 }).toBeGreaterThan(3);
    expect(await sheet.evaluate((element) => window.innerHeight - element.getBoundingClientRect().bottom), 'the sheet ends 1rem above the edge')
      .toBeCloseTo(16, 0);
    await sheet.getByRole('listbox').evaluate((list) => { list.scrollTop = list.scrollHeight; });
    await expectPressable(models.last(), 'the last model', { ratio: 0.95 });
  });

  // The column keeps its settings and Generate in a bar at the window's foot (sticky, layer 30,
  // inside the page's own layer 10). Its settings open above it, as tall as the window has between
  // the top bar and the bar: a short phone put a fixed-height panel's first rows under the top bar.
  test('the image creator\'s settings open between the top bar and the bar on the bottom edge', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 560 });
    // The price is answered once the settings are open: the line that says it could not be read
    // arrives over the buttons and makes the bar taller, and the open panel must still fit.
    const heldQuotes: Array<() => void> = [];
    await page.route('**/api/generation-models/quote', (route) =>
      new Promise<void>((answer) => heldQuotes.push(answer)).then(() =>
        route.fulfill({ status: 401, json: { error: 'Unauthorized' } })));
    await open(page, '/create-image');
    const bar = creatorBar(page);
    const generate = bar.getByRole('button', { name: /^Generate · / });
    await expect(generate).toBeVisible(COLD_PAGE);
    const chip = bar.getByRole('button', { name: /^Generation settings/ });
    await expectPressable(chip, 'the settings chip');
    await expectPressable(generate, 'Generate');
    expect(await bar.evaluate((element) => window.innerHeight - element.getBoundingClientRect().bottom), 'the bar ends on the edge')
      .toBeCloseTo(0, 0);

    await chip.click();
    const panel = page.getByRole('dialog', { name: 'Generation settings' });
    await expect(panel).toBeFocused();
    await expect.poll(() => panel.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    const headerBottom = await page.locator('.app-shell-header').evaluate((header) => header.getBoundingClientRect().bottom);
    const expectBetweenTheBars = async (when: string) => {
      // Polled: the panel fits again a frame after the bar changes height.
      await expect.poll(() => panel.evaluate((element) => element.getBoundingClientRect().top), {
        message: `the panel starts below the top bar ${when}`,
      }).toBeGreaterThanOrEqual(headerBottom);
      expect(await panel.evaluate((element) => element.getBoundingClientRect().bottom), `the panel ends above the bar ${when}`)
        .toBeLessThanOrEqual(await bar.evaluate((element) => element.getBoundingClientRect().top));
      await expectPressable(panel.getByRole('button', { name: 'Close settings' }), `Close settings ${when}`);
      await expectPressable(panel.getByRole('radio').first(), `the first aspect ratio ${when}`);
    };
    await expectBetweenTheBars('as it opens');

    const barHeight = () => bar.evaluate((element) => element.getBoundingClientRect().height);
    const plainBarHeight = await barHeight();
    await expect.poll(() => heldQuotes.length, { message: 'the price is being asked for' }).toBeGreaterThan(0);
    heldQuotes.splice(0).forEach((answer) => answer());
    await expect(bar.getByRole('button', { name: 'Retry quote' })).toBeVisible();
    expect(await barHeight(), 'the line made the bar taller').toBeGreaterThan(plainBarHeight);
    await expect(panel).toBeVisible();
    await expectBetweenTheBars('once the bar grew under it');

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(chip).toBeFocused();
  });
});

function base64url(value: string) {
  return Buffer.from(value).toString('base64url');
}

// The E2E user (src/lib/e2e-auth.ts) as Supabase's auth describes them to the browser, so the
// shell's run toasts (GenerationNotifications) start for an account.
async function signInTheBrowser(context: BrowserContext) {
  const user = {
    id: 'workflow-user', aud: 'authenticated', role: 'authenticated', email: 'workflow-user@example.com', is_anonymous: false,
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [],
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  const expiresAt = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const session = {
    access_token: [
      base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
      base64url(JSON.stringify({ sub: user.id, aud: 'authenticated', role: 'authenticated', exp: expiresAt, email: user.email, is_anonymous: false, session_id: 'e2e-session' })),
      'e2e-signature',
    ].join('.'),
    token_type: 'bearer', expires_in: 365 * 24 * 3600, expires_at: expiresAt, refresh_token: 'e2e-refresh-token', user,
  };
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  await context.addInitScript((value) => {
    document.cookie = `${value}; path=/; SameSite=Lax`;
  }, `sb-example-auth-token=base64-${base64url(JSON.stringify(session))}`);
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

// A run that ends while a creator is open: the shell's toast for it ("Video ready") rose from the
// bottom edge over the bar, and on a phone covered Publish whole. On the creators, in one column,
// it comes down from under the top bar.
test('a run\'s toast comes down under the top bar on a creator, clear of its bar', async ({ page, context }) => {
  await signInTheBrowser(context);
  await page.route('**/api/**', (route) => {
    // The made-up session's token means nothing to the dev server: requests go without it.
    const headers = { ...route.request().headers() };
    delete headers.authorization;
    return route.continue({ headers });
  });
  let statusPolls = 0;
  await page.route('**/api/generations?detail=status**', (route) => {
    statusPolls += 1;
    const status = statusPolls === 1 ? 'processing' : 'succeeded';
    return route.fulfill({ json: { generations: [{
      id: 'gen-e2e', status, category: 'video', model: 'seedance-2-mini',
      created_at: '2026-10-30T00:00:00.000Z', completed_at: status === 'succeeded' ? '2026-10-30T00:01:00.000Z' : null,
    }] } });
  });
  await page.setViewportSize({ width: 390, height: SHORT_WINDOW });
  await open(page, '/create-video');
  await expect(barAction(page)).toBeVisible(COLD_PAGE);
  await expect.poll(() => statusPolls, { message: 'the shell reads the runs once signed in', timeout: 30_000 }).toBeGreaterThan(0);
  // The shell reads them again when the page comes back into view.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const toasts = page.getByTestId('generation-notifications');
  await expect(toasts.getByRole('button', { name: 'Dismiss notification' })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => toasts.evaluate((element) => getComputedStyle(element.firstElementChild!).opacity)).toBe('1');

  const headerBottom = await page.locator('.app-shell-header').evaluate((header) => header.getBoundingClientRect().bottom);
  const toastBox = await toasts.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  });
  expect(toastBox.top, 'the toast starts below the top bar').toBeGreaterThanOrEqual(headerBottom);
  expect(toastBox.bottom, 'the toast ends above the bar').toBeLessThanOrEqual(
    await creatorBar(page).evaluate((element) => element.getBoundingClientRect().top),
  );
  await expectPressable(barAction(page), 'the bar\'s button under a toast');
  await expectPressable(toasts.getByRole('link', { name: 'View Studio' }), 'the toast\'s link');
});
