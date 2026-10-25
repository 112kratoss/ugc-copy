import { expect, test, type Page, type Route } from '@playwright/test';

// The three things that stopped a first post (2026-10-25): a title nobody had
// (most creations have none), a placeholder-word rule that refused real titles,
// and a handle and name every new account lacks, which the server only named
// after everything was uploaded. This draws the composer in a real browser:
// the suggested title and how it follows the recipe, and the name and handle
// asked for beside the publish buttons and saved before the post.
//
// The composer reads all of it from the browser (the creation, the profile, the
// tool list), so page.route answers each request; nothing here reads Supabase
// on the server.

const COLD_PAGE = { timeout: 45_000 };
test.describe.configure({ timeout: 120_000 });

const CREATION = {
  id: 'gen-e2e-friction',
  output_url: 'https://cdn.example.com/e2e/window-still.png',
  status: 'succeeded',
  category: 'image',
  model: 'nano-banana-2',
  title: null,
  description: '',
  prompt: 'A product still lit like a window display, soft morning light, 85mm',
  origin: 'creation',
  input_media: [],
  paywallPrefill: null,
  linked_post_id: null,
};

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

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function answerTheComposer(page: Page, profile: Record<string, unknown>, order: string[]) {
  await page.route('**/api/source-tools**', (route) => json(route, { tools: [] }));
  await page.route('**/api/generations?**', (route) => json(route, { generations: [CREATION] }));
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() === 'PATCH') {
      order.push('profile');
      expect(JSON.parse(route.request().postData() ?? '{}')).toEqual({ username: 'maya-k', displayName: 'Maya K' });
      return json(route, { ...profile, ...JSON.parse(route.request().postData() ?? '{}') });
    }
    return json(route, profile);
  });
  await page.route('**/api/posts', (route) => {
    order.push('post');
    return json(route, {
      postId: 'post-e2e-friction',
      showcasePath: '/showcase/post-e2e-friction',
      ownerPath: '/post/post-e2e-friction/edit',
      visibility: 'public',
      resourceBundleStatus: null,
    });
  });
}

test.describe('post composer: fewer reasons to stop before posting', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
  });

  test('a creation with no title starts from one its prompt suggests, which follows the recipe', async ({ page }, testInfo) => {
    await answerTheComposer(page, { ...PLACEHOLDER_PROFILE, username: 'maya-k', displayName: 'Maya K' }, []);
    await page.goto(`/post/new?generationId=${CREATION.id}`);

    const title = page.getByRole('textbox', { name: /^title/i });
    await expect(title).toHaveValue('Product still lit like a window display', COLD_PAGE);
    await expect(page.getByText('Suggested from your prompt. Edit it if you like.')).toBeVisible();
    await title.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('suggested-title.png') });

    await page.getByRole('checkbox', { name: /add a reusable recipe/i }).check();
    await expect(title).toHaveValue('Image recipe');
    await expect(page.getByText('Suggested. Your prompt stays private inside the recipe.')).toBeVisible();
    await title.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('suggested-title-with-recipe.png') });
    await page.getByRole('checkbox', { name: /add a reusable recipe/i }).uncheck();
    await expect(title).toHaveValue('Product still lit like a window display');

    // A ready profile is asked nothing.
    await expect(page.getByRole('textbox', { name: /^display name$/i })).toHaveCount(0);
  });

  test('a new account is asked its name and handle beside the buttons, and they are saved before the post', async ({ page }, testInfo) => {
    const order: string[] = [];
    await answerTheComposer(page, PLACEHOLDER_PROFILE, order);
    await page.goto('/post/new');

    await page.getByRole('button', { name: /^text$/i }).click(COLD_PAGE);
    await page.getByRole('textbox', { name: /^post text/i }).fill('A note that stands on its own for the community.');
    await page.getByRole('textbox', { name: /^title/i }).fill('Product demo with soft window light');

    // Filled in from the sign-in (the E2E user's name is "Workflow User").
    const name = page.getByRole('textbox', { name: /^display name$/i });
    const handle = page.getByRole('textbox', { name: /^handle$/i });
    await expect(name).toHaveValue('Workflow User');
    await expect(handle).toHaveValue('workflow-user');
    await name.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('name-and-handle.png') });

    const publishPublic = page.getByRole('button', { name: /publish public/i }).last();
    await name.fill('');
    await publishPublic.click();
    await expect(page.getByText('Add your name and handle to publish publicly.')).toBeVisible();
    await expect(page.getByText('Add a display name for your public profile.')).toBeVisible();
    expect(order).toEqual([]);

    await name.fill('Maya K');
    await handle.fill('@Maya-K');
    await expect(handle).toHaveValue('maya-k');
    await publishPublic.click();

    // Saved before the post; "Product demo …" used to be refused as a placeholder title.
    await expect.poll(() => order).toEqual(['profile', 'post']);
    await expect(page.getByText('Your post is live.')).toBeVisible();
  });
});
