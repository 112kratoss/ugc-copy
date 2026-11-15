import { expect, test, type Locator, type Page } from '@playwright/test';

// A page drawn ahead of time for everyone (signed-out Home, a creator's page, Templates) is the
// server's HTML until its script has run, and that HTML draws the default: a refresh on
// `/?chip=notes`, `/creators/<name>#creator-unlocks` or `/templates?input=image` showed For you,
// Posts or All formats first, then switched (owner, 2026-11-15: "fix the … refresh flash too").
// The root layout now marks the address's choice on the root element before the first paint
// (src/lib/address-first-paint.ts), the stylesheet draws it, and the page takes the mark away
// once it draws the same choice itself.

const COLD_PAGE = { timeout: 45_000 };
test.describe.configure({ timeout: 120_000 });

/** Next's own scripts never arrive: the page is what the server sent, with its inline scripts run. */
async function withoutPageScripts(page: Page) {
  await page.route('**/_next/static/chunks/**', (route) => route.abort());
}

/** How a control is drawn: what tells the chosen one from the others. */
function look(control: Locator) {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.backgroundColor} ${style.color} ${style.borderColor}`;
  });
}

const CASES = [
  {
    name: 'signed-out Home on a lane',
    plain: '/',
    address: '/?chip=notes',
    defaultControl: (page: Page) => page.getByRole('button', { name: 'For you', exact: true }),
    chosenControl: (page: Page) => page.getByRole('button', { name: 'Notes', exact: true }),
    mark: 'data-home-chip',
  },
  {
    name: "a creator's page on its Recipes tab",
    plain: '/creators/e2e-creator',
    address: '/creators/e2e-creator#creator-unlocks',
    defaultControl: (page: Page) => page.locator('#creator-tab-creations > span'),
    chosenControl: (page: Page) => page.locator('#creator-tab-unlocks > span'),
    mark: 'data-creator-tab',
  },
  {
    name: 'Templates on a media filter',
    plain: '/templates',
    address: '/templates?input=image',
    defaultControl: (page: Page) => page.getByRole('button', { name: 'All formats', exact: true }),
    chosenControl: (page: Page) => page.getByRole('button', { name: 'Uses images', exact: true }),
    mark: 'data-template-input',
  },
];

for (const { name, plain, address, defaultControl, chosenControl, mark } of CASES) {
  test(`${name} draws the address's choice before any script`, async ({ page }) => {
    await withoutPageScripts(page);
    // What the chosen control looks like: the default, drawn as chosen on the plain address.
    await page.goto(plain, COLD_PAGE);
    await expect(defaultControl(page)).toBeVisible(COLD_PAGE);
    const chosenLook = await look(defaultControl(page));

    // A load of its own: from the plain address, one that adds only a fragment would be a jump
    // within the same document, which runs no script.
    await page.goto('about:blank');
    await page.goto(address, COLD_PAGE);
    await expect(chosenControl(page)).toBeVisible(COLD_PAGE);

    expect(await look(chosenControl(page))).toBe(chosenLook);
    expect(await look(defaultControl(page))).not.toBe(chosenLook);
  });

  test(`${name} takes over the choice once its script runs`, async ({ page }) => {
    await page.goto(address, COLD_PAGE);

    await expect.poll(() => page.locator('html').getAttribute(mark), COLD_PAGE).toBeNull();
    const chosenLook = await look(chosenControl(page));
    expect(await look(defaultControl(page))).not.toBe(chosenLook);
  });
}
