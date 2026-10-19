import { expect, test, type Locator, type Page } from '@playwright/test';

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
  innerBottom: number | null;
};

function readFit(page: Page, inner?: string): Promise<Fit> {
  return page.evaluate((innerSelector) => {
    const html = document.documentElement;
    const main = document.getElementById('main-content')!;
    const root = [...main.children].find((element) => getComputedStyle(element).display !== 'none')!;
    const innerElement = innerSelector ? document.querySelector(innerSelector) : null;
    return {
      maxScroll: html.scrollHeight - html.clientHeight,
      bar: document.querySelector('header.app-shell-header')!.getBoundingClientRect().height,
      token: parseFloat(getComputedStyle(html).getPropertyValue('--app-shell-topbar-height')),
      // Where the page's background ends, and where the window ends less the
      // bottom navigation's room (main's padding below 768px, none above).
      rootBottom: root.getBoundingClientRect().bottom + window.scrollY,
      roomBottom: html.clientHeight - parseFloat(getComputedStyle(main).paddingBottom),
      innerBottom: innerElement ? innerElement.getBoundingClientRect().bottom + window.scrollY : null,
    };
  }, inner);
}

// Soft, so that a failure lists every width at once. `inner` names an element
// that must end where the page's root ends.
async function expectFitsAtEveryWidth(page: Page, inner?: { selector: string; name: string }) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const fit = await readFit(page, inner?.selector);
    expect.soft(fit.bar, `the top bar is its token at ${viewport.width}px`).toBe(fit.token);
    expect.soft(fit.maxScroll, `the page scrolls at ${viewport.width}px`).toBe(0);
    expect.soft(fit.rootBottom, `the page's background stops short of the window at ${viewport.width}px`)
      .toBeCloseTo(fit.roomBottom, 0);
    if (inner) {
      expect.soft(fit.innerBottom, `${inner.name} ends at the root's bottom at ${viewport.width}px`)
        .toBeCloseTo(fit.rootBottom, 0);
    }
  }
}

// On screen, and what the browser draws at its centre is the element itself,
// not the bottom navigation over it.
async function expectClearOfTheBottomNav(locator: Locator, name: string) {
  await expect(locator, `${name} is on screen`).toBeInViewport({ ratio: 1 });
  const drawnOnTop = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return Boolean(hit && element.contains(hit));
  });
  expect(drawnOnTop, `nothing covers ${name}`).toBe(true);
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
  // non-public-utilities.css. Contact is styled by globals.css alone. The
  // workflow library's root was sized by hand (`min-h-[calc(100vh-4rem)]`),
  // which the shell's rule passed by, so below 768px it left the page the
  // room taller than the window.
  for (const { route, heading, root } of [
    { route: '/notifications', heading: 'Alerts', root: /(^|\s)ui-page(\s|$)/ },
    { route: '/search', heading: 'Search the creator community', root: /(^|\s)min-h-screen(\s|$)/ },
    { route: '/contact', heading: 'Get in Touch', root: /(^|\s)ui-page(\s|$)/ },
    { route: '/create-workflow', heading: 'Your creation systems, at a glance.', root: /(^|\s)min-h-screen(\s|$)/ },
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

  // An address with no page, and a page that calls notFound() with no not-found
  // of its own (a comparison's), draw the app's not-found. Next's default one
  // sets `height: 100vh` inline, which no sheet rule overrides, so it overflowed
  // by the bar and the room (164px at 390px, 64px wider). The comparison's
  // metadata names it "Comparison Not Found"; the not-found's own title wins.
  for (const route of ['/no-page-at-this-address', '/alternatives/no-comparison-at-this-address']) {
    test(`${route} is a 404 no taller than the window`, async ({ page }) => {
      await page.setViewportSize(VIEWPORTS[0]);
      const response = await page.goto(route);
      expect(response?.status()).toBe(404);
      // Any heading first: Next's own page has another, and fails on its band.
      await expect(page.locator('#main-content h1')).toBeVisible();
      await expectFitsAtEveryWidth(page);
      await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
      // Read once, now that the browser has drawn the page and its head.
      expect(await page.title()).toMatch(/^Page not found \| /);
    });
  }
});

// The workflow canvas is an editor of a fixed height that never scrolls the
// page: `h-screen`, which the shell gives what it leaves (`.app-shell-content
// > .h-screen`). Sized by hand as 100vh less the bar, it ended at the window's
// bottom, under the bottom navigation, and the page scrolled by the room.
test.describe('the workflow pages in the app shell', () => {
  test('the workflow library\'s loading fallback is no taller than the window', async ({ page }) => {
    // The library's chunk is never answered, so next/dynamic's fallback stays.
    // The page is read once it commits, as a script still in flight would hold
    // its load event back for good.
    const held: string[] = [];
    await page.route(/WorkflowLibraryClient/, (route) => {
      held.push(route.request().url());
    });
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto('/create-workflow', { waitUntil: 'commit' });
    await expect(page.locator('#main-content > div > svg.animate-spin')).toBeVisible();
    await expect.poll(() => held.length, { message: 'the library chunk is asked for and held' }).toBeGreaterThan(0);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
      .every((link) => link.sheet));
    await expectFitsAtEveryWidth(page);
  });

  test('the workflow canvas fills what the shell leaves and never scrolls the page', async ({ page }) => {
    const canvas = {
      id: 'canvas-1',
      title: 'Workflow canvas',
      updated_at: '2026-03-30T04:00:00.000Z',
      revision: 0,
      graph: { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
    };
    await page.route('**/api/workflow-canvases', (route) => route.fulfill({
      json: { canvases: [{ id: canvas.id, title: canvas.title, updated_at: canvas.updated_at, revision: canvas.revision }] },
    }));
    await page.route('**/api/workflow-canvases/*', (route) => (
      route.request().method() === 'GET' ? route.fulfill({ json: { canvas } }) : route.abort()
    ));
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto(`/create-workflow?canvas=${canvas.id}`);
    await expect(page.getByTestId('workflow-canvas-header')).toBeVisible();
    // A height, not a minimum: the editor's work area reaches its bottom.
    await expectFitsAtEveryWidth(page, { selector: '[role="application"]', name: 'the work area' });
    // An editor that does not fit has nothing to press below: stop here.
    expect(test.info().errors, 'the editor fits at every width').toHaveLength(0);

    // Below 768px its phone controls clear the bottom navigation: the node
    // library's opener, and the AI Builder's submit row once its popup is
    // scrolled down (from its title, outside the popup's message list).
    await page.setViewportSize(VIEWPORTS[0]);
    await expectClearOfTheBottomNav(page.getByRole('button', { name: 'Open node library' }), 'the node library opener');
    await page.getByTestId('workflow-assistant-trigger').click({ timeout: 10_000 });
    const popup = page.getByTestId('workflow-assistant-popup');
    await popup.getByText('AI Builder', { exact: true }).hover({ timeout: 10_000 });
    await page.mouse.wheel(0, 2000);
    await expectClearOfTheBottomNav(
      popup.getByRole('button', { name: /^(Build proposal|Setup required)$/ }),
      'the AI Builder submit row',
    );

    // On a window too short to leave the editor 20rem (a phone held sideways,
    // its URL bar showing) the editor keeps 20rem and the page scrolls instead.
    await page.setViewportSize({ width: 740, height: 304 });
    const workArea = await page.getByRole('application').boundingBox();
    expect(workArea?.height, 'the work area on a short window').toBeGreaterThan(150);
  });
});
