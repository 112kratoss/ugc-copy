import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import freeRecipePost from './fixtures/creation-post-free-recipe.json';

// The owner's screen recording of the live site, 2026-11-16 (build 24ac32b80, signed in, Chrome on a
// laptop): every post opened from the Marketplace drew its Comments card with "Sign in to join the
// conversation" and its rail without "Report user · Block user", though the top bar already showed
// the reader's avatar and balance. About 0.2 s later the composer took the sign-in link's place and
// the row came in, pushing Comments down. The post page checks the session in the browser
// (`OptionalAuth`: a provider of its own on each page, which a client navigation starts again), and
// both parts drew a reader whose session was still being checked as a signed-out visitor.
//
// Here the browser holds a session cookie and no E2E bypass, so the page's provider checks it with
// Supabase as production's does, and the test holds that check (`/auth/v1/user`) until it has seen
// the page drawn meanwhile. Every frame the rail is drawn in is recorded. The dev server answers the
// post's reads (support/supabase-server-stub.cjs, fixtures/creation-post-free-recipe.json: a post
// with a free recipe, as the recording's were); the thread is answered here.

const ORIGIN = 'http://127.0.0.1:3100';
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };
const POST_ID = freeRecipePost.post.id;
const POST_PATH = `/showcase/${POST_ID}`;
const TITLE = freeRecipePost.post.title;
const COMMENT = 'The light on the water is perfect.';

test.describe.configure({ timeout: 180_000 });

function base64Url(text: string) {
  return Buffer.from(text).toString('base64url');
}

const user = {
  id: 'workflow-user',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'workflow-user@example.com',
  is_anonymous: false,
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { name: 'Workflow User' },
  identities: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

/** The browser's session checks (`/auth/v1/user`), answered at once or held from `hold()` to `release()`. */
function sessionChecks() {
  let gate: Promise<void> | null = null;
  let open = () => {};
  let held = 0;
  return {
    hold() {
      held = 0;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open();
    },
    /** How many checks have been asked for since `hold()`. */
    held: () => held,
    async answer() {
      if (!gate) return;
      held += 1;
      await gate;
    },
  };
}

/**
 * Signed in as a browser is: a session cookie for the placeholder project, sent with every request,
 * and no E2E bypass, which would hand the page's provider its session at once.
 */
async function signIn(context: BrowserContext) {
  const checks = sessionChecks();
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: user.id, aud: 'authenticated', role: 'authenticated', exp: 4_102_444_800, session_id: 'e2e-session',
  }));
  const session = {
    access_token: `${header}.${payload}.c2lnbmF0dXJl`,
    refresh_token: 'e2e-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4_102_444_800,
    user,
  };
  await context.addCookies([
    { name: 'sb-example-auth-token', value: `base64-${base64Url(JSON.stringify(session))}`, url: ORIGIN },
  ]);
  await context.route('https://example.supabase.co/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') {
      await checks.answer();
      return route.fulfill({ json: user }).catch(() => undefined);
    }
    if (pathname === '/auth/v1/token') return route.fulfill({ json: session });
    const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
    if (pathname === '/rest/v1/profiles') {
      const row = { display_name: 'Workflow User', avatar_url: null, credits: 22, promotional_credits: 0 };
      return route.fulfill({ json: single ? row : [row] });
    }
    if (pathname.startsWith('/rest/v1/')) return route.fulfill(single ? { status: 406, json: {} } : { json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  return checks;
}

/** Every API call unanswered but the post's thread: one comment by someone else. */
async function answerApi(page: Page) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await page.route(`**/api/showcase/posts/${POST_ID}/comments**`, (route) => route.fulfill({
    json: {
      postId: POST_ID,
      postCreatorId: freeRecipePost.creator.id,
      commentCount: 1,
      comments: [{
        id: 'c-1',
        parentId: null,
        body: COMMENT,
        status: 'active',
        createdAt: '2026-11-10T08:00:00.000Z',
        replyCount: 0,
        author: { id: 'someone-else', username: 'lena', displayName: 'Lena', avatarUrl: null },
        likeCount: 2,
        viewerReaction: null,
        editedAt: null,
        hearted: false,
        pinned: false,
      }],
      pageInfo: { hasMore: false, nextOffset: null, limit: 20, offset: 0 },
    },
  }));
}

type Frame = {
  path: string;
  /** Comments' top from the rail's own top: what a row drawn late above it moves. */
  commentsOffset: number | null;
  signInShown: boolean;
  reportUserShown: boolean;
  composerShown: boolean;
  /** The thread's comments drawn. */
  comments: number;
};

/**
 * Records every frame whose drawing of the post's rail differs from the last, from the document's
 * first frame on: its first frames are the server's HTML under the stylesheet and the pre-paint
 * script, before the page's own scripts have run.
 */
const RECORDER = `(() => {
  const frames = [];
  window.__railFrames = frames;
  let last = '';
  const shown = (element) => Boolean(element && element.getClientRects().length > 0);
  function sample() {
    const rail = document.querySelector('[data-testid="canonical-post-actions"]');
    if (rail) {
      const comments = rail.querySelector('[data-testid="canonical-post-comments"]');
      const signIn = Array.from(rail.querySelectorAll('a'))
        .find((link) => link.textContent.includes('Sign in to join the conversation'));
      const reportUser = Array.from(rail.querySelectorAll('button'))
        .find((button) => button.textContent.trim() === 'Report user');
      const frame = {
        path: location.pathname,
        commentsOffset: comments
          ? Math.round(comments.getBoundingClientRect().top - rail.getBoundingClientRect().top)
          : null,
        signInShown: shown(signIn),
        reportUserShown: shown(reportUser),
        composerShown: shown(rail.querySelector('textarea[aria-label="Write a comment"]')),
        comments: rail.querySelectorAll('ol[aria-label="Comment thread"] > li').length,
      };
      const key = JSON.stringify(frame);
      if (key !== last) {
        last = key;
        frames.push(frame);
      }
    }
    if (!window.__railFramesDone) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();`;

async function recordedFrames(page: Page): Promise<Frame[]> {
  const frames = await page.evaluate(() => {
    const record = window as unknown as { __railFrames: Frame[]; __railFramesDone?: boolean };
    record.__railFramesDone = true;
    return record.__railFrames;
  });
  return frames.filter((frame) => frame.path === POST_PATH);
}

/** The rail as the reader keeps it: the same in every frame it was drawn in. */
function expectSteadyRail(frames: Frame[], reader: 'signed in' | 'signed out') {
  const all = JSON.stringify(frames);
  expect(frames.length, 'frames of the rail').toBeGreaterThan(0);
  // A signed-in reader is never offered sign-in, and a signed-out one always is.
  expect(frames.filter((frame) => frame.signInShown !== (reader === 'signed out')), all).toEqual([]);
  // Report user and Block user are a signed-in reader's who is not the post's creator.
  expect(frames.filter((frame) => frame.reportUserShown !== (reader === 'signed in')), all).toEqual([]);
  // Nothing drawn late above Comments moved it.
  const offsets = new Set(frames.map((frame) => frame.commentsOffset).filter((offset) => offset !== null));
  expect([...offsets], all).toHaveLength(1);
  // The thread, once drawn, is not taken away and drawn again.
  const firstDrawn = frames.findIndex((frame) => frame.comments > 0);
  expect(firstDrawn, all).toBeGreaterThanOrEqual(0);
  expect(frames.slice(firstDrawn).filter((frame) => frame.comments === 0), all).toEqual([]);
}

const rail = (page: Page) => page.getByTestId('canonical-post-actions');
const composer = (page: Page) => rail(page).getByRole('textbox', { name: 'Write a comment' });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a post opened from the Marketplace draws a signed-in reader\'s composer and rail from its first frame, while the session is checked', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const checks = await signIn(context);
  await answerApi(page);
  await page.addInitScript(RECORDER);

  // Offline, the storefront's own server read fails and it draws its error card; the way out of it
  // is a client navigation as a recipe's link makes, which is what this is about.
  await page.goto('/marketplace');
  // The top bar has the reader before the post is opened, as the recording's did.
  await expect(page.getByRole('link', { name: /^22 credits/ })).toBeVisible(COLD_PAGE);

  checks.hold();
  await page.evaluate((href) => (
    window as unknown as { next: { router: { push: (target: string) => void } } }
  ).next.router.push(href), POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  // The post page's provider is checking the session: the rail as it is drawn meanwhile.
  await expect.poll(checks.held, COLD_PAGE).toBeGreaterThan(0);
  await expect(composer(page)).toHaveCount(0);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await rail(page).screenshot({ path: testInfo.outputPath('rail-while-session-checked.png') });
  // Report user and Block user hold their place, and wait for the session to act. Soft, so a rail
  // without them still reaches the frames below, which say what was drawn instead.
  await expect.soft(rail(page).getByRole('button', { name: 'Report user' })).toBeDisabled({ timeout: 2_000 });

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByRole('button', { name: 'Report user' })).toBeEnabled();
  await expect(rail(page).getByRole('button', { name: 'Block user' })).toBeEnabled();
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  await rail(page).screenshot({ path: testInfo.outputPath('rail-settled.png') });

  const frames = await recordedFrames(page);
  // Frames drawn while the session was checked, and after it.
  expect(frames.some((frame) => !frame.composerShown), JSON.stringify(frames)).toBe(true);
  expect(frames.at(-1)?.composerShown, JSON.stringify(frames)).toBe(true);
  expectSteadyRail(frames, 'signed in');
});

test('a signed-in reader who loads a post draws its composer and rail from the first frame, while the session is checked', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const checks = await signIn(context);
  checks.hold();
  await answerApi(page);
  await page.addInitScript(RECORDER);

  await page.goto(POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  // A check is asked for once the page's script has run.
  await expect.poll(checks.held, COLD_PAGE).toBeGreaterThan(0);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await rail(page).screenshot({ path: testInfo.outputPath('rail-loaded-while-session-checked.png') });

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByRole('button', { name: 'Report user' })).toBeEnabled();
  await expect(rail(page).getByText(COMMENT)).toBeVisible();

  const frames = await recordedFrames(page);
  expect(frames.some((frame) => !frame.composerShown), JSON.stringify(frames)).toBe(true);
  expect(frames.at(-1)?.composerShown, JSON.stringify(frames)).toBe(true);
  expectSteadyRail(frames, 'signed in');
});

test('a signed-out reader is offered sign-in where the composer goes, and no Report user, in every frame', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().route('https://example.supabase.co/**', (route) => route.fulfill({ status: 401, json: {} }));
  await answerApi(page);
  await page.addInitScript(RECORDER);

  // Loaded, then opened again by a client navigation from the Marketplace.
  await page.goto(POST_PATH);
  // The thread is read by the page's script: it has run.
  await expect(rail(page).getByText(COMMENT)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByRole('link', { name: 'Sign in to join the conversation' })).toBeVisible();
  expectSteadyRail(await recordedFrames(page), 'signed out');

  await page.goto('/marketplace');
  await page.evaluate((href) => (
    window as unknown as { next: { router: { push: (target: string) => void } } }
  ).next.router.push(href), POST_PATH);
  await expect(rail(page).getByText(COMMENT)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByRole('link', { name: 'Sign in to join the conversation' })).toBeVisible();
  expectSteadyRail(await recordedFrames(page), 'signed out');
});
