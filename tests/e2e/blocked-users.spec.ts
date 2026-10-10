import { expect, test, type Page } from '@playwright/test';

// Profile → Blocked users, in a browser. A block could not be seen or taken
// back on the web: the server could unblock, and no page asked it to.
//
// The list and the unblock are answered here, so the spec needs no database.
// Each unblock is held until the test lets it go: what the page does while the
// server still has the request is the thing under test. A row that waited for
// the answer read as a press that did not land.

type Blocked = { id: string; username: string | null; name: string; avatar: null; blockedAt: string };

// Noon UTC: the same day in every time zone a runner or a laptop is likely to be in.
const blocked = (id: string, username: string | null, name: string): Blocked => ({
  id,
  username,
  name,
  avatar: null,
  blockedAt: '2026-10-10T12:00:00.000Z',
});

type Server = {
  /** The ids the page asked to unblock, in the order asked. */
  asked: string[];
  /** Answers the unblock of one person: `true` agrees, `false` refuses. */
  answer: (id: string, agree: boolean) => void;
};

async function serveBlockedUsers(page: Page, people: Blocked[]): Promise<Server> {
  const asked: string[] = [];
  const answers = new Map<string, { promise: Promise<boolean>; give: (agree: boolean) => void }>();
  const answerFor = (id: string) => {
    if (!answers.has(id)) {
      let give: (agree: boolean) => void = () => undefined;
      const promise = new Promise<boolean>((resolve) => { give = resolve; });
      answers.set(id, { promise, give });
    }
    return answers.get(id)!;
  };

  await page.route('**/api/moderation/blocks', (route) => route.fulfill({
    json: { success: true, blockedUsers: people, hasMore: false },
  }));
  await page.route('**/api/moderation/blocks/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    if (route.request().method() !== 'DELETE') return route.fulfill({ status: 405, json: { error: 'Method not allowed.' } });
    asked.push(id);
    return (await answerFor(id).promise)
      ? route.fulfill({ json: { success: true, blocked: false } })
      : route.fulfill({ status: 500, json: { error: 'Failed to unblock user.' } });
  });

  return { asked, answer: (id, agree) => answerFor(id).give(agree) };
}

async function confirmUnblock(page: Page, label: string) {
  await page.getByRole('button', { name: `Unblock ${label}`, exact: true }).click();
  const question = page.getByRole('alertdialog');
  await expect(question).toContainText(`Unblock ${label}?`);
  await question.getByRole('button', { name: 'Unblock', exact: true }).click();
}

/** The rows in the order drawn, each named by its button. */
function rowButtons(page: Page) {
  return page.getByRole('list', { name: 'Blocked users' }).getByRole('button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
}

test.describe('blocked users', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  });

  test('lists whom the viewer blocked and takes a block back at the answer, not at the reply', async ({ page }) => {
    const server = await serveBlockedUsers(page, [
      blocked('creator-a', 'creator-a', 'Creator A'),
      blocked('creator-b', null, 'No Handle'),
    ]);
    await page.goto('/profile/blocked');

    const rows = page.getByRole('list', { name: 'Blocked users' }).getByRole('listitem');
    await expect(rows).toHaveCount(2);
    // The name, the handle and the day, each on a line of its own; no handle, no line for it.
    await expect(rows.nth(0).locator('span.block')).toHaveText(['Creator A', '@creator-a', /^Blocked Oct 1[01], 2026$/]);
    await expect(rows.nth(1).locator('span.block')).toHaveText(['No Handle', /^Blocked Oct 1[01], 2026$/]);

    await confirmUnblock(page, '@creator-a');

    // The server still has the request, and the row is gone.
    await expect(page.getByRole('button', { name: 'Unblock @creator-a', exact: true })).toHaveCount(0);
    await expect.poll(() => server.asked).toEqual(['creator-a']);
    await expect(page.locator('.ui-toast')).toHaveCount(0);
    // Nothing is held meanwhile.
    await expect(page.getByRole('button', { name: 'Unblock No Handle', exact: true })).toBeEnabled();

    server.answer('creator-a', true);
    await expect(page.locator('.ui-toast')).toContainText('@creator-a is unblocked.');

    await confirmUnblock(page, 'No Handle');
    await expect(page.getByRole('heading', { name: 'You have not blocked anyone' })).toBeVisible();
    server.answer('creator-b', true);
    await expect(page.locator('.ui-toast').filter({ hasText: 'No Handle is unblocked.' })).toBeVisible();
    expect(server.asked).toEqual(['creator-a', 'creator-b']);
  });

  test('draws a row again in its place when the server refuses, whatever else is on its way', async ({ page }) => {
    const server = await serveBlockedUsers(page, [
      blocked('creator-a', 'creator-a', 'Creator A'),
      blocked('creator-b', null, 'No Handle'),
      blocked('creator-c', 'creator-c', 'Creator C'),
    ]);
    await page.goto('/profile/blocked');
    await expect(page.getByRole('list', { name: 'Blocked users' }).getByRole('listitem')).toHaveCount(3);

    await confirmUnblock(page, '@creator-a');
    await confirmUnblock(page, 'No Handle');
    await expect.poll(() => rowButtons(page)).toEqual(['Unblock @creator-c']);

    // The first is refused while the second is still with the server.
    server.answer('creator-a', false);
    await expect(page.locator('.ui-toast')).toContainText('Could not unblock this creator. Failed to unblock user.');
    await expect.poll(() => rowButtons(page)).toEqual(['Unblock @creator-a', 'Unblock @creator-c']);

    // Then the second: it comes back between the two, not above them.
    server.answer('creator-b', false);
    await expect.poll(() => rowButtons(page)).toEqual(['Unblock @creator-a', 'Unblock No Handle', 'Unblock @creator-c']);
  });
});
