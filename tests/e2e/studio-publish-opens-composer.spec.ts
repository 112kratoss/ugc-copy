import { expect, test, type Route } from '@playwright/test';

// Publishing a creation opens the full composer for it, as the app's does
// (owner, 2026-10-31). Studio's Publish and a template run's Publish & share
// used to open a pop-up instead. Both pages read their data from the browser,
// so page.route answers each request; nothing here reads Supabase on the server.

const COLD_PAGE = { timeout: 45_000 };
test.describe.configure({ timeout: 120_000 });

const CREATION = {
  id: 'gen-e2e-studio-publish',
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

// Ready to post publicly, so the composer asks for no name or handle.
const READY_PROFILE = {
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

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('publishing a creation opens the full composer', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
    await page.route('**/api/source-tools**', (route) => json(route, { tools: [] }));
    await page.route('**/api/profile', (route) => json(route, READY_PROFILE));
  });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('Studio’s Publish opens the composer for the creation, and Back from the post returns to Studio', async ({ page }, testInfo) => {
    // Studio's list and the composer's read of the creation alike.
    await page.route('**/api/generations?**', (route) => json(route, { generations: [CREATION] }));
    await page.route('**/api/posts?**', (route) => json(route, { posts: [] }));
    await page.route('**/api/showcase/publish', (route) => json(route, {
      success: true,
      postId: 'post-e2e-studio',
      showcasePath: '/showcase/post-e2e-studio',
      ownerPath: '/post/post-e2e-studio/edit',
      resourceBundlePath: null,
      visibility: 'public',
      resourceBundleStatus: null,
    }));
    // Where the composer goes once the post is out: this test reads the address, not the post page.
    await page.route('**/showcase/post-e2e-studio**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Post</title><h1>The new post</h1>',
    }));

    await page.goto('/creations');
    const publish = page.getByTestId(`creation-card-${CREATION.id}`).getByRole('link', { name: 'Publish' });
    await expect(publish).toBeVisible(COLD_PAGE);
    await page.screenshot({ path: testInfo.outputPath('studio-card.png') });
    await publish.click();

    await expect(page).toHaveURL(
      `/post/new?generationId=${CREATION.id}&from=creations&returnTo=%2Fcreations`,
      COLD_PAGE,
    );
    await expect(page.getByRole('textbox', { name: /^title/i })).toHaveValue('Window light study', COLD_PAGE);
    await expect(page.getByRole('link', { name: 'Back to studio' })).toHaveAttribute('href', '/creations');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('composer-from-studio.png') });

    await page.getByRole('button', { name: /publish public/i }).first().click();
    await expect(page).toHaveURL(/\/showcase\/post-e2e-studio$/, COLD_PAGE);
    // The post took the composer's place in history, as the app's composer leaves its stack.
    await page.goBack();
    await expect(page).toHaveURL(/\/creations$/, COLD_PAGE);
  });

  test('a template run’s Publish & share shares the post once it is public, then opens it', async ({ page }, testInfo) => {
    const shares: Array<{ title?: string; text?: string; url?: string }> = [];
    await page.exposeFunction('e2eRecordShare', (data: string) => {
      shares.push(JSON.parse(data));
    });
    // The share sheet itself is the browser's; this one records what it was given.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: ShareData) => {
          await (window as unknown as { e2eRecordShare: (data: string) => Promise<void> })
            .e2eRecordShare(JSON.stringify(data));
        },
      });
    });
    const published: unknown[] = [];
    await page.route('**/api/generations?**', (route) => json(route, {
      generations: [{ ...CREATION, origin: 'template', template: { runId: 'run-e2e', templateTitle: 'Window light' } }],
    }));
    await page.route('**/api/showcase/publish', (route) => {
      published.push(route.request().postDataJSON());
      return json(route, {
        success: true,
        postId: 'post-e2e-run',
        showcasePath: '/showcase/post-e2e-run',
        ownerPath: '/post/post-e2e-run/edit',
        resourceBundlePath: null,
        visibility: 'public',
        resourceBundleStatus: null,
      });
    });
    await page.route('**/api/showcase/share', (route) => json(route, { success: true }));
    // Where the composer goes once the post is out: this test reads the address, not the post page.
    await page.route('**/showcase/post-e2e-run**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Post</title><h1>The new post</h1>',
    }));

    await page.goto(`/post/new?generationId=${CREATION.id}&from=template-run&returnTo=%2Ftemplate-runs%2Frun-e2e&shareAfterPublish=1`);
    await expect(page.getByRole('link', { name: 'Back to template run' })).toHaveAttribute('href', '/template-runs/run-e2e', COLD_PAGE);
    await expect(page.getByRole('textbox', { name: /^title/i })).toHaveValue('Window light study', COLD_PAGE);
    await page.screenshot({ path: testInfo.outputPath('composer-from-template-run.png') });
    await page.getByRole('button', { name: /publish public/i }).first().click();

    await expect(page).toHaveURL(/\/showcase\/post-e2e-run$/, COLD_PAGE);
    expect(published).toEqual([
      expect.objectContaining({ generationId: CREATION.id, visibility: 'public', title: 'Window light study' }),
    ]);
    expect(shares).toEqual([
      expect.objectContaining({
        title: 'Window light study',
        url: expect.stringContaining(`/showcase/${CREATION.id}`),
      }),
    ]);
  });
});
