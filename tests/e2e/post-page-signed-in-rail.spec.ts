import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';

import freeRecipePost from './fixtures/creation-post-free-recipe.json';
import plainCreationPost from './fixtures/creation-post.json';

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

/** A post the page draws: its id, address, title and creator. */
type DrawnPost = { id: string; path: string; title: string; creatorId: string };
/** The post with a free recipe, which the recording's posts were. */
const RECIPE_POST: DrawnPost = { id: POST_ID, path: POST_PATH, title: TITLE, creatorId: freeRecipePost.creator.id };
/** A picture post with no recipe at all (fixtures/creation-post.json), by a creator of its own. */
const PLAIN_POST: DrawnPost = {
  id: plainCreationPost.post.id,
  path: `/showcase/${plainCreationPost.post.id}`,
  title: plainCreationPost.post.title,
  creatorId: plainCreationPost.creator.id,
};

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

/** The post's own creator, as Supabase's auth describes them. */
const postCreator = {
  ...user,
  id: freeRecipePost.creator.id,
  email: 'free-remix-creator@example.com',
  user_metadata: { name: freeRecipePost.creator.display_name },
};

/** The account's profile row, which the top bar reads its name, picture and balance from. */
type ProfileRow = { display_name: string | null; avatar_url: string | null; credits: number; promotional_credits: number };
const WORKFLOW_PROFILE: ProfileRow = { display_name: 'Workflow User', avatar_url: null, credits: 22, promotional_credits: 0 };

/**
 * Signed in as a browser is: a session cookie for the placeholder project, sent with every request,
 * and no E2E bypass, which would hand the page's provider its session at once.
 */
async function signIn(
  context: BrowserContext,
  account: Omit<typeof user, 'user_metadata'> & { user_metadata: Record<string, unknown> } = user,
  profile: ProfileRow = WORKFLOW_PROFILE,
) {
  const checks = sessionChecks();
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: account.id, aud: 'authenticated', role: 'authenticated', exp: 4_102_444_800, session_id: 'e2e-session',
  }));
  const session = {
    access_token: `${header}.${payload}.c2lnbmF0dXJl`,
    refresh_token: 'e2e-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4_102_444_800,
    user: account,
  };
  await context.addCookies([
    { name: 'sb-example-auth-token', value: `base64-${base64Url(JSON.stringify(session))}`, url: ORIGIN },
  ]);
  await context.route('https://example.supabase.co/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') {
      await checks.answer();
      return route.fulfill({ json: account }).catch(() => undefined);
    }
    if (pathname === '/auth/v1/token') return route.fulfill({ json: session });
    const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
    if (pathname === '/rest/v1/profiles') {
      return route.fulfill({ json: single ? profile : [profile] });
    }
    if (pathname.startsWith('/rest/v1/')) return route.fulfill(single ? { status: 406, json: {} } : { json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  return { checks, accessToken: session.access_token };
}

/**
 * Every API call unanswered but the post's thread: one comment by someone else. `reads` gets the
 * Authorization of each read of the thread, null for a visitor's.
 */
async function answerApi(page: Page, reads: Array<string | null> = [], post: DrawnPost = RECIPE_POST) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await page.route(`**/api/showcase/posts/${post.id}/comments**`, (route) => {
    reads.push(route.request().headers().authorization ?? null);
    return route.fulfill({
      json: {
        postId: post.id,
        postCreatorId: post.creatorId,
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
    });
  });
}

type Frame = {
  path: string;
  /** Comments' top from the rail's own top: what a row drawn late above it moves. */
  commentsOffset: number | null;
  signInShown: boolean;
  reportUserShown: boolean;
  /** "Report post or recipe", which is everyone's but the post's creator's. */
  reportPostShown: boolean;
  /** The creator's own row, "Owner tools", or its place. */
  ownerToolsShown: boolean;
  composerShown: boolean;
  /** The initials on the composer's avatar, "" for none; null while there is no composer. */
  composerInitials: string | null;
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
      const reportPost = Array.from(rail.querySelectorAll('button'))
        .find((button) => button.textContent.trim() === 'Report post or recipe');
      const ownerTools = Array.from(rail.querySelectorAll('span'))
        .filter((span) => span.textContent.trim() === 'Owner tools');
      const composerField = rail.querySelector('textarea[aria-label="Write a comment"]');
      // The composer's row: its avatar, then the field.
      const composerRow = composerField ? composerField.closest('.flex.items-start') : null;
      const frame = {
        path: location.pathname,
        commentsOffset: comments
          ? Math.round(comments.getBoundingClientRect().top - rail.getBoundingClientRect().top)
          : null,
        signInShown: shown(signIn),
        reportUserShown: shown(reportUser),
        reportPostShown: shown(reportPost),
        ownerToolsShown: ownerTools.some(shown),
        composerShown: shown(composerField),
        composerInitials: shown(composerField) && composerRow && composerRow.firstElementChild
          ? composerRow.firstElementChild.textContent.trim()
          : null,
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

/**
 * The frames recorded so far, read once two more have passed, so the last change committed before
 * the call has been sampled. `stop: false` leaves the recorder running.
 */
async function recordedFrames(page: Page, { stop = true, path = POST_PATH } = {}): Promise<Frame[]> {
  const frames = await page.evaluate(async (stopRecording) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const record = window as unknown as { __railFrames: Frame[]; __railFramesDone?: boolean };
    if (stopRecording) record.__railFramesDone = true;
    return record.__railFrames;
  }, stop);
  return frames.filter((frame) => frame.path === path);
}

/** Lets two frames pass, so what the page has committed has been drawn, and recorded. */
async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * Waiting for the page to ask for its session check, polled often: the time a check is held for
 * comes out of its deadline (SESSION_CHECK_DEADLINE_MS, 4.5 s from when the check began).
 */
const CHECK_ASKED = { ...COLD_PAGE, intervals: [50] };

/** The rail as the reader keeps it: the same in every frame it was drawn in. */
function expectSteadyRail(frames: Frame[], reader: 'signed in' | 'signed out') {
  const all = JSON.stringify(frames);
  expect(frames.length, 'frames of the rail').toBeGreaterThan(0);
  // A signed-in reader is never offered sign-in, and a signed-out one always is.
  expect(frames.filter((frame) => frame.signInShown !== (reader === 'signed out')), all).toEqual([]);
  // Report user and Block user are a signed-in reader's who is not the post's creator.
  expect(frames.filter((frame) => frame.reportUserShown !== (reader === 'signed in')), all).toEqual([]);
  // Anyone but the creator may report the post, and only the creator has Owner tools.
  expect(frames.filter((frame) => !frame.reportPostShown || frame.ownerToolsShown), all).toEqual([]);
  // Nothing drawn late above Comments moved it.
  const offsets = new Set(frames.map((frame) => frame.commentsOffset).filter((offset) => offset !== null));
  expect([...offsets], all).toHaveLength(1);
  // The thread, once drawn, is not taken away and drawn again.
  const firstDrawn = frames.findIndex((frame) => frame.comments > 0);
  expect(firstDrawn, all).toBeGreaterThanOrEqual(0);
  expect(frames.slice(firstDrawn).filter((frame) => frame.comments === 0), all).toEqual([]);
}

/**
 * The rail as the post's creator keeps it on their own post: Owner tools, or their place, in every
 * frame, and never a report of their own post or of themselves; Comments where it stays.
 */
function expectOwnerRail(frames: Frame[]) {
  const all = JSON.stringify(frames);
  expect(frames.length, 'frames of the rail').toBeGreaterThan(0);
  expect(frames.filter((frame) => frame.reportPostShown || frame.reportUserShown), all).toEqual([]);
  expect(frames.filter((frame) => !frame.ownerToolsShown), all).toEqual([]);
  expect(frames.filter((frame) => frame.signInShown), all).toEqual([]);
  const offsets = new Set(frames.map((frame) => frame.commentsOffset).filter((offset) => offset !== null));
  expect([...offsets], all).toHaveLength(1);
}

const rail = (page: Page) => page.getByTestId('canonical-post-actions');
const composer = (page: Page) => rail(page).getByRole('textbox', { name: 'Write a comment' });

/**
 * Whether the document's React root has committed its hydration, which only the page's script
 * does: its router then takes a navigation (login-typed-before-script.spec.ts says why the root's
 * record, and not a `__reactFiber$` key, is the sign).
 */
function hydrationCommitted(page: Page) {
  return page.evaluate(() => {
    type HostRoot = { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } };
    const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
    const root = key ? (document as unknown as Record<string, HostRoot>)[key] : undefined;
    return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
  });
}

/** How long a push is given to ask the server for the post before it is taken for dropped. */
const PUSH_TAKEN_WITHIN_MS = 2_000;

/**
 * Opens the post by a client navigation, as a link of the page makes. A push made before the
 * page's script has taken the document over is dropped (the fifth gotcha in .claude/rules/e2e.md:
 * CI's run of 2026-11-16 stayed on /marketplace), so it is made after the root's commit, and made
 * again only while the router has not asked the server for the post's page: a push it has taken is
 * never repeated, since each one starts the navigation over and the post's render takes seconds
 * offline. The address is read every 100 ms, so a held session check's deadline is not spent
 * waiting to see the navigation land.
 */
async function openPostByClientNavigation(page: Page, path = POST_PATH) {
  await expect.poll(() => hydrationCommitted(page), COLD_PAGE).toBe(true);
  let taken = false;
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname === path && (url.searchParams.has('_rsc') || request.headers().rsc === '1')) taken = true;
  };
  page.on('request', onRequest);
  try {
    let lastPush = -Infinity;
    await expect.poll(async () => {
      const push = !taken && Date.now() - lastPush >= PUSH_TAKEN_WITHIN_MS;
      if (push) lastPush = Date.now();
      return page.evaluate(({ href, pushNow }) => {
        if (pushNow && window.location.pathname !== href) {
          (window as unknown as { next: { router: { push: (target: string) => void } } }).next.router.push(href);
        }
        return window.location.pathname;
      }, { href: path, pushNow: push });
    }, { ...COLD_PAGE, intervals: [100] }).toBe(path);
  } finally {
    page.off('request', onRequest);
  }
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a post opened from the Marketplace draws a signed-in reader\'s composer and rail from its first frame, while the session is checked', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks } = await signIn(context);
  await answerApi(page);
  await page.addInitScript(RECORDER);

  // Offline, the storefront's own server read fails and it draws its error card; the way out of it
  // is a client navigation as a recipe's link makes, which is what this is about.
  await page.goto('/marketplace');
  // The top bar has the reader before the post is opened, as the recording's did.
  await expect(page.getByRole('link', { name: /^22 credits/ })).toBeVisible(COLD_PAGE);

  checks.hold();
  await openPostByClientNavigation(page);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  // The post page's provider is checking the session: held only while the rail drawn meanwhile is
  // seen, well inside the check's deadline (SESSION_CHECK_DEADLINE_MS from when it began).
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);
  // Report user and Block user hold their place, and wait for the session to act. Soft, so a rail
  // without them still reaches the frames below, which say what was drawn instead.
  await expect.soft(rail(page).getByRole('button', { name: 'Report user' })).toBeDisabled({ timeout: 1_000 });

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByRole('button', { name: 'Report user' })).toBeEnabled();
  await expect(rail(page).getByRole('button', { name: 'Block user' })).toBeEnabled();
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await rail(page).screenshot({ path: testInfo.outputPath('rail-settled.png') });

  const frames = await recordedFrames(page);
  // Frames drawn while the session was checked, and after it.
  expect(frames.some((frame) => !frame.composerShown), JSON.stringify(frames)).toBe(true);
  expect(frames.at(-1)?.composerShown, JSON.stringify(frames)).toBe(true);
  expectSteadyRail(frames, 'signed in');
});

test('a signed-in reader who loads a post draws its composer and rail from the first frame, while the session is checked', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks } = await signIn(context);
  checks.hold();
  await answerApi(page);
  await page.addInitScript(RECORDER);

  await page.goto(POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  // A check is asked for once the page's script has run: held only while the rail drawn meanwhile
  // is seen, well inside the check's deadline.
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);

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
  await openPostByClientNavigation(page);
  await expect(rail(page).getByText(COMMENT)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByRole('link', { name: 'Sign in to join the conversation' })).toBeVisible();
  expectSteadyRail(await recordedFrames(page), 'signed out');
});

/** Opens Owner tools, which only the real row does once the session has named its creator. */
async function expectOwnerToolsOpen(page: Page) {
  await rail(page).getByText('Owner tools').click();
  await expect(rail(page).getByRole('link', { name: 'Edit post' })).toBeVisible();
}

// Review of #838: the page's HTML is drawn once for every visitor and crawler, and Owner tools are in
// it for the creator's browser to show before the first paint. Hidden, a link is still a link: every
// post page carried its /post/<id>/edit links, the visibility menu, Archive and Delete, and each crawl
// of an edit link is a function invocation that redirects to sign-in. The HTML holds the row alone.
test("a post page's HTML, which every visitor and crawler gets, carries no owner link or action", async ({ page }) => {
  const response = await page.request.get(POST_PATH, { timeout: 0 });
  expect(response.status()).toBe(200);
  const html = await response.text();
  // Drawn for the creator's browser to show before the first paint: the row alone.
  expect(html).toContain('Owner tools');
  expect(html).not.toContain(`/post/${POST_ID}/edit`);
  for (const action of ['Edit post', 'Manage recipe', `Visibility of ${TITLE}`]) {
    expect(html).not.toContain(action);
  }
});

// Review of #833: the server draws Report user and Block user for any browser with a session
// cookie, and on the creator's own post the row showed until the page's script found whose cookie it
// was, then went, and Comments jumped up. Before #833 the creator never saw it.
// Sweep of 2026-11-17 (build 941e2a55b): the same post drew "Report post or recipe" in Owner tools'
// place until the check named the creator, about 16 frames on a client navigation.
test("the post's creator, loading their own post, has Owner tools from the first frame and never a report row", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks } = await signIn(context, postCreator);
  checks.hold();
  await answerApi(page);
  await page.addInitScript(RECORDER);

  await page.goto(POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);

  checks.release();
  // The check names the creator, and their tools work from here on (opened after the frames are
  // read: an open row moves Comments down, as the reader asked).
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  const frames = await recordedFrames(page);
  await expectOwnerToolsOpen(page);
  expectOwnerRail(frames);
});

test("the post's creator, opening their own post from the Marketplace, has Owner tools from the first frame and never a report row", async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks } = await signIn(context, postCreator);
  await answerApi(page);
  await page.addInitScript(RECORDER);

  await page.goto('/marketplace');
  await expect(page.getByRole('link', { name: /^22 credits/ })).toBeVisible(COLD_PAGE);

  checks.hold();
  await openPostByClientNavigation(page);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await rail(page).screenshot({ path: testInfo.outputPath('owner-rail-while-session-checked.png') });

  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  const frames = await recordedFrames(page);
  await expectOwnerToolsOpen(page);
  expectOwnerRail(frames);
});

// Review of #833: Supabase's check has no deadline of its own, and a stalled one held the thread
// unread, the composer's place inert and Report user doing nothing for as long as it stalled.
test('a session check that outlasts its deadline draws the reader as a visitor until a late answer names them', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { checks, accessToken } = await signIn(context);
  checks.hold();
  const reads: Array<string | null> = [];
  await answerApi(page, reads);

  await page.goto(POST_PATH);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  // The check has been asked for and is still within its deadline: the composer's place is held.
  await expect(rail(page).getByText('Add a comment…')).toBeVisible();
  // Past the deadline (SESSION_CHECK_DEADLINE_MS, 4.5 s from when the check began): the visitor's
  // page, as before the check was waited for.
  await expect(rail(page).getByRole('link', { name: 'Sign in to join the conversation' })).toBeVisible({ timeout: 15_000 });
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
  await expect(rail(page).getByRole('button', { name: 'Report user' })).toHaveCount(0);
  expect(reads).toEqual([null]);

  // The answer comes at last: the reader's composer and row, and the thread read again for them.
  checks.release();
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(rail(page).getByRole('button', { name: 'Report user' })).toBeEnabled();
  await expect.poll(() => reads).toEqual([null, `Bearer ${accessToken}`]);
  await expect(rail(page).getByText(COMMENT)).toBeVisible();
});

// Sweep of 2026-11-17 (build 941e2a55b), signed in as @magicbooklet: the composer's avatar read "I",
// the first letter of the sign-in email (the account has no name in Supabase's user_metadata), where
// the top bar read "MB", from the profile's name, "Magic Booklet".
const namelessReader = { ...user, email: 'ivy.reader@example.com', user_metadata: {} };
const MAGIC_BOOKLET_PROFILE: ProfileRow = { display_name: 'Magic Booklet', avatar_url: null, credits: 22, promotional_credits: 0 };

/** The composer's avatar as the last recorded frame drew it. */
async function composerInitials(page: Page) {
  return (await recordedFrames(page, { stop: false })).at(-1)?.composerInitials ?? null;
}

/** Blank while the profile is read, then the profile's name: never a name it is not. */
function expectComposerNamedByProfile(frames: Frame[], initials: string) {
  const all = JSON.stringify(frames);
  expect(frames.filter((frame) => frame.composerInitials !== null
    && frame.composerInitials !== ''
    && frame.composerInitials !== initials), all).toEqual([]);
  expect(frames.at(-1)?.composerInitials, all).toBe(initials);
}

test("the composer's avatar names the reader as the top bar does, from their profile, never by the sign-in email", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(context, namelessReader, MAGIC_BOOKLET_PROFILE);
  await answerApi(page);
  await page.addInitScript(RECORDER);

  // Loaded...
  await page.goto(POST_PATH);
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect(page.getByRole('button', { name: 'Open account menu for Magic Booklet' })).toBeVisible();
  await expect.poll(() => composerInitials(page)).toBe('MB');
  expectComposerNamedByProfile(await recordedFrames(page), 'MB');

  // ...and opened from another page, by a client navigation.
  await page.goto('/marketplace');
  await expect(page.getByRole('button', { name: 'Open account menu for Magic Booklet' })).toBeVisible(COLD_PAGE);
  await openPostByClientNavigation(page);
  await expect(composer(page)).toBeVisible(COLD_PAGE);
  await expect.poll(() => composerInitials(page)).toBe('MB');
  expectComposerNamedByProfile(await recordedFrames(page), 'MB');
});

// Sweep of 2026-11-17 (build 941e2a55b): every post a signed-in reader opened that had no recipe
// asked for theirs, which the server answered 404, and Chrome logged "Failed to load resource" for
// it on every such post.
test('a signed-in reader of a post with no recipe logs no failed recipe read, loaded or opened from another page', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(context);
  await answerApi(page, [], PLAIN_POST);
  const recipeReads: string[] = [];
  await page.route(`**/api/posts/${PLAIN_POST.id}/resource-bundle**`, (route) => {
    const url = new URL(route.request().url());
    recipeReads.push(`${url.pathname}${url.search}`);
    // As the route answers for a post with no recipe (post-resource-bundle-route-adapter-service.ts):
    // 404, or none when it is asked to answer an absent recipe as none.
    return url.searchParams.get('absent') === 'none'
      ? route.fulfill({ json: { success: true, bundle: null } })
      : route.fulfill({ status: 404, json: { error: 'Resource bundle not found.' } });
  });
  const failedRecipeLoads: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.location().url.includes('/resource-bundle')) {
      failedRecipeLoads.push(`${message.location().url}: ${message.text()}`);
    }
  });
  /** Waits for the reader's own recipe read of this page, if it makes one, to be answered. */
  async function readAnswered(count: number) {
    await expect(composer(page)).toBeVisible(COLD_PAGE);
    await expect.poll(() => recipeReads.length).toBeGreaterThanOrEqual(count);
    await twoFrames(page);
    await page.waitForTimeout(250);
  }

  await page.goto(PLAIN_POST.path);
  await expect(page.getByRole('heading', { level: 1, name: PLAIN_POST.title })).toBeVisible(COLD_PAGE);
  await readAnswered(1);
  expect(failedRecipeLoads, JSON.stringify(recipeReads)).toEqual([]);

  await page.goto('/marketplace');
  await openPostByClientNavigation(page, PLAIN_POST.path);
  await expect(page.getByRole('heading', { level: 1, name: PLAIN_POST.title })).toBeVisible(COLD_PAGE);
  await readAnswered(2);
  expect(failedRecipeLoads, JSON.stringify(recipeReads)).toEqual([]);
});
