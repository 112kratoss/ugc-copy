import { expect, test, type Locator, type Page } from '@playwright/test';

import creator from './fixtures/creator-profile.json';
import recipePost from './fixtures/post-with-recipe.json';

// Below 768px the app shell's bottom navigation floats over the page's bottom edge
// (`.app-shell-bottom-nav`, z-index 60 in globals.css), and whatever is fixed to that edge at a
// lower layer is drawn under it, where the nav takes its taps. The composer's phone bar (z-40) put
// Save private and Publish public under it, so a phone could not save or publish, and the model
// picker's phone sheet (z-50) its last models. Both sit above the nav now, their bottom offset
// raised by the nav's room (`--app-shell-bottom-nav-space`, 0px from 768px), as the canvas's node
// library opener already did. A menu drawn in the page body is placed from the window's height, so
// it can open over the nav: it was z-50 and lost its last row there, and is on the app's layer for
// body menus now, z-[90]. The post page's unlock CTA (z-40) was under the nav whole; it sits above it
// too. bottom-nav-overlay-layers.test.ts holds every fixed overlay of the web app to the same rule.

const PHONE = { width: 390, height: 844 };
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };

test.describe.configure({ timeout: 120_000 });

async function hideDevBadge(page: Page) {
  // `next dev` draws its badge over the bottom-left corner, where the nav's first link is.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

// On screen, and what the browser draws along its middle (seven points, inside its rounded ends) is
// the element itself, not the nav or anything else over it. A row at the end of a scrolled list may
// lose a fraction of a pixel to the list's edge, hence `ratio`.
async function expectPressable(locator: Locator, name: string, { ratio = 1 } = {}) {
  await expect(locator, `${name} is on screen`).toBeInViewport({ ratio });
  const covered = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const inset = Math.min(box.height / 2, box.width / 2);
    const y = box.top + box.height / 2;
    return Array.from({ length: 7 }, (_, i) => box.left + inset + ((box.width - 2 * inset) * i) / 6).flatMap((x) => {
      const hit = document.elementsFromPoint(x, y).find((candidate) => !candidate.closest('nextjs-portal'));
      if (hit && element.contains(hit)) return [];
      return [`${Math.round(x)}px: ${hit?.closest('nav.app-shell-bottom-nav') ? 'the bottom navigation' : hit?.className ?? 'nothing'}`];
    });
  });
  expect.soft(covered, `what is drawn over ${name}`).toEqual([]);
}

function navTop(page: Page) {
  return page.locator('nav.app-shell-bottom-nav').evaluate((nav) => nav.getBoundingClientRect().top);
}

// A tall page's end, scrolled to, is clear of the bar fixed over it. The page is made tall by a
// spacer at the end of its own root, which React removes with the page. The root is a server
// render, so the spacer waits for React to take it over: hydration throws away a node added before.
async function expectEndClearOf(page: Page, contentSelector: string, bar: Locator, name: string) {
  await page.waitForFunction((selector) => {
    const content = document.querySelector(selector);
    return Boolean(content && Object.keys(content).some((key) => key.startsWith('__reactFiber$')));
  }, contentSelector, COLD_PAGE);
  await page.locator(contentSelector).evaluate((content) => {
    const spacer = document.createElement('div');
    spacer.style.height = '1600px';
    const end = document.createElement('div');
    end.setAttribute('data-e2e-page-end', '');
    end.style.height = '24px';
    content.append(spacer, end);
  });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const endBottom = await page.locator('[data-e2e-page-end]').evaluate((end) => end.getBoundingClientRect().bottom);
  const barTop = await bar.evaluate((element) => element.getBoundingClientRect().top);
  expect.soft(endBottom, `the page's end is above ${name} once scrolled to`).toBeLessThanOrEqual(barTop + 0.5);
  await page.locator('[data-e2e-page-end]').evaluate((end) => {
    end.previousElementSibling?.remove();
    end.remove();
  });
}

test.describe('signed in', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  });

  test('the composer\'s phone bar sits above the bottom navigation, and the page\'s end scrolls clear of it', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/post/new');
    await hideDevBadge(page);
    const publish = page.getByRole('button', { name: 'Publish public', exact: true }).filter({ visible: true });
    await expect(publish).toBeVisible(COLD_PAGE);
    const bar = page.locator('div.fixed').filter({ has: publish });
    await expectPressable(page.getByRole('button', { name: 'Save private', exact: true }).filter({ visible: true }), 'Save private');
    await expectPressable(publish, 'Publish public');
    expect(await bar.evaluate((element) => element.getBoundingClientRect().bottom), 'the bar ends above the nav')
      .toBeLessThanOrEqual(await navTop(page));
    await expectEndClearOf(page, '#main-content .studio-shell', bar, 'the phone bar');

    // From 768px there is no nav, and the bar keeps to the bottom edge until 1024px.
    await page.setViewportSize({ width: 800, height: 1024 });
    await expectPressable(publish, 'Publish public at 800px');
    await expectEndClearOf(page, '#main-content .studio-shell', bar, 'the phone bar at 800px');
  });

  test('the model picker\'s phone sheet ends above the bottom navigation, and its last model can be pressed', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/create-image');
    await hideDevBadge(page);
    const trigger = page.locator('p', { hasText: /^Model$/ }).locator('xpath=following-sibling::button[1]');
    await expect(trigger).toBeVisible(COLD_PAGE);
    await trigger.click();
    const sheet = page.getByTestId('studio-model-picker');
    await expect(sheet).toBeVisible();
    // Its entrance has run: it is where it settles.
    await expect.poll(() => sheet.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    const models = sheet.getByRole('option');
    await expect.poll(() => models.count(), { message: 'the picker lists models', timeout: 15_000 }).toBeGreaterThan(3);
    expect(await sheet.evaluate((element) => element.getBoundingClientRect().bottom), 'the sheet ends above the nav')
      .toBeLessThanOrEqual(await navTop(page));
    await sheet.getByRole('listbox').evaluate((list) => { list.scrollTop = list.scrollHeight; });
    await expectPressable(models.last(), 'the last model', { ratio: 0.95 });
  });
});

test('the post page\'s unlock CTA sits above the bottom navigation, and the post\'s end scrolls clear of it', async ({ page, context }) => {
  // Signed out, so the free recipe is the visitor's to open and the page offers it along the bottom
  // edge below 1180px. The dev server answers the post's reads (support/supabase-server-stub.cjs).
  await context.route('https://example.supabase.co/**', (route) => route.fulfill({ status: 401, json: {} }));
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await page.setViewportSize(PHONE);
  await page.goto(`/showcase/${recipePost.post.id}`);
  const cta = page.getByRole('link', { name: /^View free recipe/ });
  await expect(cta).toBeVisible(COLD_PAGE);
  await hideDevBadge(page);
  await expectPressable(cta, 'the unlock CTA');
  expect(await cta.evaluate((element) => element.getBoundingClientRect().bottom), 'the CTA ends above the nav')
    .toBeLessThanOrEqual(await navTop(page));
  await expectEndClearOf(page, '.canonical-post-shell', cta, 'the unlock CTA');

  // From 768px there is no nav, and the CTA keeps to the bottom edge until 1180px.
  await page.setViewportSize({ width: 800, height: 1024 });
  await expectPressable(cta, 'the unlock CTA at 800px');
  await expectEndClearOf(page, '.canonical-post-shell', cta, 'the unlock CTA at 800px');
});

test('a menu drawn in the page body opens over the bottom navigation', async ({ page, context }) => {
  // Signed out, so the creator page offers its menu (Report and Block) rather than Edit profile.
  await context.route('https://example.supabase.co/**', (route) => route.fulfill({ status: 401, json: {} }));
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await page.setViewportSize(PHONE);
  await page.goto(`/creators/${creator.username}`);
  await expect(page.getByRole('heading', { level: 1, name: creator.display_name })).toBeVisible(COLD_PAGE);
  await hideDevBadge(page);
  const trigger = page.getByRole('button', { name: `More actions for @${creator.username}` });
  await expect(trigger).toBeVisible(COLD_PAGE);
  const menu = page.getByRole('menu');

  // The menu opens below its button when the window has room for it there. A window just tall
  // enough puts its end inside the nav's band, as a feed card's menu lands on a phone when the
  // card sits halfway down.
  await trigger.click();
  await expect(menu).toBeVisible();
  const menuHeight = await menu.evaluate((element) => element.getBoundingClientRect().height);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  const triggerBottom = await trigger.evaluate((element) => element.getBoundingClientRect().bottom);
  await page.setViewportSize({ width: PHONE.width, height: Math.ceil(triggerBottom + menuHeight + 16 + 24) });
  await trigger.click();
  await expect(menu).toBeVisible();
  const menuBox = await menu.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  });
  expect(menuBox.top, 'the menu opened below its button').toBeGreaterThan(triggerBottom);
  expect(menuBox.bottom, 'the menu reaches into the nav (else this shows nothing)').toBeGreaterThan(await navTop(page));
  for (const item of await menu.getByRole('menuitem').all()) {
    await expectPressable(item, `the menu's ${(await item.textContent())?.trim().slice(0, 24)}`);
  }
});
