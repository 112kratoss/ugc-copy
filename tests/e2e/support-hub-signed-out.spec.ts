import { expect, test, type Locator, type Page } from '@playwright/test';

// Help & Support is everyone's (owner, 2026-11-26; plan:
// docs/plans/help-support-updates-roadmap-plan-2026-11-26.md). Until then its layout sent a
// signed-out visitor to sign in, and the shell's Help & feedback sent one to the contact page.
// Now the visitor opens /support on its Chat tab, which asks them to sign in, and reads Updates and
// the Roadmap, whose reactions ask them to sign in too; "Suggest a feature" opens the chat. Offline,
// the lists are answered here (the shell's unread dot asks the Updates read too).

// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 60_000 };

const UPDATE = {
  id: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a',
  kind: 'announcement',
  title: 'Folders are here',
  body: 'Group your creations into folders from your profile.',
  createdAt: '2026-11-26T12:00:00.000Z',
  commentCount: 4,
  commentsLocked: false,
  reactions: { '👍': 12 },
  myReaction: null,
};

const ROADMAP = {
  items: [{
    id: '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b',
    title: 'Folders for creations',
    summary: 'Group what you make by project.',
    status: 'building',
    shippedAt: null,
    shippedUpdateId: null,
    reactions: { '🙏': 40 },
    myReaction: null,
  }],
};

/** Presses a tab until the page's script has it: a press made before the page hydrates is dropped. */
async function openTab(page: Page, tab: Locator) {
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
  }).toPass(COLD_PAGE);
}

test.describe.configure({ timeout: 180_000 });

test('a signed-out visitor opens Help & Support, is asked to sign in to chat, and reads Updates and the Roadmap', async ({ page }) => {
  // The page and its dot are drawn by the server for no one: React must not throw that HTML away.
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydrat|did not match|server rendered/i.test(message.text())) faults.push(message.text());
  });
  const reads: string[] = [];
  await page.route('**/api/support/updates**', (route) => {
    const url = new URL(route.request().url());
    reads.push(`${url.pathname}${url.search}`);
    return route.fulfill({ json: { updates: [UPDATE], nextCursor: null, latestAt: UPDATE.createdAt } });
  });
  await page.route('**/api/support/roadmap**', (route) => {
    const url = new URL(route.request().url());
    reads.push(`${url.pathname}${url.search}`);
    return route.fulfill({ json: ROADMAP });
  });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto('/support', COLD_PAGE);
  // No sign-in on the way in.
  await expect(page).toHaveURL(/\/support$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Help & Support' })).toBeVisible(COLD_PAGE);
  const chat = page.getByRole('tabpanel', { name: 'Chat' });
  await expect(chat.getByRole('heading', { name: 'Sign in to message support' })).toBeVisible();
  await expect(chat.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?returnUrl=%2Fsupport');
  await expect(chat.getByRole('link', { name: 'Email us instead' })).toHaveAttribute('href', /^mailto:/);
  await expect(page.getByRole('link', { name: 'contact page' })).toHaveAttribute('href', '/contact');
  await expect(page.getByRole('complementary', { name: 'Primary navigation' }).getByRole('link', { name: /^Help & feedback/ }))
    .toHaveAttribute('href', '/support');

  await openTab(page, page.getByRole('tab', { name: /^Updates/ }));
  await expect(page).toHaveURL(/\/support\?tab=updates$/);
  const card = page.getByRole('article').filter({ hasText: UPDATE.title });
  await expect(card.getByRole('link', { name: UPDATE.title })).toHaveAttribute('href', `/showcase/${UPDATE.id}`);
  await expect(card.getByRole('link', { name: 'Sign in to react', exact: true })).toHaveAttribute('href', '/login?returnUrl=%2Fsupport%3Ftab%3Dupdates');
  await expect(card.getByRole('link', { name: '👍, 12 people. Sign in to react', exact: true })).toHaveAttribute('href', '/login?returnUrl=%2Fsupport%3Ftab%3Dupdates');
  expect(reads).toContain('/api/support/updates?scope=public');

  await openTab(page, page.getByRole('tab', { name: 'Roadmap' }));
  await expect(page).toHaveURL(/\/support\?tab=roadmap$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Building' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: 'Folders for creations' })).toBeVisible();
  expect(reads).toContain('/api/support/roadmap?scope=public');

  await page.getByRole('button', { name: 'Suggest a feature' }).click();
  await expect(page).toHaveURL(/\/support$/);
  await expect(page.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Chat' }).getByRole('heading', { name: 'Sign in to message support' })).toBeVisible();
  expect(faults).toEqual([]);
});

test('a link to a tab of Help & Support opens on it', async ({ page }) => {
  await page.route('**/api/support/updates**', (route) => route.fulfill({ json: { updates: [UPDATE], nextCursor: null, latestAt: UPDATE.createdAt } }));
  await page.route('**/api/support/roadmap**', (route) => route.fulfill({ json: ROADMAP }));
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto('/support?tab=roadmap', COLD_PAGE);
  await expect(page.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute('aria-selected', 'true', COLD_PAGE);
  await expect(page.getByRole('heading', { level: 3, name: 'Folders for creations' })).toBeVisible(COLD_PAGE);
});
