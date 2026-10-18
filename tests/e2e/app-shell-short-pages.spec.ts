import { expect, test, type Page } from '@playwright/test';

// A short page is no taller than the window. Page roots fill the window with
// `min-h-screen` or `.ui-page` (100vh), but inside the app shell a root sits
// under the sticky top bar and, below 768px, above the bottom navigation's
// room. So every short page was one bar taller than the window (165px at 390px,
// with the room), and a trackpad nudge or Space moved its top under the bar
// over nothing. The bar itself came to 65px, or 67px with the search field,
// against its 64px token. Now the bar is exactly the token, and the shell gives
// a page root what it leaves of the window (`.app-shell-content .ui-page` and
// `.app-shell-content > .min-h-screen` in globals.css).

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

type Fit = {
  maxScroll: number;
  bar: number;
  token: number;
  rootBottom: number;
  roomBottom: number;
};

function readFit(page: Page): Promise<Fit> {
  return page.evaluate(() => {
    const html = document.documentElement;
    const main = document.getElementById('main-content')!;
    const root = [...main.children].find((element) => getComputedStyle(element).display !== 'none')!;
    return {
      maxScroll: html.scrollHeight - html.clientHeight,
      bar: document.querySelector('header.app-shell-header')!.getBoundingClientRect().height,
      token: parseFloat(getComputedStyle(html).getPropertyValue('--app-shell-topbar-height')),
      // Where the page's background ends, and where the window ends less the
      // bottom navigation's room (main's padding below 768px, none above).
      rootBottom: root.getBoundingClientRect().bottom + window.scrollY,
      roomBottom: html.clientHeight - parseFloat(getComputedStyle(main).paddingBottom),
    };
  });
}

// Soft, so that a failure lists every width at once.
async function expectFitsAtEveryWidth(page: Page) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const fit = await readFit(page);
    expect.soft(fit.bar, `the top bar is its token at ${viewport.width}px`).toBe(fit.token);
    expect.soft(fit.maxScroll, `the page scrolls at ${viewport.width}px`).toBe(0);
    expect.soft(fit.rootBottom, `the page's background stops short of the window at ${viewport.width}px`)
      .toBeCloseTo(fit.roomBottom, 0);
  }
}

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
});

test.describe('a short page in the app shell', () => {
  test('Alerts, short at every width, does not scroll', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { level: 1, name: 'Alerts' })).toBeVisible();
    await expectFitsAtEveryWidth(page);
  });

  // Each page is emptied, so that it is short at every width whatever it shows.
  // Alerts' root is `.ui-page` with a `min-h-[calc(100dvh-64px)]` of its own that
  // lost to `.ui-page`'s 100vh, Search's is `min-h-screen`; both routes add
  // non-public-utilities.css. Contact is styled by globals.css alone.
  for (const { route, heading, root } of [
    { route: '/notifications', heading: 'Alerts', root: /(^|\s)ui-page(\s|$)/ },
    { route: '/search', heading: 'Search the creator community', root: /(^|\s)min-h-screen(\s|$)/ },
    { route: '/contact', heading: 'Get in Touch', root: /(^|\s)ui-page(\s|$)/ },
  ]) {
    test(`${route} emptied is no taller than the window`, async ({ page }) => {
      await page.setViewportSize(VIEWPORTS[0]);
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.locator('#main-content > div').first()).toHaveClass(root);
      await page.addStyleTag({ content: '#main-content > * > * { display: none !important; }' });
      await expectFitsAtEveryWidth(page);
    });
  }
});
