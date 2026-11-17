import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';

import recipePage from './fixtures/creator-page-recipes.json';

// The live sweep of 2026-11-17 (build 988d55079), signed in as @magicbooklet on a laptop: a full
// load of their own page, /creators/magicbooklet, drew the eight tiles in view with the chip anyone
// else reads, "Free recipe", from the first paint (116 ms) until 624 ms, then "Your recipe". The
// page is drawn once for everyone, and each tile asked whether the post was the viewer's of the
// page's session check (`useAuth().user`), which names the viewer only after the page's script has
// run and Supabase has answered.
//
// Here the browser holds a session cookie and no E2E bypass, so the page's provider checks it with
// Supabase as production's does, and the test holds that check (`/auth/v1/user`) until it has seen
// the page drawn meanwhile. Every frame the grid is drawn in is recorded, from the document's first.
// The dev server answers the page's reads (support/supabase-server-stub.cjs,
// fixtures/creator-page-recipes.json: four pictures, three with a recipe, two free and one paid).

const ORIGIN = 'http://127.0.0.1:3100';
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 60_000 };
const CREATOR = recipePage.creator;
const PAGE_PATH = `/creators/${CREATOR.username}`;
const PREVIEW_PICTURE = fs.readFileSync(path.join(__dirname, 'fixtures/red.png'));

/** The recipe tiles' chips as anyone but their creator reads them, in the grid's order. */
const OFFERED_CHIPS = ['Free recipe', '900 credits', 'Free recipe'];
/** The same chips as their creator reads them. */
const OWN_CHIPS = ['Your recipe', 'Your recipe', 'Your recipe'];

test.describe.configure({ timeout: 180_000 });
test.use({ viewport: { width: 1440, height: 900 } });

function base64Url(text: string) {
  return Buffer.from(text).toString('base64url');
}

/** An account as Supabase's auth describes it. */
type Account = {
  id: string;
  aud: string;
  role: string;
  email: string;
  is_anonymous: boolean;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  identities: unknown[];
  created_at: string;
  updated_at: string;
};

function account(id: string, name: string): Account {
  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email: `${id}@example.com`,
    is_anonymous: false,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { name },
    identities: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** The page's creator. */
const creatorAccount = account(CREATOR.id, CREATOR.display_name);
/** Another reader: the E2E user. */
const readerAccount = account('workflow-user', 'Workflow User');

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

/** The tiles' pictures, served for any reader. */
async function servePictures(context: BrowserContext) {
  await context.route('https://example.supabase.co/storage/v1/object/public/**', (route) => (
    /\.preview\.[a-f0-9]+\.webp$/.test(new URL(route.request().url()).pathname)
      ? route.fulfill({ contentType: 'image/png', body: PREVIEW_PICTURE })
      : route.fulfill({ status: 404, body: '' })
  ));
}

/**
 * Signed in as a browser is: a session cookie for the placeholder project, sent with every request,
 * and no E2E bypass, which would hand the page's provider its session at once.
 */
async function signIn(context: BrowserContext, who: Account) {
  const checks = sessionChecks();
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: who.id, aud: 'authenticated', role: 'authenticated', exp: 4_102_444_800, session_id: 'e2e-session',
  }));
  const session = {
    access_token: `${header}.${payload}.c2lnbmF0dXJl`,
    refresh_token: 'e2e-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4_102_444_800,
    user: who,
  };
  await context.addCookies([
    { name: 'sb-example-auth-token', value: `base64-${base64Url(JSON.stringify(session))}`, url: ORIGIN },
  ]);
  const profile = { display_name: who.user_metadata.name, avatar_url: null, credits: 22, promotional_credits: 0 };
  await context.route('https://example.supabase.co/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') {
      await checks.answer();
      return route.fulfill({ json: who }).catch(() => undefined);
    }
    if (pathname === '/auth/v1/token') return route.fulfill({ json: session });
    const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
    if (pathname === '/rest/v1/profiles') return route.fulfill({ json: single ? profile : [profile] });
    if (pathname.startsWith('/rest/v1/')) return route.fulfill(single ? { status: 406, json: {} } : { json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  await servePictures(context);
  return checks;
}

/**
 * Every API call unanswered. `savedStateReads` counts the page's read of which posts the viewer
 * saved, which it makes only once its own session check has named them.
 */
async function answerApi(page: Page) {
  const savedStateReads: string[] = [];
  await page.route('**/api/**', (route) => {
    if (new URL(route.request().url()).pathname === '/api/showcase/saved-state') {
      savedStateReads.push(route.request().url());
    }
    return route.fulfill({ status: 503, json: { error: 'Not answered offline' } });
  });
  return savedStateReads;
}

/**
 * A frame of the grid: each recipe tile's chip as it reads, in the grid's order; null for a tile
 * that is not drawn: its HTML has not all arrived (its title, after the chip, is not in yet), or
 * the page is not laid out yet (the dev server's first frames are).
 */
type ChipFrame = { path: string; chips: Array<string | null> };

/**
 * Records every frame whose recipe chips differ from the last, from the document's first frame on:
 * its first frames are the server's HTML under the stylesheet and the pre-paint script, before the
 * page's own scripts have run. A chip reads what is shown of it: its words where a tile draws one
 * ("Free recipe", "900 credits", "Unlocked", "Your recipe"), more than one joined by " + ", and ""
 * for none.
 */
const RECORDER = `(() => {
  const frames = [];
  window.__chipFrames = frames;
  let last = '';
  const drawn = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
  function sample() {
    const grid = document.querySelector('[data-creator-grid]');
    if (grid) {
      const chips = Array.from(grid.querySelectorAll('[data-creator-card][data-creator-recipe]')).map((card) => {
        if (!card.querySelector('h3') || !drawn(card)) return null;
        const labels = card.innerText.match(/Your recipe|Free recipe|Unlocked|[\\d,]+ credits?/g);
        return labels ? labels.join(' + ') : '';
      });
      const frame = { path: location.pathname, chips };
      const key = JSON.stringify(frame);
      if (key !== last) {
        last = key;
        frames.push(frame);
      }
    }
    if (!window.__chipFramesDone) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();`;

/**
 * The frames recorded on the page's address, read once two more have passed, so the last change
 * committed before the call has been sampled; the recorder stops.
 */
async function recordedFrames(page: Page): Promise<ChipFrame[]> {
  const frames = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const record = window as unknown as { __chipFrames: ChipFrame[]; __chipFramesDone?: boolean };
    record.__chipFramesDone = true;
    return record.__chipFrames;
  });
  return frames.filter((frame) => frame.path === PAGE_PATH);
}

/** Lets two frames pass, so what the page has committed has been drawn, and recorded. */
async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * The chips the same in every frame the grid is drawn in. A frame painted from part of the page's
 * HTML (CI's dev server sends it in pieces, and Chrome paints what it has) can end before a tile or
 * inside one, so every tile a frame has whole reads as it should, and there are frames with all
 * three whole.
 */
function expectChipsInEveryFrame(frames: ChipFrame[], chips: string[]) {
  const all = JSON.stringify(frames);
  const whole = frames.filter((frame) => frame.chips.length === chips.length && !frame.chips.includes(null));
  expect(whole.length, all).toBeGreaterThan(0);
  expect(frames.filter((frame) => frame.chips.some((chip, index) => chip !== null && chip !== chips[index])), all).toEqual([]);
}

/** The chips as the page draws them now. */
function chipsNow(page: Page) {
  return page.locator('[data-creator-grid] [data-creator-card][data-creator-recipe]').evaluateAll((cards) => (
    cards.map((card) => ((card as HTMLElement).innerText.match(/Your recipe|Free recipe|Unlocked|[\d,]+ credits?/g) ?? []).join(' + '))
  ));
}

/**
 * Waiting for the page to ask for its session check, polled often: the time a check is held for
 * comes out of its deadline (SESSION_CHECK_DEADLINE_MS, 4.5 s from when the check began).
 */
const CHECK_ASKED = { ...COLD_PAGE, intervals: [50] };

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

/** How long a push is given to ask the server for the page before it is taken for dropped. */
const PUSH_TAKEN_WITHIN_MS = 2_000;

/**
 * Opens the creator's page by a client navigation, as a link to it does (a post's byline, a reel's
 * name). A push made before the page's script has taken the document over is dropped, so it is
 * made after the root's commit, and made again only while the router has not asked the server for
 * the page (post-page-signed-in-rail.spec.ts's openPostByClientNavigation says why).
 */
async function openByClientNavigation(page: Page) {
  await expect.poll(() => hydrationCommitted(page), COLD_PAGE).toBe(true);
  let taken = false;
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname === PAGE_PATH && (url.searchParams.has('_rsc') || request.headers().rsc === '1')) taken = true;
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
      }, { href: PAGE_PATH, pushNow: push });
    }, { ...COLD_PAGE, intervals: [100] }).toBe(PAGE_PATH);
  } finally {
    page.off('request', onRequest);
  }
}

const creatorHeading = (page: Page) => page.getByRole('heading', { level: 1, name: CREATOR.display_name });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test("the creator, loading their own page, reads every recipe of theirs as theirs from the first frame, while the session is checked", async ({ page, context }, testInfo) => {
  const checks = await signIn(context, creatorAccount);
  checks.hold();
  const savedStateReads = await answerApi(page);
  await page.addInitScript(RECORDER);

  await page.goto(PAGE_PATH);
  await expect(creatorHeading(page)).toBeVisible(COLD_PAGE);
  // A check is asked for once the page's script has run: held only while the grid drawn meanwhile
  // is seen, well inside the check's deadline.
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.locator('[data-creator-grid]').screenshot({ path: testInfo.outputPath('own-grid-while-session-checked.png') });

  checks.release();
  // The page's own check has named the creator: it reads which posts they saved.
  await expect.poll(() => savedStateReads.length, COLD_PAGE).toBeGreaterThan(0);
  await twoFrames(page);
  await expect.poll(() => chipsNow(page)).toEqual(OWN_CHIPS);
  expectChipsInEveryFrame(await recordedFrames(page), OWN_CHIPS);
});

test('the creator, opening their own page from another page, reads every recipe of theirs as theirs from the first frame, while the session is checked', async ({ page, context }) => {
  const checks = await signIn(context, creatorAccount);
  const savedStateReads = await answerApi(page);
  await page.addInitScript(RECORDER);

  // Any page will do: the way in is a client navigation, which starts the page's session check again.
  await page.goto('/marketplace');
  // The top bar has the reader before the page is opened.
  await expect(page.getByRole('link', { name: /^22 credits/ })).toBeVisible(COLD_PAGE);

  checks.hold();
  await openByClientNavigation(page);
  await expect(creatorHeading(page)).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);

  checks.release();
  await expect.poll(() => savedStateReads.length, COLD_PAGE).toBeGreaterThan(0);
  await twoFrames(page);
  await expect.poll(() => chipsNow(page)).toEqual(OWN_CHIPS);
  expectChipsInEveryFrame(await recordedFrames(page), OWN_CHIPS);
});

test('another signed-in reader is offered each recipe at its price in every frame, while the session is checked', async ({ page, context }) => {
  const checks = await signIn(context, readerAccount);
  checks.hold();
  const savedStateReads = await answerApi(page);
  await page.addInitScript(RECORDER);

  await page.goto(PAGE_PATH);
  await expect(creatorHeading(page)).toBeVisible(COLD_PAGE);
  await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
  await twoFrames(page);

  checks.release();
  await expect.poll(() => savedStateReads.length, COLD_PAGE).toBeGreaterThan(0);
  await twoFrames(page);
  await expect.poll(() => chipsNow(page)).toEqual(OFFERED_CHIPS);
  expectChipsInEveryFrame(await recordedFrames(page), OFFERED_CHIPS);
});

test('a visitor is offered each recipe at its price in every frame, loaded and opened from another page', async ({ page, context }) => {
  await context.route('https://example.supabase.co/auth/**', (route) => route.fulfill({ status: 401, json: {} }));
  await servePictures(context);
  await answerApi(page);
  await page.addInitScript(RECORDER);

  await page.goto(PAGE_PATH);
  await expect(creatorHeading(page)).toBeVisible(COLD_PAGE);
  // The page's own render has drawn the chips. The server's HTML draws each recipe tile's creator
  // words beside the price for the page's rule, and only the page's script, which knows who is
  // looking, takes them out: so the tiles are in, then their creator words are gone. The root's
  // commit is no sign here (review of #866): the page's loading.tsx sets it in a Suspense boundary
  // of its own, which hydrates apart from the root (.claude/rules/e2e.md), and the chips read the
  // same in the server's HTML.
  await expect(page.locator('[data-creator-grid] [data-creator-card][data-creator-recipe]')).toHaveCount(OFFERED_CHIPS.length, COLD_PAGE);
  await expect(page.locator('[data-creator-recipe-owner]')).toHaveCount(0, COLD_PAGE);
  await twoFrames(page);
  await expect.poll(() => chipsNow(page)).toEqual(OFFERED_CHIPS);
  expectChipsInEveryFrame(await recordedFrames(page), OFFERED_CHIPS);

  await page.goto('/marketplace');
  await openByClientNavigation(page);
  await expect(creatorHeading(page)).toBeVisible(COLD_PAGE);
  await twoFrames(page);
  await page.waitForTimeout(500);
  await expect.poll(() => chipsNow(page)).toEqual(OFFERED_CHIPS);
  expectChipsInEveryFrame(await recordedFrames(page), OFFERED_CHIPS);
});
