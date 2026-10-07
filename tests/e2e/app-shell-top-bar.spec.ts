import { expect, test, type Page } from '@playwright/test';

// The app shell's top bar must fit its row at every width that shows the side
// navigation. Its controls on the right keep their size and the search field
// gives way: below 1024px the field folds into its search button and
// "New creation" into its icon. Before, the controls gave way instead. On a
// signed-out visit to /showcase at 1024px the alerts button shrank to 20px,
// "New creation" and "Sign in" each broke onto two lines, and "Sign in" ran 33px
// past the window, so the page scrolled sideways.
//
// Headless Chromium hides scrollbars. Keeping them leaves the row 15px less than
// the width the media queries see: the tighter case, and what a visitor on
// Windows, on Linux or on a Mac with a mouse attached has.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const WIDTHS = [768, 900, 1024, 1100, 1180, 1280];

type TopBar = {
  clientWidth: number;
  scrollWidth: number;
  headerRight: number;
  controls: { name: string; right: number; width: number; lines: number }[];
};

function readTopBar(page: Page): Promise<TopBar> {
  return page.locator('header.app-shell-header').evaluate((header) => {
    const lineCount = (element: Element) => {
      const tops = new Set<number>();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
      }
      return tops.size;
    };
    const controls = [...(header.lastElementChild?.children ?? [])]
      .filter((element) => getComputedStyle(element).display !== 'none')
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName,
          right: rect.right,
          width: rect.width,
          lines: lineCount(element),
        };
      });
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      headerRight: header.getBoundingClientRect().right,
      controls,
    };
  });
}

test.describe('app shell top bar', () => {
  // /showcase is styled by globals.css alone. /search also loads
  // non-public-utilities.css, whose own .hidden comes later in the cascade and
  // once hid "New creation" there at every width.
  for (const route of ['/showcase', '/search']) {
    test(`fits a signed-out visitor's window on ${route}`, async ({ page }) => {
      await page.setViewportSize({ width: WIDTHS[0], height: 800 });
      await page.goto(route);
      // A short page shows no scrollbar; the feeds this guards are long.
      await page.addStyleTag({ content: 'html { overflow-y: scroll; }' });
      const header = page.locator('header.app-shell-header');
      await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await expect(header.getByRole('link', { name: 'New creation' })).toBeVisible();
        const bar = await readTopBar(page);
        expect(bar.scrollWidth, `the page scrolls sideways at ${width}px`).toBeLessThanOrEqual(bar.clientWidth);
        for (const control of bar.controls) {
          expect(control.right, `${control.name} runs past the top bar at ${width}px`)
            .toBeLessThanOrEqual(bar.headerRight + 0.5);
          expect(control.width, `${control.name} is squeezed at ${width}px`).toBeGreaterThanOrEqual(48);
          expect(control.lines, `${control.name} wraps at ${width}px`).toBeLessThanOrEqual(1);
        }
      }
    });
  }
});
