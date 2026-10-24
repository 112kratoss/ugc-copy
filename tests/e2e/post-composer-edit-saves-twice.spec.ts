import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

import ownPost from './fixtures/post-composer-saved-twice.json';

// An edit that adds a picture can be saved again on the same page. Saving media
// re-inserts every media row of the post under a new id, so the page has to
// name its pictures by the ids the save answered with: it sent the ids it was
// rendered with, and the added picture again as a new upload, and the server
// refused every later save until a reload.
//
// The edit page reads its post on the server (getOwnerPostDetail), which the
// placeholder project cannot answer: tests/e2e/support/supabase-server-stub.cjs
// answers those reads with fixtures/post-composer-saved-twice.json, a public
// image post of the E2E user's with one picture and no recipe. What the upload
// and the saves ask for is answered here, the edit route included, which
// refuses what the real one refuses. The page's other requests fail, as on
// every page here (the picture's own file and the top bar's account slot read
// the placeholder project), and none of them is needed.

const POST = {
  id: ownPost.post.id,
  title: ownPost.post.title,
  mediaRowId: ownPost.media[0].id,
  mediaKey: ownPost.media[0].media_key,
};

// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };

// page.goto, which has no timeout of its own, spends the test's on that compile,
// so the test's has to hold it and COLD_PAGE's wait both.
test.describe.configure({ timeout: 120_000 });

type SubmittedMedia = { existingId?: string; mediaKey?: string; storagePath?: string };

/**
 * A browser Supabase session, which the media upload reads before it asks for
 * a signed URL. Far from expiring, so supabase-js never tries to refresh it.
 */
function supabaseSessionCookie() {
  const session = {
    access_token: 'e2e-access-token',
    refresh_token: 'e2e-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4_102_444_800,
    user: { id: 'workflow-user', aud: 'authenticated', role: 'authenticated', email: 'workflow-user@example.com' },
  };
  return {
    // The key supabase-js derives from https://example.supabase.co.
    name: 'sb-example-auth-token',
    value: `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`,
    url: 'http://127.0.0.1:3100',
  };
}

async function answerTheUpload(page: Page) {
  const staged = { path: 'workflow-user/e2e-added.png', storagePath: 'uploads/workflow-user/e2e-added.png' };
  let signed = 0;
  await page.route('**/api/uploads/media/sign', async (route) => {
    signed += 1;
    await route.fulfill({
      json: {
        success: true,
        uploadId: 'e2e-upload-1',
        bucket: 'uploads',
        path: staged.path,
        storagePath: staged.storagePath,
        token: 'e2e-upload-token',
        // Same origin, so the upload's PUT needs no CORS answer.
        signedUploadUrl: 'http://127.0.0.1:3100/e2e-staged-upload',
        expiresInSeconds: 7200,
      },
    });
  });
  await page.route('**/e2e-staged-upload**', (route) => route.fulfill({ json: { Key: staged.storagePath } }));
  await page.route('**/api/uploads/finalize', (route) => route.fulfill({
    json: { bucket: 'uploads', path: staged.path, storagePath: staged.storagePath, contentType: 'image/png', sizeBytes: 68 },
  }));
  await page.route('**/api/uploads/media/read-url', (route) => route.fulfill({
    json: { success: true, signedUrl: 'http://127.0.0.1:3100/e2e-staged-upload/preview.png', expiresInSeconds: 600 },
  }));
  return () => signed;
}

/**
 * The edit route as it behaves: it names media rows by id, refuses an id the
 * post no longer has and a new upload under a key the post already has, and
 * answers a save with the rows' new ids.
 */
async function answerTheEditRoute(page: Page) {
  const saves: Array<{ title?: string; mediaItems?: SubmittedMedia[] }> = [];
  let keysByRowId = new Map([[POST.mediaRowId, POST.mediaKey]]);
  await page.route(`**/api/posts/${POST.id}`, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as { title?: string; mediaItems?: SubmittedMedia[] };
    saves.push(body);
    const keys: string[] = [];
    for (const item of body.mediaItems ?? []) {
      const key = item.existingId ? keysByRowId.get(item.existingId) : item.mediaKey;
      const refusal = item.existingId && !key
        ? 'An existing media item no longer belongs to this post.'
        : !item.existingId && key && [...keysByRowId.values()].includes(key)
          ? 'New uploads must use a new post media key.'
          : null;
      if (refusal || !key) {
        await route.fulfill({ status: 400, json: { error: refusal ?? 'Post media metadata is invalid.' } });
        return;
      }
      keys.push(key);
    }
    const rows = keys.map((mediaKey, index) => ({ id: `e2e-row-save-${saves.length}-${index}`, mediaKey }));
    keysByRowId = new Map(rows.map((row) => [row.id, row.mediaKey]));
    await route.fulfill({
      json: {
        success: true,
        postId: POST.id,
        visibility: 'public',
        showcasePath: `/showcase/${POST.id}`,
        ownerPath: `/post/${POST.id}/edit`,
        resourceBundlePath: `/showcase/${POST.id}#recipe`,
        resourceBundleStatus: null,
        mediaItems: rows,
      },
    });
  });
  return saves;
}

test.describe('post composer, an edit saved twice', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
      supabaseSessionCookie(),
    ]);
  });

  test('a picture added and saved is saved again by its new id', async ({ page }) => {
    // From 1024px the phone bar is gone and the Publish section's buttons are the ones on screen.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route('**/api/source-tools', (route) => route.fulfill({ json: { tools: [] } }));
    const uploadsSigned = await answerTheUpload(page);
    const saves = await answerTheEditRoute(page);

    await page.goto(`/post/${POST.id}/edit`);
    await expect(page.getByRole('heading', { name: /update post/i })).toBeVisible(COLD_PAGE);
    await expect(page.getByRole('textbox', { name: /^title/i })).toHaveValue(POST.title);

    await page.locator('input[type="file"]').first().setInputFiles(path.join(__dirname, 'fixtures/blue.png'));
    await expect(page.getByText('2 of 5 media added')).toBeVisible();

    const saveChanges = page.getByRole('button', { name: /^save changes/i });
    await saveChanges.click();
    await expect(page.getByText('Changes saved')).toBeVisible();
    expect(saves[0].mediaItems).toEqual([
      { existingId: POST.mediaRowId },
      expect.objectContaining({ storagePath: 'uploads/workflow-user/e2e-added.png' }),
    ]);

    await page.getByRole('textbox', { name: /^title/i }).fill(`${POST.title}, typo fixed`);
    await saveChanges.click();
    await expect.poll(() => saves.length).toBe(2);
    await expect(page.getByText('Changes saved')).toBeVisible();
    await expect(page.locator('#post-composer-form').getByRole('alert')).toHaveCount(0);

    expect(saves[1]).toMatchObject({ title: `${POST.title}, typo fixed` });
    expect(saves[1].mediaItems).toEqual([
      { existingId: 'e2e-row-save-1-0' },
      { existingId: 'e2e-row-save-1-1' },
    ]);
    // The added picture went up once; the second save named it.
    expect(uploadsSigned()).toBe(1);
  });
});
