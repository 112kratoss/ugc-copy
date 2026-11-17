import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * A creator opening their own post in the reel saw it offered to them: "Get free recipe" drew for
 * about a second, until the recipe's read came back with their access, and then the recipe took
 * its place (live sweep, signed in as the owner, 2026-11-17; a press there asked the server to
 * unlock their own recipe for them). Their own recipe is held where it opens instead, from the
 * reel's first frame, and opens when its read is in.
 *
 * The creator's page is the E2E user's own (`/creators/e2e-creator`, fixtures/creator-profile.json),
 * opened on a post's address, which the reel reads by itself (`/api/showcase/posts/<id>`). The page
 * is public, so there is no E2E auth cookie: the browser holds a made-up Supabase session in its
 * sign-in cookie, as creator-canvas.spec.ts makes one, and the check of it (`/auth/v1/user`) is held
 * 2 s, so the reel draws while the session is still being read, as on a reload (review of #863). The
 * recipe's read is answered as the server would: without a token as anyone's, no access; with the
 * creator's token, their recipe, 1.5 s late.
 */

const COLD_PAGE = { timeout: 45_000 };
const POST_ID = 'e2e0ae1e-0000-4000-8000-0000000000aa';

test.describe.configure({ timeout: 120_000 });

function base64url(value: string) {
  return Buffer.from(value).toString('base64url');
}

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
  const cookie = `sb-example-auth-token=base64-${base64url(JSON.stringify(session))}`;
  await context.addInitScript((value) => {
    document.cookie = `${value}; path=/; SameSite=Lax`;
  }, cookie);
  await context.route('https://example.supabase.co/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') {
      // The session is still being read while the reel draws.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return route.fulfill({ json: user });
    }
    if (pathname === '/auth/v1/token') return route.fulfill({ json: session });
    if (pathname === '/rest/v1/profiles') {
      const row = { display_name: 'E2E Creator', avatar_url: null, credits: 25 };
      const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
      return route.fulfill({ json: single ? row : [row] });
    }
    if (pathname.startsWith('/rest/v1/')) {
      const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
      return route.fulfill(single ? { status: 406, json: {} } : { json: [] });
    }
    return route.fulfill({ status: 404, json: {} });
  });
}

const ownPost = {
  id: POST_ID,
  mediaUrl: 'https://cdn.example.test/bookshop.jpg',
  mediaKind: 'image',
  model: 'nano-banana-2',
  title: 'Bookshop in the rain',
  prompt: '',
  body: '',
  category: 'image',
  postFormat: 'media',
  saveCount: 0,
  remixCount: 0,
  commentCount: 0,
  createdAt: '2026-11-15T10:00:00.000Z',
  creator: { id: 'workflow-user', username: 'e2e-creator', name: 'E2E Creator', avatar: null },
  isSaved: false,
  sourceKind: 'magicbooklet',
  sourceTool: null,
  generationId: null,
  canRemix: false,
  asset: {
    id: 'e2e0ae1e-0000-4000-8000-0000000000ab',
    title: 'Prompt',
    accessMode: 'free',
    priceUsdCents: 0,
    priceQuote: { currency: 'USD', amountSubunits: 0, formatted: 'Free', note: null },
    previewText: 'Unlock the saved prompt and remix used to create this result.',
    resourceKinds: ['prompt'],
    allowRemix: false,
  },
};

const ownBundle = {
  id: 'e2e0ae1e-0000-4000-8000-0000000000ab',
  postId: POST_ID,
  title: 'Prompt',
  summary: '',
  previewText: '',
  accessMode: 'free',
  priceUsdCents: 0,
  priceQuote: { currency: 'USD', amountSubunits: 0, formatted: 'Free', note: null },
  resourceKinds: ['prompt'],
  lockedPreview: null,
  salesCount: 0,
  freeUnlockCount: 0,
  allowRemix: false,
  status: 'published',
  viewerCanAccess: true,
  viewerIsOwner: true,
  purchasedRevision: null,
  resources: {
    promptText: null,
    notesMarkdown: null,
    workflowShareUrl: null,
    attachments: [],
    allowRemix: false,
    sections: [],
    items: [{
      id: 'prompt-1', type: 'prompt', title: 'Prompt', role: 'supporting', sectionId: null, description: null,
      textContent: 'A tiny bookshop in a rainy alley at night, neon reflections in puddles.',
      externalUrl: null, storagePath: null, contentType: null, sizeBytes: null, workflowSnapshot: null,
      sortOrder: 0, isPrimary: false, remixUse: 'none',
    }],
  },
};

type Frame = { offer: boolean; held: boolean; recipe: boolean };

/** Records, every frame from the document's first, what the reel's recipe card says. */
async function recordFrames(page: Page) {
  await page.addInitScript(() => {
    const frames: Array<{ offer: boolean; held: boolean; recipe: boolean }> = [];
    (window as unknown as { __recipeFrames: typeof frames }).__recipeFrames = frames;
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const tick = () => {
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        const buttons = [...dialog.querySelectorAll('button')].filter(shown);
        const texts = [...dialog.querySelectorAll('p, span')].filter(shown).map((element) => element.textContent ?? '');
        frames.push({
          offer: buttons.some((button) => /Get free recipe/.test(button.textContent ?? '')),
          held: texts.some((text) => text.includes('Opening your recipe')),
          recipe: texts.some((text) => text.includes('A tiny bookshop in a rainy alley')),
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function frames(page: Page) {
  return page.evaluate(() => (window as unknown as { __recipeFrames: Frame[] }).__recipeFrames);
}

test("a creator opening their own post in the reel never has its recipe offered to them, and it opens once read", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(context);
  await recordFrames(page);

  let releaseRead: () => void = () => {};
  const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
  let bundleReads = 0;
  // Anything else the page asks of the API goes on to the dev server without the made-up token.
  await page.route('**/api/**', (route) => {
    const headers = { ...route.request().headers() };
    delete headers.authorization;
    return route.continue({ headers });
  });
  await page.route(`**/api/showcase/posts/${POST_ID}`, (route) => route.fulfill({ json: { item: ownPost } }));
  await page.route(`**/api/posts/${POST_ID}/resource-bundle`, async (route) => {
    bundleReads += 1;
    // Without a token the server answers as for anyone: no access, and no recipe.
    if (!route.request().headers().authorization) {
      return route.fulfill({ json: { bundle: { ...ownBundle, viewerCanAccess: false, viewerIsOwner: false, resources: null } } });
    }
    await readHeld;
    await route.fulfill({ json: { bundle: ownBundle } });
  });
  const unlocks: string[] = [];
  await page.route(`**/api/posts/${POST_ID}/resource-bundle/**`, (route) => {
    unlocks.push(route.request().url());
    return route.fulfill({ status: 500, json: { error: 'Not expected' } });
  });
  await page.route('https://cdn.example.test/**', (route) => route.fulfill({ status: 404, body: '' }));

  await page.goto(`/creators/e2e-creator?post=${POST_ID}`, COLD_PAGE);
  const reel = page.getByRole('dialog', { name: /reel viewer$/ });
  await expect(reel).toBeVisible(COLD_PAGE);
  await expect(reel.getByRole('heading', { name: 'Bookshop in the rain' })).toBeVisible(COLD_PAGE);
  // The read is out, and held while the reel is drawn.
  await expect.poll(() => bundleReads).toBeGreaterThan(0);
  // The rail's Recipe (its name is its `aria-label`, whatever it says) never asks to unlock the
  // creator's own recipe.
  await reel.locator('button[aria-label="View recipe"], button[aria-label="Get free recipe"]').click();
  await page.waitForTimeout(2_500);
  releaseRead();

  await expect(reel.getByText('A tiny bookshop in a rainy alley', { exact: false })).toBeVisible(COLD_PAGE);
  // The read that brought it carried the session.
  expect(bundleReads).toBeGreaterThan(1);
  // A frame drawn since: the recorder runs on the next animation frame.
  await expect.poll(async () => (await frames(page)).at(-1)).toEqual({ offer: false, held: false, recipe: true });
  const drawn = await frames(page);
  expect(drawn.length).toBeGreaterThan(30);
  expect(drawn.filter((frame) => frame.offer), 'frames that offered the creator their own recipe').toHaveLength(0);
  expect(drawn.some((frame) => frame.held)).toBe(true);
  expect(unlocks).toEqual([]);
});
