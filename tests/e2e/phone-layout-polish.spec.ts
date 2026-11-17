import { expect, test, type Page } from '@playwright/test';

// Five small phone-layout defects from the live sweep of 2026-11-17, each measured at the widths a
// phone has (320, 360, 375, 390, 414):
// - The top bar's page title was cut to "Crea…" on /creators/magicbooklet: the "Sign in" pill takes the
//   room. A title is drawn whole or not at all, since every page has a heading of its own.
// - Marketplace's search placeholder read "Search prompts, tools, creat".
// - /contact's footer links were 20px tall, and Marketplace's "Filter tools" box focused only on its
//   19px input, not on a tap in the rest of the box.
// - /login held a second, hidden and empty <h1>, the email form's title while the choices show.

const WIDTHS = [320, 360, 375, 390, 414];
const COLD_PAGE = { timeout: 45_000 };

test.describe.configure({ timeout: 180_000 });

type TitleRead = {
  text: string;
  /** Whether the whole title is inside the box it is drawn in. */
  whole: boolean;
  /** Whether it is left out of sight entirely (no part of it shows). */
  gone: boolean;
  clientWidth: number;
  scrollWidth: number;
  docOverflow: number;
};

function readTitle(page: Page): Promise<TitleRead | null> {
  return page.evaluate(() => {
    const box = document.querySelector('header.app-shell-header [data-app-shell-title]');
    if (!box) return null;
    const label = box.querySelector('span') ?? box;
    const text = label.textContent?.trim() ?? '';
    const range = document.createRange();
    range.selectNodeContents(label);
    const rect = range.getBoundingClientRect();
    const frame = box.getBoundingClientRect();
    const slack = 0.75;
    const whole = rect.left >= frame.left - slack && rect.right <= frame.right + slack
      && rect.top >= frame.top - slack && rect.bottom <= frame.bottom + slack;
    const gone = rect.left >= frame.right - slack || rect.top >= frame.bottom - slack || frame.width < 1;
    const style = getComputedStyle(box);
    const clipped = style.visibility === 'hidden' || style.display === 'none';
    return {
      text,
      whole: whole && !clipped,
      gone: gone || clipped,
      clientWidth: (box as HTMLElement).clientWidth,
      scrollWidth: (box as HTMLElement).scrollWidth,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

const TITLE_PAGES = ['/creators/magicbooklet', '/contact', '/blog', '/alternatives', '/ai-image-generator', '/ai-video-generator', '/ai-motion-transfer', '/templates/new'];

for (const signedIn of [false, true]) {
  test.describe(`top bar title, ${signedIn ? 'signed in' : 'signed out'}`, () => {
    test('is never cut off, at any phone width', async ({ page, baseURL }) => {
      if (signedIn) {
        await page.context().addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: baseURL! }]);
      }
      const cut: string[] = [];
      const shownAt: Record<string, number[]> = {};
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 812 });
        for (const path of TITLE_PAGES) {
          await page.goto(path, { waitUntil: 'domcontentloaded', ...COLD_PAGE });
          await page.locator('header.app-shell-header').waitFor(COLD_PAGE);
          const read = await readTitle(page);
          if (!read) continue;
          if (read.docOverflow > 0) cut.push(`${path} @${width}: page scrolls sideways by ${read.docOverflow}px`);
          if (!read.whole && !read.gone) cut.push(`${path} @${width}: "${read.text}" is cut off (${read.scrollWidth}px of ${read.clientWidth}px)`);
          if (read.whole) (shownAt[path] ??= []).push(width);
        }
      }
      expect(cut).toEqual([]);
      // Dropping the title is for a bar with no room: a bar that has the room keeps it.
      expect(shownAt['/contact'] ?? []).toContain(414);
    });
  });
}

/** The placeholder of every visible search box of the storefront's own (not the top bar's), measured. */
async function placeholderMisfits(page: Page, width: number) {
  return page.evaluate((at) => {
    const out: string[] = [];
    for (const field of document.querySelectorAll<HTMLInputElement>('main input[type="search"], main input:not([type])')) {
      if (field.getAttribute('role') === 'combobox' || !field.placeholder || field.offsetParent === null) continue;
      const style = getComputedStyle(field);
      const probe = document.createElement('span');
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${style.font};letter-spacing:${style.letterSpacing}`;
      probe.textContent = field.placeholder;
      document.body.appendChild(probe);
      const text = probe.getBoundingClientRect().width;
      probe.remove();
      const room = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (text > room) out.push(`@${at}: "${field.placeholder}" is ${Math.round(text)}px in ${Math.round(room)}px`);
    }
    return out;
  }, width);
}

test.describe('Marketplace on a phone', () => {
  test('its search placeholder fits its field, before and after the page goes live', async ({ page }) => {
    const misfits: string[] = [];
    let seen = 0;
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 812 });
      await page.goto('/marketplace', { waitUntil: 'domcontentloaded', ...COLD_PAGE });
      await page.locator('main input[name="q"]:not([role="combobox"])').first().waitFor(COLD_PAGE);
      seen += await page.locator('main input[name="q"]:not([role="combobox"]):visible').count();
      misfits.push(...(await placeholderMisfits(page, width)));
    }
    expect(seen).toBeGreaterThan(0);
    expect(misfits).toEqual([]);
  });

  test('"Filter tools" is a target of at least 24px that a tap anywhere in its box focuses', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/marketplace', { waitUntil: 'domcontentloaded', ...COLD_PAGE });
    const summary = page.locator('details summary', { hasText: 'All tools' }).first();
    const filter = page.getByLabel('Filter tools');
    // The page is a shell that goes live when the reader scrolls; the filter box exists only then.
    await expect(async () => {
      await page.mouse.wheel(0, 300);
      await page.mouse.wheel(0, -300);
      if (!(await filter.isVisible())) {
        const filters = page.getByRole('button', { name: 'Filters' });
        if ((await filters.getAttribute('aria-expanded')) !== 'true') await filters.click({ timeout: 2000 });
        const open = await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open);
        if (!open) await summary.click({ timeout: 2000 });
      }
      await expect(filter).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 40_000 });
    const box = await filter.evaluate((element) => {
      const row = element.parentElement!.getBoundingClientRect();
      return { x: row.x, y: row.y, width: row.width, height: row.height };
    });
    expect(box.height).toBeGreaterThanOrEqual(24);
    // The search icon at the box's left, and the padding above and below the input.
    for (const point of [{ x: box.x + 14, y: box.y + box.height / 2 }, { x: box.x + box.width - 6, y: box.y + box.height / 2 }, { x: box.x + box.width / 2, y: box.y + 2 }, { x: box.x + box.width / 2, y: box.y + box.height - 2 }]) {
      await filter.evaluate((element) => (element as HTMLInputElement).blur());
      await page.mouse.click(point.x, point.y);
      await expect(filter, `a tap at ${Math.round(point.x)},${Math.round(point.y)}`).toBeFocused();
    }
  });
});

test.describe('/contact footer', () => {
  test('its three links are 24px targets and the footer does not move', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/contact', { waitUntil: 'domcontentloaded', ...COLD_PAGE });
    const footer = page.locator('div.border-t.border-zinc-800').last();
    await footer.waitFor(COLD_PAGE);
    const heights: Record<string, number> = {};
    for (const name of ['Terms of Service', 'Privacy Policy', 'Pricing']) {
      const box = await footer.getByRole('link', { name, exact: true }).boundingBox();
      heights[name] = box?.height ?? 0;
    }
    for (const [name, height] of Object.entries(heights)) expect(height, name).toBeGreaterThanOrEqual(24);
    // The footer block is as tall as it was with 20px links (text-sm: a 20px line, a 16px gap, the
    // copyright line and the border's padding).
    const block = await footer.boundingBox();
    expect(block!.height).toBeLessThanOrEqual(125);
  });
});

test.describe('/login', () => {
  for (const url of ['/login', '/login?email=1']) {
    test(`${url} holds one heading level 1`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(url, { waitUntil: 'domcontentloaded', ...COLD_PAGE });
      await page.locator('h1').first().waitFor({ state: 'attached', ...COLD_PAGE });
      await expect(page.getByRole('heading', { level: 1, includeHidden: true })).toHaveCount(1);
      expect(await page.locator('h1').count()).toBe(1);
    });
  }
});
