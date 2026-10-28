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

test.beforeEach(async ({ context }) => {
  // Signed in, as the menu's choices are for: /create draws its hub rather than a sign-in.
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
});

async function openExplore(page: Page) {
  await page.goto('/showcase');
  // `next dev` draws its badge over the bottom-left corner.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

test.describe('the Create menu', () => {
  test("opens under the top bar's Create, offers Create and Post, and closes on a choice", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openExplore(page);
    const create = page.locator('header.app-shell-header').getByRole('button', { name: 'Create' });
    const menu = page.getByRole('dialog', { name: 'Create or publish' });
    await expect(menu).toBeHidden();

    await create.click();
    await expect(menu).toBeVisible(COLD_PAGE);
    await expect(menu.getByRole('link', { name: 'Create' })).toHaveAttribute('href', '/create');
    // Started on Explore, the composer's Back goes to Explore.
    await expect(menu.getByRole('link', { name: 'Post' })).toHaveAttribute('href', '/post/new?from=community');
    // Hung under its button, right edges level.
    const button = (await create.boundingBox())!;
    const panel = (await menu.boundingBox())!;
    expect(panel.y).toBeGreaterThanOrEqual(button.y + button.height);
    expect(Math.abs(panel.x + panel.width - (button.x + button.width))).toBeLessThanOrEqual(2);

    // The creators hub compiles on its first request: warm it, so the wait below holds only
    // the navigation (`.claude/rules/e2e.md`).
    await page.request.get('/create', { timeout: 0 });
    await menu.getByRole('link', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/create$/, COLD_PAGE);
    await expect(menu).toBeHidden();
  });

  test('takes the focus as it opens, keeps the keys from the page, and gives the focus back on Escape', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openExplore(page);
    // A page's own key handler on the window, as the workflow canvas has: it cancels an
    // Escape to clear its selection, and a cancelled Escape does not close a popover.
    await page.evaluate(() => {
      const heard: string[] = [];
      (window as { heardByPage?: string[] }).heardByPage = heard;
      window.addEventListener('keydown', (event) => {
        heard.push(event.key);
        if (event.key === 'Escape') event.preventDefault();
      });
    });
    const create = page.locator('header.app-shell-header').getByRole('button', { name: 'Create' });
    const menu = page.getByRole('dialog', { name: 'Create or publish' });

    await create.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible(COLD_PAGE);
    await expect(menu.getByRole('link', { name: 'Create' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu.getByRole('link', { name: 'Post' })).toBeFocused();

    // One Escape closes it, and the page under it never heard a key.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(create).toBeFocused();
    expect(await page.evaluate(() => (window as { heardByPage?: string[] }).heardByPage)).toEqual(['Enter']);
  });

  test("opens above the phone layout's +, and a tap beside it closes it and reaches nothing under it", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openExplore(page);
    const bottomNavigation = page.getByRole('navigation', { name: 'Primary mobile navigation' });
    const menu = page.getByRole('dialog', { name: 'Create or publish' });
    // The top bar's button that opens the navigation: under the scrim once the menu is open.
    const openNavigation = page.getByRole('button', { name: 'Open navigation' });
    const underScrim = (await openNavigation.boundingBox())!;

    await bottomNavigation.getByRole('button', { name: 'Create' }).click();
    await expect(menu).toBeVisible(COLD_PAGE);
    const bar = (await bottomNavigation.boundingBox())!;
    const panel = (await menu.locator('.app-shell-create-menu-panel').boundingBox())!;
    // Over the bar, not on it, and inside the window.
    expect(panel.y + panel.height).toBeLessThanOrEqual(bar.y);
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(PHONE.width);
    await expect(menu.getByRole('link', { name: 'Post' })).toBeVisible();

    // A tap on the scrim, over that button: the scrim takes it, and the button never hears it.
    await page.mouse.click(underScrim.x + underScrim.width / 2, underScrim.y + underScrim.height / 2);
    await expect(menu).toBeHidden();
    await expect(openNavigation).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
  });
});
