import { expect, test, type Page, type Request, type Route } from '@playwright/test';

import ownPost from './fixtures/post-composer-saved-twice.json';

/**
 * What a creator types into the post composer before the page's script has run is what the
 * composer keeps and sends (2026-11-06).
 *
 * The composer's server render draws its form, so on a slow connection a creator can start typing
 * first. React never hears that typing, and this React build hydrates the fields without reading
 * them back: the title's counter said 0, the next render (any click) wrote the drawn text back
 * over the title, the post text, the price and the recipe preview, and Publish or Save sent what
 * the server had drawn. /contact and /login lost their fields the same way
 * (contact-typed-before-script.spec.ts).
 *
 * The page's own chunk is held until the fields are filled, and nothing is pressed before React
 * has committed the page's hydration (.claude/rules/e2e.md): the document's root no longer marks
 * its tree dehydrated, with no Suspense or Activity boundary between it and the composer.
 *
 * The edit page reads its post on the server, which tests/e2e/support/supabase-server-stub.cjs
 * answers with fixtures/post-composer-saved-twice.json (post-composer-edit-saves-twice.spec.ts).
 *
 * Each field's checks are soft, so a failing run names every field that lost its text, not only
 * the first.
 */

const COLD_PAGE = { timeout: 45_000 };
test.describe.configure({ timeout: 120_000 });

const TITLE = 'Product demo with soft window light';
const BODY = 'A note that stands on its own for the community.';
const PREVIEW = 'The full prompt and the settings I used.';
// 250 credits: $2.50, where the 10 the page opens on is $0.10.
const PRICE = '250';

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

/** Holds the page's own script chunk until `release`; every request for it waits. */
async function holdPageChunk(page: Page, path: RegExp) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunk = { requests: 0 };
  await page.route(path, async (route) => {
    chunk.requests += 1;
    await gate;
    await route.continue();
  });
  return { requests: () => chunk.requests, release: () => release() };
}

/** Whether React has committed the page's hydration (login-typed-before-script.spec.ts). */
function hydrationCommitted(page: Page) {
  return page.evaluate(() => {
    type HostRoot = { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } };
    const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
    const root = key ? (document as unknown as Record<string, HostRoot>)[key] : undefined;
    return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
  });
}

/** Opens `path` with its chunk held, runs `fill` on the server's HTML, then lets the script run. */
async function fillBeforeScript(page: Page, path: string, chunkPath: RegExp, fill: () => Promise<void>) {
  const chunk = await holdPageChunk(page, chunkPath);
  // No timeout of its own: the run's first request for the route waits for its compile.
  await page.goto(path, { waitUntil: 'commit' });
  await expect(page.getByRole('textbox', { name: /^title/i })).toBeVisible(COLD_PAGE);
  // Else the page's script was never asked for here, and the filling below would reach a live page.
  await expect.poll(chunk.requests, { ...COLD_PAGE, message: 'the page asks for its own chunk, which is held' }).toBeGreaterThan(0);
  await fill();
  expect(await hydrationCommitted(page), 'the filling reached the server’s HTML, before React').toBe(false);
  chunk.release();
  await expect.poll(() => hydrationCommitted(page), { ...COLD_PAGE, message: 'React commits the page’s hydration' }).toBe(true);
}

/** The fields of a post the composer sends as a form. */
async function sentForm(request: Request): Promise<Record<string, string>> {
  const sent = request.postDataBuffer();
  const response = new Response(sent ? new Uint8Array(sent) : null, { headers: { 'content-type': request.headers()['content-type'] ?? '' } });
  const form = await response.formData();
  return Object.fromEntries([...form.entries()].map(([name, value]) => [name, String(value)]));
}

const NEW_POST_CHUNK = /\/_next\/static\/chunks\/app\/post\/new\/page\.js(\?|$)/;
const EDIT_POST_CHUNK = /\/_next\/static\/chunks\/app\/post\/(%5Bid%5D|\[id\])\/edit\/page\.js(\?|$)/;

test.describe('post composer, typed before its script runs', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
    await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: baseURL ?? 'http://127.0.0.1:3100' }]);
  });

  test('a new post: the title and the post text typed early are counted, kept and published', async ({ page }) => {
    const sent: Record<string, string>[] = [];
    await page.route('**/api/source-tools**', (route) => json(route, { tools: [] }));
    await page.route('**/api/profile', (route) => json(route, READY_PROFILE));
    await page.route('**/api/posts', async (route) => {
      sent.push(await sentForm(route.request()));
      return json(route, {
        postId: 'post-e2e-typed-early',
        showcasePath: '/showcase/post-e2e-typed-early',
        ownerPath: '/post/post-e2e-typed-early/edit',
        visibility: 'public',
        resourceBundleStatus: null,
      });
    });
    const title = page.getByRole('textbox', { name: /^title/i });
    const body = page.getByRole('textbox', { name: /^(post text|story)/i });

    await fillBeforeScript(page, '/post/new', NEW_POST_CHUNK, async () => {
      await title.fill(TITLE);
      await body.fill(BODY);
    });

    // A render of the whole form: a text post.
    await page.getByRole('radio', { name: /^text$/i }).click();
    await expect.soft(title).toHaveValue(TITLE);
    await expect.soft(page.getByText(`${TITLE.length}/100`, { exact: true })).toBeVisible();
    await expect.soft(page.getByText(`${BODY.length}/2000`, { exact: true })).toBeVisible();
    await expect.soft(page.getByRole('textbox', { name: /^post text/i })).toHaveValue(BODY);

    await page.getByRole('button', { name: /publish public/i }).last().click();
    await expect.poll(() => sent.length, { message: 'the composer posts to /api/posts' }).toBe(1);
    expect.soft(sent[0]).toMatchObject({ title: TITLE, body: BODY, postFormat: 'text' });
  });

  test('a paid recipe: the price and the preview typed early are kept and priced', async ({ page }) => {
    await page.route('**/api/source-tools**', (route) => json(route, { tools: [] }));
    await page.route('**/api/profile', (route) => json(route, READY_PROFILE));
    const price = page.getByRole('spinbutton', { name: /price in credits/i });
    const preview = page.getByRole('textbox', { name: /^recipe preview/i });

    await fillBeforeScript(page, '/post/new?resourceMode=paid', NEW_POST_CHUNK, async () => {
      await price.fill(PRICE);
      await preview.fill(PREVIEW);
    });

    await expect.soft(page.getByText(/^Buyers pay \$2\.50 · /)).toBeVisible();
    await expect.soft(page.getByText(`${PREVIEW.length}/180`, { exact: true })).toBeVisible();
    // A render of the whole form: the title typed once the script has run.
    await page.getByRole('textbox', { name: /^title/i }).fill(TITLE);
    await expect.soft(price).toHaveValue(PRICE);
    await expect.soft(preview).toHaveValue(PREVIEW);
    await expect.soft(page.getByText(/^Buyers pay \$2\.50 · /)).toBeVisible();
  });

  test('an edit: a title retyped and post text typed early are what Save changes saves', async ({ page }) => {
    // From 1024px the phone bar is gone and the Publish section's buttons are the ones on screen.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route('**/api/source-tools**', (route) => json(route, { tools: [] }));
    const saves: Array<{ title?: string | null; body?: string | null }> = [];
    await page.route(`**/api/posts/${ownPost.post.id}`, async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      const sentBody = route.request().postDataJSON() as { title?: string | null; body?: string | null; mediaItems?: unknown[] };
      saves.push(sentBody);
      return json(route, {
        success: true,
        postId: ownPost.post.id,
        visibility: 'public',
        showcasePath: `/showcase/${ownPost.post.id}`,
        ownerPath: `/post/${ownPost.post.id}/edit`,
        resourceBundlePath: `/showcase/${ownPost.post.id}#recipe`,
        resourceBundleStatus: null,
        mediaItems: ownPost.media.map((row) => ({ id: row.id, mediaKey: row.media_key })),
      });
    });
    const retitled = `${ownPost.post.title}, retitled early`;
    const title = page.getByRole('textbox', { name: /^title/i });
    const body = page.getByRole('textbox', { name: /^(post text|story)/i });

    await fillBeforeScript(page, `/post/${ownPost.post.id}/edit`, EDIT_POST_CHUNK, async () => {
      await expect(title).toHaveValue(ownPost.post.title);
      await title.fill(retitled);
      await body.fill(BODY);
    });

    await page.getByRole('button', { name: /^save changes/i }).click();
    await expect.poll(() => saves.length, { message: 'the composer saves the post' }).toBe(1);
    expect.soft(saves[0]).toMatchObject({ title: retitled, body: BODY });
    await expect.soft(page.getByText('Changes saved')).toBeVisible();
    await expect.soft(title).toHaveValue(retitled);
    await expect.soft(body).toHaveValue(BODY);
  });
});
