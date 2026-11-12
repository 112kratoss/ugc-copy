import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import freeRemixPost from './fixtures/creation-post-free-recipe.json';
import creatorProfile from './fixtures/creator-profile.json';

// Owner, 2026-11-12: on a post whose free recipe brings its Remix, "Remix · Free" was a link to
// the recipe section a few pixels under it, so the click did nothing a person could see. It takes
// the free recipe and opens the remix in the one click, as the feed card's and the app's Remix do.
// The dev server answers the post's reads (support/supabase-server-stub.cjs,
// fixtures/creation-post-free-recipe.json); the claim and the remix start are answered here.
// The page's other links to the recipe ring it, so their click shows too, and the reel's Remix
// (Explore, a creator's page) takes a free recipe and remixes in one tap where it took two.

// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };
const REMIX_PAGE = `/create-image?remix=${freeRemixPost.post.generation_id}`;

test.describe.configure({ timeout: 180_000 });

function base64url(value: string) {
  return Buffer.from(value).toString('base64url');
}

// The E2E user (src/lib/e2e-auth.ts) as Supabase's auth describes them to the browser.
const user = {
  id: 'workflow-user',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'workflow-user@example.com',
  is_anonymous: false,
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
const session = {
  access_token: [
    base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64url(JSON.stringify({
      sub: user.id, aud: 'authenticated', role: 'authenticated', exp: EXPIRES_AT,
      email: user.email, is_anonymous: false, session_id: 'e2e-session',
    })),
    'e2e-signature',
  ].join('.'),
  token_type: 'bearer',
  expires_in: 365 * 24 * 3600,
  expires_at: EXPIRES_AT,
  refresh_token: 'e2e-refresh-token',
  user,
};

/** Signed in as the E2E user, who is not the post's creator and has not taken its recipe. */
async function signIn(context: BrowserContext) {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  const cookie = `sb-example-auth-token=base64-${base64url(JSON.stringify(session))}`;
  await context.addInitScript((value) => {
    document.cookie = `${value}; path=/; SameSite=Lax`;
  }, cookie);
  await context.route('https://example.supabase.co/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') return route.fulfill({ json: user });
    if (pathname === '/auth/v1/token') return route.fulfill({ json: session });
    const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
    if (pathname === '/rest/v1/profiles') {
      const row = { display_name: 'E2E Creator', avatar_url: null, credits: 25 };
      return route.fulfill({ json: single ? row : [row] });
    }
    if (pathname.startsWith('/rest/v1/')) return route.fulfill(single ? { status: 406, json: {} } : { json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
}

/** The API calls the click makes, in the order the browser sent them. */
async function answerApi(page: Page, calls: string[]) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await page.route(`**/api/posts/${freeRemixPost.post.id}/resource-bundle/unlock-free`, (route) => {
    calls.push(`${route.request().method()} unlock-free`);
    return route.fulfill({ json: { success: true } });
  });
  await page.route('**/api/showcase/remix', (route) => {
    calls.push(`${route.request().method()} remix ${route.request().postData() ?? ''}`);
    return route.fulfill({ json: { success: true, redirectTo: REMIX_PAGE } });
  });
}

test('Remix · Free on the post page takes the free recipe and opens the remix in one click', async ({ page, context }, testInfo) => {
  const calls: string[] = [];
  await signIn(context);
  await answerApi(page, calls);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/showcase/${freeRemixPost.post.id}`);

  await expect(page.getByRole('heading', { level: 1, name: freeRemixPost.post.title })).toBeVisible(COLD_PAGE);
  const remix = page.getByRole('button', { name: `Get the free recipe and remix ${freeRemixPost.post.title}` });
  await expect(remix).toBeVisible();
  await expect(remix).toHaveText('Remix · Free');
  // The old pill: a link to the recipe section, which this page still has just below.
  await expect(page.locator('a[href="#recipe"]', { hasText: 'Remix · Free' })).toHaveCount(0);
  // The session reaches the page after its script runs: until then the shell offers Sign in, and
  // a Remix pressed then would lead to /login.
  await expect(page.getByRole('link', { name: /^Sign in/ })).toHaveCount(0, COLD_PAGE);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await remix.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('post-page-remix-free.png') });

  // A press before the page's script has taken the row over is dropped (the fifth gotcha in
  // .claude/rules/e2e.md), so the click is repeated until the page answers it with the claim.
  await expect(async () => {
    if (calls.length === 0) await remix.click({ timeout: 2_000 });
    expect(calls.length).toBeGreaterThan(0);
  }).toPass({ timeout: 45_000 });

  // The remix page compiles on this first request for it.
  await page.waitForURL((url) => `${url.pathname}${url.search}` === REMIX_PAGE, { timeout: 90_000, waitUntil: 'commit' });
  expect(calls).toEqual([
    'POST unlock-free',
    `POST remix ${JSON.stringify({ postId: freeRemixPost.post.id })}`,
  ]);
});

test('the post page\'s link to its recipe rings the recipe, so the click shows', async ({ page, context }) => {
  await signIn(context);
  await answerApi(page, []);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/showcase/${freeRemixPost.post.id}`);

  const jump = page.getByTestId('recipe-jump-link');
  await expect(jump).toBeVisible(COLD_PAGE);
  await expect(jump).toContainText('Free recipe');
  const ringing = () => page.evaluate(() => (document.getElementById('recipe')?.getAnimations() ?? [])
    .some((animation) => animation.id === 'recipe-jump'));
  expect(await ringing()).toBe(false);

  // A press before the page's script has taken the link over only jumps: repeated until it rings.
  await expect(async () => {
    await jump.click({ timeout: 2_000 });
    expect(await ringing()).toBe(true);
  }).toPass({ timeout: 45_000 });
  await expect(page).toHaveURL(/#recipe$/);
});

// A post as the reel reads it (`/api/showcase/posts/<id>`): made in the app, its Remix behind a
// free recipe this reader has not taken. It is drawn on the one creator page the dev server can
// answer offline, the E2E creator's (fixtures/creator-profile.json), so it carries that creator's
// name; the reel reads the lock from the post alone, whoever its creator is.
const REEL_POST = 'e2ef4ee0-0000-4000-8000-0000000000b1';
const REEL_REMIX_PAGE = `/create-image?remix=e2ef4ee0-0000-4000-8000-0000000000b2&remixPost=${REEL_POST}`;
const reelItem = {
  id: REEL_POST,
  mediaUrl: 'https://cdn.example.test/reel.png',
  mediaKind: 'image',
  model: 'nano-banana-2',
  title: 'Harbour at first light',
  prompt: '',
  body: '',
  category: 'image',
  postFormat: 'media',
  saveCount: 0,
  remixCount: 0,
  commentCount: 0,
  createdAt: '2026-10-01T10:00:00.000Z',
  creator: { id: creatorProfile.id, username: creatorProfile.username, name: creatorProfile.display_name, avatar: null },
  isSaved: false,
  sourceKind: 'magicbooklet',
  sourceTool: null,
  generationId: 'e2ef4ee0-0000-4000-8000-0000000000b2',
  canRemix: false,
  remixCapability: 'unlock_required',
  remixTarget: 'image',
  visibility: 'public',
  asset: {
    id: 'e2ef4ee0-0000-4000-8000-0000000000b3',
    postId: REEL_POST,
    title: 'The recipe',
    accessMode: 'free',
    priceUsdCents: 0,
    priceQuote: { currency: 'USD', amountSubunits: 0, formatted: 'Free', note: null },
    previewText: '',
    allowRemix: true,
    resourceKinds: ['prompt'],
    itemCounts: { prompt: 1 },
    lockedPreview: {
      resourceKinds: ['prompt'],
      attachmentPreviews: [],
      itemCounts: { prompt: 1 },
      itemPreviews: [{ type: 'prompt', title: 'Prompt', role: 'primary', sectionId: null, remixUse: 'none' }],
      hasPrompt: true,
      hasNotes: false,
      hasWorkflow: false,
      hasRemix: true,
      updatedAt: '2026-10-01T10:00:00.000Z',
    },
  },
};

test('the reel\'s Remix takes a free recipe and opens the remix in one tap', async ({ page, context }) => {
  const calls: string[] = [];
  let taken = false;
  await signIn(context);
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await page.route(`**/api/showcase/posts/${REEL_POST}`, (route) => route.fulfill({ json: { item: reelItem } }));
  await page.route(`**/api/posts/${REEL_POST}/resource-bundle`, (route) => route.fulfill({
    json: {
      bundle: taken
        ? {
          viewerCanAccess: true,
          viewerIsOwner: false,
          resources: { promptText: 'A harbour at first light.', notesMarkdown: null, workflowShareUrl: null, attachments: [], allowRemix: true },
        }
        : { viewerCanAccess: false, viewerIsOwner: false, resources: null },
    },
  }));
  await page.route(`**/api/posts/${REEL_POST}/resource-bundle/unlock-free`, (route) => {
    calls.push(`${route.request().method()} unlock-free`);
    taken = true;
    return route.fulfill({ json: { success: true } });
  });
  await page.route('**/api/showcase/remix', (route) => {
    calls.push(`${route.request().method()} remix`);
    return route.fulfill({ json: { success: true, redirectTo: REEL_REMIX_PAGE } });
  });
  await page.route('https://cdn.example.test/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/creators/${creatorProfile.username}?post=${REEL_POST}`);

  const remix = page.getByRole('button', { name: `Remix: get the free recipe for ${reelItem.title} and remix it` });
  await expect(remix).toBeVisible(COLD_PAGE);
  await remix.click();

  await page.waitForURL((url) => `${url.pathname}${url.search}` === REEL_REMIX_PAGE, { timeout: 90_000, waitUntil: 'commit' });
  // One tap: the recipe first, then the remix, and neither twice.
  expect(calls).toEqual(['POST unlock-free', 'POST remix']);
});
