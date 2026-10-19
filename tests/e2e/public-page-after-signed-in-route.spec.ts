import { expect, test, type Page } from '@playwright/test';

// A signed-in route's layout links non-public-utilities.css, and React keeps a
// stylesheet it has inserted for the rest of the visit, so a public page that a
// client navigation opens from such a route is drawn with both sheets. The
// supplement comes second and shares the utilities layer. While it scanned only
// what the signed-in routes draw, a base utility it held outranked a breakpoint
// rule that only globals.css held, and the page kept its phone sizes on a laptop
// until a reload: Pricing's top padding 40px for 56px, the blog's sides 24px for
// 48px and its title 36px for 48px. Now the supplement scans every route, so its
// own order decides (`route-style-two-sheet-order.test.ts` holds the classes).
//
// Each case opens Alerts, follows a client navigation to a public page, and reads
// every element of it against the same page after a reload.

// Properties utility classes set whose computed value no fetched text changes.
// Used widths and heights depend on that text (Pricing's credit balance differs
// between the two loads), and hover and open states are not drawn at rest; the
// unit tests cover those classes.
const PROPERTIES = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'order',
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'align-items', 'justify-content',
  'row-gap', 'column-gap', 'grid-template-columns', 'grid-column-start', 'grid-column-end',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'min-width', 'max-width', 'min-height', 'max-height', 'aspect-ratio', 'overflow-x', 'overflow-y',
  'font-size', 'line-height', 'font-weight', 'letter-spacing', 'text-align',
  'color', 'background-color', 'box-shadow', 'border-top-left-radius', 'border-bottom-right-radius',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-color',
  'visibility',
];
const WIDTHS = [390, 768, 1440];
// In `next dev` a page compiles on its first request, and offline Pricing's
// server render waits about 9 seconds for the referral terms read to give up.
const COLD_PAGE = { timeout: 45_000 };

type Drawing = Record<number, { name: string; values: string[] }[]>;

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
});

/**
 * Waits for React to own the shell and the page. Next exposes its router before
 * hydration, and a push before then is dropped; a node read before it can still
 * be replaced.
 */
async function hydrated(page: Page) {
  await page.waitForFunction(() => ['header.app-shell-header', '#main-content > *'].every((selector) => {
    const element = document.querySelector(selector);
    return Boolean(element && Object.keys(element).some((key) => key.startsWith('__reactFiber$')));
  }), undefined, COLD_PAGE);
}

/** Waits for every finite animation and transition: a fade in progress is not the page's drawing. */
async function settled(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => (
    animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity
  )));
}

/** Each element of the page at each width: its tag and classes, and the properties above. */
async function readDrawing(page: Page): Promise<Drawing> {
  const drawing: Drawing = {};
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await settled(page);
    drawing[width] = await page.evaluate((properties) => [...document.querySelectorAll('#main-content *')].map((element) => {
      const style = getComputedStyle(element);
      return {
        name: [element.tagName.toLowerCase(), ...element.classList].join('.'),
        values: properties.map((property) => style.getPropertyValue(property)),
      };
    }), PROPERTIES);
    expect(drawing[width].length, `the page draws its content in #main-content at ${width}px`).toBeGreaterThan(20);
  }
  return drawing;
}

function differences(reloaded: Drawing, navigated: Drawing): string[] {
  return WIDTHS.flatMap((width) => {
    if (reloaded[width].length !== navigated[width].length) {
      return [`${width}px: ${navigated[width].length} elements after the client navigation, ${reloaded[width].length} after a reload`];
    }
    return navigated[width].flatMap(({ name, values }, index) => {
      const other = reloaded[width][index];
      if (other.name !== name) return [`${width}px element ${index}: ${name} after the client navigation, ${other.name} after a reload`];
      return values.flatMap((value, column) => (value === other.values[column] ? [] : [
        `${width}px ${name} ${PROPERTIES[column]}: ${value} after the client navigation, ${other.values[column]} after a reload`,
      ]));
    });
  });
}

/** The document's stylesheets, by path: `next dev` links them, a production build inlines them. */
function stylesheets(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"], style[data-href]')].map((node) => (
    new URL(node.getAttribute('href') ?? node.getAttribute('data-href') ?? '', window.location.href).pathname
  )));
}

/** True while the page is still the window Alerts opened, so nothing since was a page load. */
function stillTheWindowAlertsOpened(page: Page) {
  return page.evaluate(() => (window as unknown as { openedOnAlerts?: boolean }).openedOnAlerts === true);
}

for (const { route, heading } of [
  { route: '/pricing', heading: 'Simple, transparent pricing' },
  { route: '/blog', heading: 'Blog & Resources' },
]) {
  test(`${route}, opened from Alerts by a client navigation, draws as it does after a reload`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { level: 1, name: 'Alerts' })).toBeVisible(COLD_PAGE);
    await hydrated(page);
    await page.evaluate(() => { (window as unknown as { openedOnAlerts: boolean }).openedOnAlerts = true; });

    // What a link does: Next's router, in the same window.
    await page.evaluate((href) => (
      window as unknown as { next: { router: { push: (href: string) => void } } }
    ).next.router.push(href), route);
    await expect(page).toHaveURL(new RegExp(`${route}$`), COLD_PAGE);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible(COLD_PAGE);
    await hydrated(page);
    const navigated = await readDrawing(page);
    const sheetsAfterNavigation = await stylesheets(page);
    // Read in the window Alerts opened, all of it: a client navigation, and no reload since.
    expect(await stillTheWindowAlertsOpened(page)).toBe(true);

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible(COLD_PAGE);
    await hydrated(page);
    const reloaded = await readDrawing(page);
    const sheetsAfterReload = await stylesheets(page);

    // The supplement Alerts linked was still in the document, so the page was drawn with both sheets.
    expect(sheetsAfterNavigation.filter((sheet) => !sheetsAfterReload.includes(sheet))).not.toEqual([]);
    expect(differences(reloaded, navigated)).toEqual([]);
  });
}
