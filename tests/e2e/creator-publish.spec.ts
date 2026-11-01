import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';

/**
 * Publishing on the video creator's canvas (PR 3b of the redesign, owner 2026-10-28; the
 * artboards Result and Posted):
 * - a finished run shows the publish form beside its clip, started from the creation's own title
 *   and its recipe, shared by default; a first post saves the name and handle it shows, and Posted
 *   takes the form's place;
 * - on a phone a bar holds Publish at the window's foot while the form's own is out of view,
 *   and sends the same post, and gives way to the column's bar, Generate's, at the page's end;
 * - Generate waits while a publish is sent: a new run would take the form away mid-request;
 * - a remix credits its original with Follow, and never promises an alert at publish; once
 *   posted, its top-up tells Pricing the remix to come back to.
 *
 * Offline the quotes, the start, the run's status, the creation's details, the profile, the
 * follow state and the publish are answered here; the client signs in with a made-up session (as
 * creator-canvas.spec.ts does). Requests left to the dev server go without that session's token.
 */

const COLD_PAGE = { timeout: 45_000 };
const PROMPT = 'A paper boat drifting across a sunlit pond, gentle ripples, soft morning light, slow push-in.';
const PHONE = { width: 390, height: 844 };

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
    // Any other table read: no rows. (The look for a run already at work is the API's.)
    if (pathname.startsWith('/rest/v1/')) return route.fulfill(single ? { status: 406, json: {} } : { json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
}

type Run = { kind?: string; modelId?: string; catalogRevision?: string; settings?: Record<string, unknown> };

/** Production's Seedance 2 Mini (release mini-default-video-20261028); 14 a second for any other video. */
function priceOf(run: Run) {
  const seconds = Number(run.settings?.duration ?? 5);
  if (run.kind === 'image') return run.modelId === 'z-image' ? 1 : 8;
  if (run.modelId === 'seedance-2-mini') return ({ 4: 16, 5: 19, 6: 23 } as Record<number, number>)[seconds] ?? 4 * seconds;
  return 14 * seconds;
}

/** The creation's library entry: its own title and the recipe its setup makes. */
const RECIPE = { resourceKinds: ['prompt'], promptText: PROMPT, notesMarkdown: null, allowRemix: false };

type Answers = {
  /** A first post: the profile still has the signup handle and no name. */
  firstPost?: boolean;
  creationTitle?: string;
  /** The balance the run leaves: 6 by default, short of another 19-credit run. */
  balanceAfterRun?: number;
  publishes: Request[];
  profileSaves: Request[];
};

async function answerApi(page: Page, answers: Answers) {
  await page.route('**/api/**', (route) => {
    const headers = { ...route.request().headers() };
    delete headers.authorization;
    return route.continue({ headers });
  });
  const quote = (run: Run) => ({
    modelId: run.modelId ?? 'unknown',
    catalogRevision: run.catalogRevision ?? 'unknown',
    normalizedSettings: run.settings ?? {},
    costCredits: priceOf(run),
  });
  await page.route('**/api/generation-models/quote', (route) => route.fulfill({ json: quote(route.request().postDataJSON() as Run) }));
  await page.route('**/api/generation-models/quotes', (route) => {
    const { quotes } = route.request().postDataJSON() as { quotes: Run[] };
    return route.fulfill({ json: { quotes: quotes.map((run) => ({ ok: true, quote: quote(run) })) } });
  });
  await page.route('**/api/generations**', (route) => (route.request().method() === 'POST'
    ? route.fulfill({
      json: {
        success: true,
        predictionId: 'pred-e2e',
        generationId: 'gen-e2e',
        status: 'processing',
        remainingCredits: answers.balanceAfterRun ?? 6,
        cost: 19,
        catalogRevision: 'e2e',
        modelId: 'seedance-2-mini',
      },
    })
    : route.fulfill({
      json: {
        generations: [{
          id: 'gen-e2e',
          title: answers.creationTitle ?? 'Paper boat at dawn',
          prompt: PROMPT,
          model: 'seedance-2-mini',
          category: 'video',
          paywallPrefill: RECIPE,
        }],
      },
    })));
  // A real run takes seconds: the start's smooth scroll to the canvas is over before it ends.
  await page.route('**/api/generate-video?id=**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ json: { status: 'succeeded', output: 'https://cdn.example.test/boat.mp4', timing: null } });
  });
  await page.route('https://cdn.example.test/**', (route) => route.fulfill({ status: 404, body: '' }));
  const credits = answers.balanceAfterRun ?? 6;
  let profile = answers.firstPost
    ? { id: 'workflow-user', username: 'creator-a1b2c3d4', displayName: null, avatarUrl: null, credits }
    : { id: 'workflow-user', username: 'paper-maker', displayName: 'Paper Maker', avatarUrl: null, credits };
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() === 'PATCH') {
      answers.profileSaves.push(route.request());
      profile = { ...profile, ...route.request().postDataJSON() as Record<string, string> };
    }
    await route.fulfill({ json: profile });
  });
  await page.route('**/api/profile/follow**', (route) => route.fulfill({ json: { following: route.request().method() === 'POST' } }));
  await page.route('**/api/showcase/publish', (route) => {
    answers.publishes.push(route.request());
    return route.fulfill({
      json: {
        success: true,
        visibility: 'public',
        postId: 'post-new',
        showcasePath: '/showcase/gen-e2e',
        ownerPath: '/posts/post-new',
        resourceBundleStatus: 'published',
        resourceBundlePath: null,
      },
    });
  });
}

async function runToDone(page: Page, path = '/create-video') {
  await page.goto(path, COLD_PAGE);
  // Typed only once the page's script runs, or hydration resets the field.
  await expect(page.getByRole('button', { name: 'Generate · 19 credits' })).toBeVisible(COLD_PAGE);
  await page.getByRole('textbox', { name: 'Prompt' }).fill(PROMPT);
  await page.getByRole('button', { name: 'Generate · 19 credits' }).click();
  await expect(canvas(page).getByRole('heading', { name: 'Done' })).toBeVisible({ timeout: 30_000 });
}

function canvas(page: Page) {
  return page.getByRole('region', { name: 'Result' });
}

function publishForm(page: Page) {
  return canvas(page).getByRole('form', { name: 'Post it to the feed' });
}

test('publishes from the canvas: the creation’s title, its recipe on, a first post’s name and handle, then Posted', async ({ page, context }) => {
  await signIn(context);
  const answers: Answers = { firstPost: true, publishes: [], profileSaves: [] };
  await answerApi(page, answers);
  await runToDone(page);

  const form = publishForm(page);
  await expect(form.getByRole('textbox', { name: 'Title' })).toHaveValue('Paper boat at dawn');
  await expect(form.getByRole('switch', { name: 'Share the recipe' })).toHaveAttribute('aria-checked', 'true');
  await expect(form).toContainText('your first post sets these');
  // The Publish window this replaces is gone from the page.
  await expect(page.locator('main').getByRole('button', { name: /Publish & share/ })).toHaveCount(0);

  await form.getByRole('button', { name: 'Change your name or handle' }).click();
  await form.getByRole('textbox', { name: 'Display name' }).fill('Paper Maker');
  await form.getByRole('textbox', { name: 'Handle' }).fill('paper-maker');
  await form.getByRole('button', { name: 'Publish to the feed' }).click();

  const posted = canvas(page).getByRole('heading', { name: 'Posted to the feed' });
  await expect(posted).toBeVisible();
  await expect(posted).toBeFocused();
  await expect(canvas(page)).toContainText('“Paper boat at dawn” is live on your profile and in Explore. You’ll get an alert when someone remixes yours.');
  await expect(canvas(page).getByRole('link', { name: 'View your post' })).toHaveAttribute('href', '/showcase/gen-e2e');
  await expect(canvas(page).getByRole('button', { name: 'Share the link' })).toBeVisible();

  expect(answers.profileSaves.map((request) => request.postDataJSON())).toEqual([{ username: 'paper-maker', displayName: 'Paper Maker' }]);
  expect(answers.publishes).toHaveLength(1);
  expect(answers.publishes[0].postDataJSON()).toMatchObject({
    generationId: 'gen-e2e',
    visibility: 'public',
    title: 'Paper boat at dawn',
    resourceBundle: { accessMode: 'free', priceUsdCents: 0, resources: { promptText: PROMPT } },
  });
});

test('on a phone a bar holds Publish while the form’s own is out of view, and sends the same post', async ({ page, context }) => {
  await page.setViewportSize(PHONE);
  await signIn(context);
  const answers: Answers = { publishes: [], profileSaves: [] };
  await answerApi(page, answers);
  await runToDone(page);

  const done = canvas(page).getByRole('heading', { name: 'Done' });
  // The result comes first while it is done: Done is at the top, in view, with the focus.
  await expect(done).toBeFocused();
  await expect(done).toBeInViewport();
  const bar = page.getByTestId('creator-publish-bar');
  await expect(bar.getByRole('button', { name: 'Publish as @paper-maker' })).toBeVisible();
  await expect(bar).toContainText('As Paper Maker · “Paper boat at dawn” · recipe shared');

  const formPublish = publishForm(page).getByRole('button', { name: 'Publish to the feed' });
  await formPublish.scrollIntoViewIfNeeded();
  await expect(bar).toHaveCount(0);
  await done.scrollIntoViewIfNeeded();
  await expect(bar).toBeVisible();

  await bar.getByRole('button', { name: 'Publish as @paper-maker' }).click();
  await expect(canvas(page).getByRole('heading', { name: 'Posted to the feed' })).toBeVisible();
  await expect(bar).toHaveCount(0);
  expect(answers.publishes).toHaveLength(1);
  expect(answers.publishes[0].postDataJSON()).toMatchObject({ title: 'Paper boat at dawn', resourceBundle: { accessMode: 'free' } });
});

// On a phone the creators hide the bottom navigation (`hidesBottomNav`, 2026-10-30): nothing else
// holds the window's foot, so the bar stays while the form's Publish is below the window and goes
// once the button is in it. (Before, the navigation covered the foot and the bar stayed until the
// button was above it.)
test('on a phone the bar stays while the form’s Publish is below the window, with no navigation at the foot', async ({ page, context }) => {
  await page.setViewportSize(PHONE);
  await signIn(context);
  const answers: Answers = { publishes: [], profileSaves: [] };
  await answerApi(page, answers);
  await runToDone(page);

  const formPublish = publishForm(page).getByRole('button', { name: 'Publish to the feed' });
  const room = await formPublish.evaluate((button) => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;height:var(--app-shell-bottom-nav-space,0px)';
    button.parentElement!.appendChild(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height;
  });
  expect(room, 'the creators keep no room for the bottom navigation').toBe(0);
  /** Puts the button's middle this far above the window's foot, at once, and lets the observers answer. */
  const middleAbove = async (fromFoot: number) => {
    await formPublish.evaluate((button, offset) => {
      const box = button.getBoundingClientRect();
      window.scrollBy({ top: box.top + box.height / 2 - (window.innerHeight - offset), behavior: 'instant' });
    }, fromFoot);
    await expect.poll(() => formPublish.evaluate((button) => Math.round(window.innerHeight - button.getBoundingClientRect().top - button.getBoundingClientRect().height / 2)))
      .toBe(Math.round(fromFoot));
    await page.waitForTimeout(300);
  };
  const bar = page.getByTestId('creator-publish-bar');

  // Mostly below the window's foot: out of reach, so the bar stays.
  await middleAbove(-12);
  await expect(bar).toBeVisible();
  // In the window: in reach, so the bar goes.
  await middleAbove(48);
  await expect(bar).toHaveCount(0);
});

// The column's own bar, with Generate, waits at the page's end until the creation is posted
// (the artboard Result at 390): the Publish bar, fixed at the window's foot, would sit over it.
test('on a phone the bar gives way to the column’s bar at the page’s end, leaving it uncovered', async ({ page, context }) => {
  await page.setViewportSize(PHONE);
  await signIn(context);
  const answers: Answers = { publishes: [], profileSaves: [] };
  await answerApi(page, answers);
  await runToDone(page);

  const bar = page.getByTestId('creator-publish-bar');
  await expect(bar).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const columnBar = page.locator('[data-creator-bar]');
  await expect(columnBar).toBeInViewport({ ratio: 1 });
  await expect(bar).toHaveCount(0);
  // Nothing lies over the column's bar: the point at its middle is its own.
  const uncovered = await columnBar.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  });
  expect(uncovered).toBe(true);
});

test('Generate waits while a publish is sent, and is back once it is posted', async ({ page, context }) => {
  await signIn(context);
  const answers: Answers = { balanceAfterRun: 25, publishes: [], profileSaves: [] };
  await answerApi(page, answers);
  let answerPublish = () => {};
  const publishHeld = new Promise<void>((resolve) => {
    answerPublish = resolve;
  });
  await page.route('**/api/showcase/publish', async (route) => {
    answers.publishes.push(route.request());
    await publishHeld;
    await route.fulfill({
      json: { success: true, visibility: 'public', postId: 'post-new', showcasePath: '/showcase/gen-e2e', resourceBundleStatus: 'published' },
    });
  });
  await runToDone(page);

  const generate = page.getByRole('button', { name: 'Generate · 19 credits' });
  await expect(generate).toBeEnabled();
  await publishForm(page).getByRole('button', { name: 'Publish to the feed' }).click();
  await expect.poll(() => answers.publishes.length).toBe(1);
  await expect(generate).toBeDisabled();

  answerPublish();
  await expect(canvas(page).getByRole('heading', { name: 'Posted to the feed' })).toBeVisible();
  await expect(generate).toBeEnabled();
});

test('a remix credits its original with Follow, says the alert went when it finished, and once posted tops up back to it', async ({ page, context }) => {
  await signIn(context);
  const answers: Answers = { creationTitle: '', publishes: [], profileSaves: [] };
  await answerApi(page, answers);
  await page.route('**/api/remix-source?**', (route) => route.fulfill({
    json: {
      generation: { id: 'gen-cats', title: 'Kung fu cats', prompt: PROMPT, category: 'video', model: 'seedance-2-mini' },
      result: { mediaType: 'video', url: null },
      inputs: {},
      workflowSettings: { model: 'seedance-2-mini', duration: 5, aspectRatio: '16:9', resolution: '480p', sound: false },
      restoreIssues: [],
    },
  }));
  await page.route('**/api/showcase/posts/post-cats', (route) => route.fulfill({
    json: {
      success: true,
      item: { id: 'post-cats', title: 'Kung fu cats', creator: { id: 'creator-fluffy', username: 'fluffy', name: 'Fluffy', avatar: null } },
    },
  }));
  await runToDone(page, '/create-video?remix=gen-cats&remixPost=post-cats');

  const form = publishForm(page);
  await expect(form.getByRole('textbox', { name: 'Title' })).toHaveValue('Kung fu cats (remix)');
  await expect(form).toContainText('Remix of “Kung fu cats” by @fluffy');
  await expect(form).toContainText('@fluffy was told when your remix finished.');
  await form.getByRole('button', { name: 'Follow @fluffy' }).click();
  await expect(form.getByRole('button', { name: 'Following @fluffy' })).toHaveAttribute('aria-pressed', 'true');

  // A remix keeps no draft, so Posted's top-up tells Pricing the remix, as the bar's does (2026-11-02).
  await form.getByRole('button', { name: 'Publish to the feed' }).click();
  await expect(canvas(page).getByRole('heading', { name: 'Posted to the feed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'top up', exact: true }))
    .toHaveAttribute('href', `/pricing?returnTo=${encodeURIComponent('/create-video?remix=gen-cats&remixPost=post-cats')}`);
});
