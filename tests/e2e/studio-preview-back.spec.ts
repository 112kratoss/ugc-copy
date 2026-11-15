import { expect, test, type Page, type Route } from '@playwright/test';

// Studio's creation preview was no history entry of its own (owner, 2026-11-15: "fix the studio
// preview back too"): Back pressed while it was open left Studio for the page before, where the
// reels' Back closes the reel. The preview now pushes an entry, as a reel opened from a tile does,
// and closes by going Back to Studio's. Studio reads its data from the browser, so page.route
// answers each request; nothing here reads Supabase on the server.

const COLD_PAGE = { timeout: 45_000 };
test.describe.configure({ timeout: 120_000 });

const CREATION = {
  id: 'gen-e2e-studio-preview',
  output_url: 'https://cdn.example.com/e2e/window-still.png',
  status: 'succeeded',
  created_at: '2026-10-30T10:00:00.000Z',
  completed_at: '2026-10-30T10:00:30.000Z',
  duration: 30,
  cost: 1,
  category: 'image',
  model: 'nano-banana-2',
  title: 'Window light study',
  description: '',
  prompt: 'A product still lit like a window display, soft morning light, 85mm',
  origin: 'creation',
  input_media: [],
  paywallPrefill: null,
  linked_post_id: null,
  archived_at: null,
};

const PROFILE = {
  id: 'workflow-user',
  username: 'maya-k',
  suggestedUsername: 'maya-k',
  displayName: 'Maya K',
  bio: null,
  avatarUrl: null,
  coverUrl: null,
  websiteUrl: null,
  twitterHandle: null,
  instagramHandle: null,
  tiktokHandle: null,
  location: null,
};

// A page Studio was reached from: Back from Studio itself returns here.
const BEFORE_STUDIO = '/terms';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const preview = (page: Page) => page.getByRole('dialog', { name: CREATION.title });
const details = (page: Page) => page.getByTestId(`creation-card-${CREATION.id}`).getByRole('button', { name: 'Details', exact: true });
const address = (page: Page) => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
};

/** Studio reached from another page, its creation drawn: a sign of the page's own script. */
async function studioFrom(page: Page, path = '/creations') {
  await page.goto(BEFORE_STUDIO, COLD_PAGE);
  await page.goto(path, COLD_PAGE);
}

async function openPreview(page: Page) {
  await expect(details(page)).toBeEnabled(COLD_PAGE);
  await details(page).click();
  await expect(preview(page)).toBeVisible();
}

test.describe("Studio's creation preview in the browser's history", () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
    await page.route('**/api/source-tools**', (route) => json(route, { tools: [] }));
    await page.route('**/api/profile', (route) => json(route, PROFILE));
    // Studio's list and the preview's read of the creation alike.
    await page.route('**/api/generations?**', (route) => json(route, { generations: [CREATION] }));
    await page.route('**/api/posts?**', (route) => json(route, { posts: [] }));
  });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('Back closes the preview and stays in Studio, and Forward opens it again', async ({ page }) => {
    await studioFrom(page);
    await openPreview(page);

    // The owner's report: Back went to the page Studio was reached from.
    await page.goBack();

    await expect.poll(() => address(page)).toBe('/creations');
    await expect(preview(page)).toBeHidden();
    await expect(details(page)).toBeVisible();

    await page.goForward();

    await expect(preview(page)).toBeVisible();
    expect(address(page)).toBe(`/creations?generation=${CREATION.id}`);
  });

  test('Close returns to Studio as it was, and Back from there leaves Studio', async ({ page }) => {
    await studioFrom(page);
    await openPreview(page);

    await preview(page).getByRole('button', { name: 'Close preview' }).click();

    await expect(preview(page)).toBeHidden();
    await expect.poll(() => address(page)).toBe('/creations');

    await page.goBack();
    await expect.poll(() => address(page)).toBe(BEFORE_STUDIO);
  });

  // Where the reader was when they pressed Publish: the creation's details, open.
  test('Back from the composer that Publish in the details opened returns to them, open', async ({ page }) => {
    await studioFrom(page);
    await openPreview(page);

    await preview(page).getByRole('link', { name: 'Publish' }).click();
    await expect(page.getByRole('textbox', { name: /^title/i })).toHaveValue(CREATION.title, COLD_PAGE);

    await page.goBack();

    await expect(preview(page)).toBeVisible(COLD_PAGE);
    expect(address(page)).toBe(`/creations?generation=${CREATION.id}`);

    // And its Close goes Back to Studio's own entry, as the press that opened it pushed one.
    await preview(page).getByRole('button', { name: 'Close preview' }).click();
    await expect(preview(page)).toBeHidden();
    await expect.poll(() => address(page)).toBe('/creations');
    await expect(details(page)).toBeVisible();
  });

  test('a creation opened by its link closes in place, and Back leaves Studio', async ({ page }) => {
    await studioFrom(page, `/creations?generation=${CREATION.id}`);
    await expect(preview(page)).toBeVisible(COLD_PAGE);

    await preview(page).getByRole('button', { name: 'Close preview' }).click();

    await expect(preview(page)).toBeHidden();
    await expect.poll(() => address(page)).toBe('/creations');

    await page.goBack();
    await expect.poll(() => address(page)).toBe(BEFORE_STUDIO);
  });
});
