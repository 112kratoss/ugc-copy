import { expect, test, type Page, type Route } from '@playwright/test';

// A private post made public from Post Library by an account whose profile
// cannot publish yet (`creator-xxxxxxxx`, no name). The server refuses the
// change for the profile, and the list used to say only that, in a toast that
// sent the creator off to their profile. It now asks for the name and handle
// in place, checks the handle as it is typed, saves both, and sends the change
// again.
//
// The Creations page reads all of it from the browser (the creations, the
// posts, the profile), so page.route answers each request; nothing here reads
// Supabase on the server.

const COLD_PAGE = { timeout: 45_000 };
test.describe.configure({ timeout: 120_000 });

const PLACEHOLDER_PROFILE = {
  id: 'workflow-user',
  username: 'creator-a1b2c3d4',
  suggestedUsername: 'creator-a1b2c3d4',
  displayName: null,
  bio: null,
  avatarUrl: null,
  coverUrl: null,
  websiteUrl: null,
  twitterHandle: null,
  instagramHandle: null,
  tiktokHandle: null,
  location: null,
};

const PRIVATE_POST = {
  id: 'post-e2e-visibility',
  generationId: null,
  visibility: 'private',
  archivedAt: null,
  mediaUrl: null,
  mediaKind: null,
  mediaItems: [],
  title: 'Window light study',
  description: '',
  prompt: '',
  body: 'A note on window light, for the community.',
  category: 'text',
  postFormat: 'text',
  sourceKind: 'manual',
  sourceTool: null,
  sourceLabel: 'Magicbooklet',
  createdAt: '2026-10-25T10:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
  publicPath: null,
  ownerPath: '/post/post-e2e-visibility/edit',
  resourcePath: null,
  canShare: false,
  bundle: null,
};

const PROFILE_REFUSAL = {
  error: 'Complete your profile before publishing publicly: choose a custom handle and add your display name.',
  field: 'profile',
  actionHref: '/profile',
  actionLabel: 'Complete profile and return',
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** What the server would say, from memory: the profile's own gate decides the post route's answer. */
async function answerTheLibrary(page: Page, { profile, taken = [] }: { profile: Record<string, unknown>; taken?: string[] }) {
  const events: string[] = [];
  let stored = { ...profile };
  const canPublish = () => Boolean(stored.displayName) && !/^creator-[a-f0-9]{8}$/.test(String(stored.username));

  await page.route('**/api/generations?**', (route) => json(route, { generations: [], pagination: { hasMore: false, nextCursor: null } }));
  await page.route('**/api/posts?**', (route) => json(route, { posts: [PRIVATE_POST], pageInfo: { hasMore: false, nextOffset: null } }));
  await page.route('**/api/profile/validate', (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { username?: string };
    events.push(`check ${body.username}`);
    return taken.includes(body.username ?? '')
      ? json(route, { error: 'That username is already taken.', fieldErrors: { username: 'That username is already taken.' } }, 409)
      : json(route, { ok: true });
  });
  await page.route('**/api/profile', (route) => {
    if (route.request().method() === 'PATCH') {
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      events.push(`save ${body.username} / ${body.displayName}`);
      stored = { ...stored, ...body };
    }
    return json(route, stored);
  });
  await page.route(`**/api/posts/${PRIVATE_POST.id}`, (route) => {
    if (!canPublish()) {
      events.push('refused');
      return json(route, PROFILE_REFUSAL, 400);
    }
    events.push('public');
    return json(route, {
      success: true,
      postId: PRIVATE_POST.id,
      visibility: 'public',
      ownerPath: PRIVATE_POST.ownerPath,
      showcasePath: `/showcase/${PRIVATE_POST.id}`,
      resourceBundleStatus: null,
    });
  });
  return events;
}

async function makePublic(page: Page) {
  await page.getByRole('button', { name: 'Visibility of Window light study: Private' }).click(COLD_PAGE);
  await page.getByRole('menuitemradio', { name: /^public/i }).click();
}

test.describe('Post Library: making a post public asks for the name and handle it needs', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
  });

  test('asks in place, says a taken handle as it is typed, saves both and sends the change again', async ({ page }, testInfo) => {
    const events = await answerTheLibrary(page, { profile: PLACEHOLDER_PROFILE, taken: ['workflow-user'] });
    await page.goto('/creations?view=posts');
    await makePublic(page);

    const dialog = page.getByRole('dialog', { name: 'Add your name and handle' });
    await expect(dialog).toBeVisible();
    // Filled in from the sign-in, as the composers do (the E2E user is "Workflow User").
    const name = dialog.getByRole('textbox', { name: /^display name$/i });
    const handle = dialog.getByRole('textbox', { name: /^handle$/i });
    await expect(name).toHaveValue('Workflow User');
    await expect(handle).toHaveValue('workflow-user');
    // The suggestion is someone else's: said beside the field, before any press.
    await expect(dialog.getByText('That username is already taken.')).toBeVisible();
    await expect(handle).toHaveAttribute('aria-invalid', 'true');
    await page.screenshot({ path: testInfo.outputPath('taken-handle.png') });

    await handle.fill('maya-k');
    await expect(dialog.getByText('This handle is available.')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('available-handle.png') });
    await dialog.getByRole('button', { name: 'Save and make public' }).click();

    await expect(page.getByText('Name and handle saved. Post is public.')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Visibility of Window light study: Public' })).toBeVisible();
    expect(events[0]).toBe('refused');
    expect(events.filter((event) => !event.startsWith('check '))).toEqual([
      'refused',
      'save maya-k / Workflow User',
      'public',
    ]);
    expect(events).toContain('check maya-k');
  });

  test('puts the post back as it was when the question is put away', async ({ page }) => {
    const events = await answerTheLibrary(page, { profile: PLACEHOLDER_PROFILE });
    await page.goto('/creations?view=posts');
    await makePublic(page);

    const dialog = page.getByRole('dialog', { name: 'Add your name and handle' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Visibility of Window light study: Private' })).toBeEnabled();
    await expect(page.getByText(/Post is public|Complete your profile/)).toHaveCount(0);
    expect(events.filter((event) => !event.startsWith('check '))).toEqual(['refused']);
  });

  test('asks nothing of a profile that can already publish', async ({ page }) => {
    const events = await answerTheLibrary(page, {
      profile: { ...PLACEHOLDER_PROFILE, username: 'maya-k', displayName: 'Maya K' },
    });
    await page.goto('/creations?view=posts');
    await makePublic(page);

    await expect(page.getByText('Post is public.')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(events).toEqual(['public']);
  });
});
