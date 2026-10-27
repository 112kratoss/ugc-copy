import { expect, test, type Page } from '@playwright/test';

// The shell's Create menu (src/components/AppShellCreateMenu.tsx), the app's centre + on the
// web: the top bar's Create and the phone layout's + open the same two choices, Create and
// Post. Before it, both went straight to /create, and a post could only be started from
// buttons inside a few pages. It is a native popover, so these run in a real browser: jsdom
// has none.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };

test.describe.configure({ timeout: 120_000 });

async function openExplore(page: Page) {
  await page.goto('/showcase');
  // `next dev` draws its badge over the bottom-left corner.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

test.describe('the Create menu', () => {
  test("opens under the top bar's Create, offers Create and Post, and closes on Escape and on a choice", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openExplore(page);
    const create = page.locator('header.app-shell-header').getByRole('button', { name: 'Create' });
    const menu = page.getByRole('dialog', { name: 'Create or publish' });
    await expect(menu).toBeHidden();

    await create.click();
    await expect(menu).toBeVisible(COLD_PAGE);
    await expect(menu.getByRole('link', { name: 'Create' })).toHaveAttribute('href', '/create');
    // Started on Explore, the composer's Back goes to Explore.
    await expect(menu.getByRole('link', { name: 'Post' })).toHaveAttribute(
      'href',
      '/post/new?from=community&returnTo=%2Fshowcase',
    );
    // Hung under its button, right edges level.
    const button = (await create.boundingBox())!;
    const panel = (await menu.boundingBox())!;
    expect(panel.y).toBeGreaterThanOrEqual(button.y + button.height);
    expect(Math.abs(panel.x + panel.width - (button.x + button.width))).toBeLessThanOrEqual(2);

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    // The focus goes back to the button that opened it.
    await expect(create).toBeFocused();

    await create.click();
    await expect(menu).toBeVisible();
    // The creators hub compiles on its first request: warm it, so the wait below holds only
    // the navigation (`.claude/rules/e2e.md`).
    await page.request.get('/create', { timeout: 0 });
    await menu.getByRole('link', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/create$/, COLD_PAGE);
    await expect(menu).toBeHidden();
  });

  test("opens above the phone layout's +, and a tap beside it closes it", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openExplore(page);
    const bottomNavigation = page.getByRole('navigation', { name: 'Primary mobile navigation' });
    const menu = page.getByRole('dialog', { name: 'Create or publish' });

    await bottomNavigation.getByRole('button', { name: 'Create' }).click();
    await expect(menu).toBeVisible(COLD_PAGE);
    const bar = (await bottomNavigation.boundingBox())!;
    const panel = (await menu.boundingBox())!;
    // Over the bar, not on it, and inside the window.
    expect(panel.y + panel.height).toBeLessThanOrEqual(bar.y);
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(PHONE.width);
    await expect(menu.getByRole('link', { name: 'Post' })).toBeVisible();

    // The scrim above the menu, where the page is.
    await page.mouse.click(PHONE.width / 2, 120);
    await expect(menu).toBeHidden();
  });
});
