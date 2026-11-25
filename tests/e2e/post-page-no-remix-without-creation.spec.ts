import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import switchOnPost from './fixtures/upload-post-recipe-remix-switch-on.json';
import switchOffPost from './fixtures/upload-post-recipe-without-remix.json';

// Owner, 2026-11-17, asked "Remix can't work on posts made outside the app. Hide it there for now?":
// "Yes, hide it". A post with no creation (here two pictures made elsewhere, whose free recipes hold
// a reference picture) has nothing to remix: the remix route answers its Remix 400 "Only
// generation-backed posts can be remixed". The post page offered one all the same: an open Remix to a
// reader who had the recipe, and where the recipe's stored remix switch was on, "Remix · Free" to
// anyone else, which took the recipe and then failed, beside "Remix included" in the recipe and
// "Files + Remix" on its bar along the bottom edge. Every frame of each post is recorded, from the
// server's HTML on, for a visitor, a reader who has the recipe and the posts' creator: no Remix in the
// post's engagement row, and no word of one in its recipe or on the recipe's bar.
//
// The dev server answers the posts' reads (support/supabase-server-stub.cjs). A signed-in reader's own
// read of the recipe is answered here with the dev server's own answer to a visitor (its route, as
// the server reads the recipe in this checkout), given the access that reader has.

// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };

// Each test draws two posts, with up to 145 s of waits on each (the visitor's three cold-page waits
// and one of 10 s: 290 s at worst), after any recipe reads its setup makes, so a missing heading
// fails its own wait, not the test's timeout.
test.describe.configure({ timeout: 300_000 });

type UploadPost = typeof switchOffPost;

/** Both posts, by what their recipe stores: its remix switch off, and on. */
const POSTS: Array<{ name: string; post: UploadPost }> = [
  { name: 'stored switch off', post: switchOffPost },
  { name: 'stored switch on', post: switchOnPost },
];

/** The E2E user, who is not the posts' creator. */
const READER = { id: 'workflow-user', email: 'workflow-user@example.com', name: 'Workflow User' };
/** The posts' creator (both fixtures share theirs). */
const CREATOR = {
  id: switchOffPost.creator.id,
  email: 'upload-recipe-creator@example.com',
  name: switchOffPost.creator.display_name,
};

function base64Url(text: string) {
  return Buffer.from(text).toString('base64url');
}

/**
 * Signed in as a browser is: a session cookie for the placeholder project, and Supabase's auth and
 * the account's profile answered to the browser. No E2E bypass, which would sign in its own user.
 */
async function signIn(context: BrowserContext, origin: string, account: typeof READER) {
  const user = {
    id: account.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: account.email,
    is_anonymous: false,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { name: account.name },
    identities: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
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
    { name: 'sb-example-auth-token', value: `base64-${base64Url(JSON.stringify(session))}`, url: origin },
  ]);
  await context.route('https://example.supabase.co/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') return route.fulfill({ json: user });
    if (pathname === '/auth/v1/token') return route.fulfill({ json: session });
    const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
    if (pathname === '/rest/v1/profiles') {
      const profile = { display_name: account.name, avatar_url: null, credits: 22, promotional_credits: 0 };
      return route.fulfill({ json: single ? profile : [profile] });
    }
    if (pathname.startsWith('/rest/v1/')) return route.fulfill(single ? { status: 406, json: {} } : { json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
}

/** The recipe as the dev server answers a visitor through its route: what the server says of its Remix. */
async function visitorRecipe(page: Page, postId: string): Promise<Record<string, unknown>> {
  const response = await page.request.get(`/api/posts/${postId}/resource-bundle`, { timeout: 0 });
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return (JSON.parse(body) as { bundle: Record<string, unknown> }).bundle;
}

/** The recipe as it stores it, which a reader who has it is given (the editor round-trips the same). */
function storedResources(post: UploadPost) {
  return {
    promptText: null,
    notesMarkdown: null,
    workflowShareUrl: null,
    workflowSnapshot: null,
    attachments: [],
    allowRemix: post.bundle.allow_remix,
    sections: [],
    items: post.bundle.resource_items.map((item, index) => ({
      scope: { kind: 'all' },
      role: 'style_reference',
      sectionId: null,
      description: null,
      textContent: null,
      externalUrl: null,
      sizeBytes: null,
      workflowSnapshot: null,
      isPrimary: index === 0,
      remixUse: 'reference_only',
      ...item,
    })),
  };
}

/** Every API call unanswered offline, but the reader's own read of each post's recipe in `reads`. */
async function answerApi(page: Page, reads: Map<string, Record<string, unknown>> = new Map()) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  for (const [postId, bundle] of reads) {
    await page.route(
      (url) => url.pathname === `/api/posts/${postId}/resource-bundle`,
      (route) => route.fulfill({ json: { success: true, bundle } }),
    );
  }
}

type Frame = {
  path: string;
  /** The engagement row is drawn (its Save). */
  row: boolean;
  /** The row's Remix as it reads ("Remix · Free", "Remix"), "" for none. */
  remix: string;
  /** The recipe is drawn. */
  recipe: boolean;
  /** Each run of the recipe's words that names a Remix, "" for none. */
  recipeRemix: string;
  /** The recipe's bar along the bottom edge as it reads (below 1180px), null while none is shown. */
  bar: string | null;
  /** Each run of the bar's words that names a Remix, "" for none. */
  barRemix: string;
};

/**
 * Records every frame whose drawing of the row's Remix, the recipe or its bar differs from the last,
 * from the document's first frame on: its first frames are the server's HTML under the stylesheet
 * and the pre-paint script, before the page's own scripts have run.
 */
const RECORDER = `(() => {
  const frames = [];
  window.__noRemixFrames = frames;
  let last = '';
  const shown = (element) => Boolean(element && element.getClientRects().length > 0);
  const reads = (element) => (shown(element) ? element.innerText.replace(/\\s+/g, ' ').trim() : null);
  const remixWords = (text) => (text ? (text.match(/[^.·|]*remix[^.·|]*/gi) || []).map((part) => part.trim()).join(' | ') : '');
  function sample() {
    // The engagement row closes the post's own column, its Remix ahead of Save: once Save is in the
    // page, so is the Remix the row draws.
    const column = document.querySelector('[data-testid="media-detail-document"]');
    const save = column && Array.from(column.querySelectorAll('button'))
      .find((button) => /^(Save|Remove save from) /.test(button.getAttribute('aria-label') || ''));
    const recipe = reads(document.querySelector('#recipe'));
    const bar = reads(document.querySelector('[data-testid="recipe-bar"]'));
    const frame = {
      path: location.pathname,
      row: Boolean(save),
      remix: save
        ? Array.from(column.querySelectorAll('a, button'))
          .map(reads)
          .filter((text) => text !== null && /^Remix\\b/.test(text))
          .join(' | ')
        : '',
      recipe: recipe !== null,
      recipeRemix: remixWords(recipe),
      bar,
      barRemix: remixWords(bar),
    };
    const key = JSON.stringify(frame);
    if (key !== last) {
      last = key;
      frames.push(frame);
    }
    if (!window.__noRemixFramesDone) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();`;

/** The frames recorded so far, read once two more have passed, and the recorder stopped. */
async function recordedFrames(page: Page, path: string): Promise<Frame[]> {
  const frames = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const record = window as unknown as { __noRemixFrames: Frame[]; __noRemixFramesDone?: boolean };
    record.__noRemixFramesDone = true;
    return record.__noRemixFrames;
  });
  return frames.filter((frame) => frame.path === path);
}

/**
 * Whether the document's React root has committed its hydration, which only the page's script does
 * (login-typed-before-script.spec.ts says why the root's record is the sign).
 */
function hydrationCommitted(page: Page) {
  return page.evaluate(() => {
    type HostRoot = { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } };
    const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
    const root = key ? (document as unknown as Record<string, HostRoot>)[key] : undefined;
    return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
  });
}

/**
 * No Remix in any frame: none in the row, and no word of one in the recipe or on its bar. The row and
 * the recipe are asked to have been drawn, so that silence is not their absence. The bar is drawn for
 * whoever the page takes for someone without the recipe: a visitor, and a reader whose own read of it
 * says they have not got it (until that read lands the page holds a reader's recipe, owner 2026-11-18).
 */
function expectNoRemixInAnyFrame(frames: Frame[], name: string) {
  const all = `${name}: ${JSON.stringify(frames)}`;
  expect(frames.some((frame) => frame.row), all).toBe(true);
  expect(frames.some((frame) => frame.recipe), all).toBe(true);
  expect(frames.filter((frame) => frame.remix !== '' || frame.recipeRemix !== '' || frame.barRemix !== ''), all).toEqual([]);
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a visitor is offered no Remix on a post with no creation, nor told of one by its recipe or its bar, in any frame', async ({ page }) => {
  // Below 1180px, where the recipe's bar runs along the bottom edge for whoever has not got it.
  await page.setViewportSize({ width: 1024, height: 768 });
  await answerApi(page);
  await page.addInitScript(RECORDER);

  for (const { name, post } of POSTS) {
    const path = `/showcase/${post.post.id}`;
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: post.post.title })).toBeVisible(COLD_PAGE);
    await expect(page.locator('#recipe').getByRole('button', { name: 'Get free recipe' })).toBeVisible(COLD_PAGE);
    await expect(page.getByTestId('recipe-bar')).toBeVisible();
    await expect.poll(() => hydrationCommitted(page), COLD_PAGE).toBe(true);

    const frames = await recordedFrames(page, path);
    expectNoRemixInAnyFrame(frames, name);
    expect(frames.some((frame) => frame.bar !== null), `${name}: ${JSON.stringify(frames)}`).toBe(true);
  }
});

test('a reader who has the recipe of a post with no creation is offered no Remix, nor told of one by it, in any frame', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const reads = new Map<string, Record<string, unknown>>();
  for (const { post } of POSTS) {
    reads.set(post.post.id, {
      ...await visitorRecipe(page, post.post.id),
      viewerCanAccess: true,
      viewerHasPurchased: true,
      resources: storedResources(post),
    });
  }
  await signIn(context, baseURL!, READER);
  await answerApi(page, reads);
  await page.addInitScript(RECORDER);

  for (const { name, post } of POSTS) {
    const path = `/showcase/${post.post.id}`;
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: post.post.title })).toBeVisible(COLD_PAGE);
    // Their own read has landed: the recipe is theirs, open.
    await expect(page.locator('#recipe').getByText('Unlocked', { exact: true })).toBeVisible(COLD_PAGE);
    await expect(page.locator('#recipe').getByRole('heading', { level: 3, name: 'References' })).toBeVisible();

    expectNoRemixInAnyFrame(await recordedFrames(page, path), name);
  }
});

test("the posts' creator is offered no Remix on them, nor told of one by their own recipe, in any frame", async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const reads = new Map<string, Record<string, unknown>>();
  for (const { post } of POSTS) {
    reads.set(post.post.id, {
      ...await visitorRecipe(page, post.post.id),
      viewerCanAccess: true,
      viewerIsOwner: true,
      resources: storedResources(post),
    });
  }
  await signIn(context, baseURL!, CREATOR);
  await answerApi(page, reads);
  await page.addInitScript(RECORDER);

  for (const { name, post } of POSTS) {
    const path = `/showcase/${post.post.id}`;
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: post.post.title })).toBeVisible(COLD_PAGE);
    // The recipe reads as theirs from the server's HTML on ("Your recipe", owner-first-paint.ts), so
    // that says nothing of the page's script. Its References come only with their own read of it,
    // which the page sends once its script has loaded and knows the session, so that wait holds the
    // page's whole start in the browser and gets the cold page's time: on CI on 2026-11-25 the
    // page's late chunks (the Supabase client, the account) were still unanswered ten seconds after
    // "Your recipe" showed, the read never went out, and a 10 s wait failed with no References drawn.
    await expect(page.locator('#recipe').getByText('Your recipe', { exact: true })).toBeVisible(COLD_PAGE);
    await expect(page.locator('#recipe').getByRole('heading', { level: 3, name: 'References' })).toBeVisible(COLD_PAGE);

    expectNoRemixInAnyFrame(await recordedFrames(page, path), name);
  }
});
