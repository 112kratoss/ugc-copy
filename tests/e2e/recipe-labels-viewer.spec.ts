import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';

import market from './fixtures/marketplace-recipes.json';
import recipePage from './fixtures/creator-page-recipes.json';

// Two pages drawn once for every viewer, and what their recipe tiles told a signed-in reader (the
// live sweep of 2026-11-17, build 6be6d8bd9):
// - Marketplace: its seller's own recipe cards read "Free recipe", with "View free recipe" as their
//   action, until the page's session check named them (about 0.1 s on a client navigation): every
//   visit mounts a provider of its own, which asks Supabase again before it names anyone.
// - A creator page: a reader who had bought or opened one of the creator's recipes was never told
//   so on the page's first posts ("Free recipe", or the price, for as long as the page was open):
//   they are the server's, drawn once for everyone, and nothing read them again with the session.
//
// The browser holds a session cookie and no E2E bypass, so a page's provider checks it with
// Supabase as production's does; the Marketplace tests hold that check (`/auth/v1/user`) until they
// have seen the page drawn meanwhile. Every frame the tiles are drawn in is recorded, from the
// document's first. The dev server draws the storefront from fixtures/marketplace-recipes.json (four
// free recipes by e2e-market-creator) and the creator page from fixtures/creator-page-recipes.json
// (three recipes: free, 900 credits, free), both through support/supabase-server-stub.cjs.

const ORIGIN = 'http://127.0.0.1:3100';
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 60_000 };
const STOREFRONT = '/marketplace';
const CREATOR_PAGE = `/creators/${recipePage.creator.username}`;
const PREVIEW_PICTURE = fs.readFileSync(path.join(__dirname, 'fixtures/red.png'));
/** The storefront's first page: every recipe but the one that tells the page more follow. */
const FIRST_PAGE = market.bundles.length - 1;

/** A storefront tile's words, its action then its chip, as anyone but its seller reads them. */
const OFFERED_TILE = 'VIEW FREE RECIPE + FREE RECIPE';
/** The same as its seller reads them. */
const OWN_TILE = 'VIEW RECIPE + YOUR RECIPE';

test.describe.configure({ timeout: 180_000 });
test.use({ viewport: { width: 1440, height: 900 } });

function base64Url(text: string) {
  return Buffer.from(text).toString('base64url');
}

type Account = { id: string; name: string };

/** The storefront's seller. */
const seller: Account = { id: market.creator.id, name: market.creator.display_name };
/** A reader who has opened the creator page's first free recipe. */
const buyer: Account = { id: 'e2e-recipe-buyer', name: 'Recipe Buyer' };
/** The recipe the buyer has: the creator page's first (free) one. */
const BOUGHT_RECIPE_ID = recipePage.bundles[0].id;

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
  // A picture through Next's image optimizer, whose fetch of the placeholder project fails.
  await context.route('**/_next/image**', (route) => route.fulfill({ contentType: 'image/png', body: PREVIEW_PICTURE }));
}

/**
 * Signed in as a browser is: a session cookie for the placeholder project, sent with every request,
 * and no E2E bypass, which would hand the page's provider its session at once.
 */
async function signIn(context: BrowserContext, who: Account) {
  const checks = sessionChecks();
  const user = {
    id: who.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: `${who.id}@example.com`,
    is_anonymous: false,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { name: who.name },
    identities: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
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
    user,
  };
  await context.addCookies([
    { name: 'sb-example-auth-token', value: `base64-${base64Url(JSON.stringify(session))}`, url: ORIGIN },
    // An account that has a handle: the creator-name step is not offered.
    { name: 'mb_name_step_shown', value: who.id, url: ORIGIN },
  ]);
  const profile = { display_name: who.name, avatar_url: null, credits: 22, promotional_credits: 0 };
  await context.route('https://example.supabase.co/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') {
      await checks.answer();
      return route.fulfill({ json: user }).catch(() => undefined);
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
 * The page's API calls: the viewer's own recipes (`/api/me/unlocked-recipes`) answered with `has`,
 * the storefront's list API with its first page as the dev server reads it for a visitor (the same
 * four recipes the page was drawn with), and everything else unanswered, as it fails offline.
 * Returns the list API's reads made with a session, which the storefront makes once its check has
 * named the viewer.
 */
async function answerApi(page: Page, { has = [] as string[] } = {}) {
  const context = page.context();
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  const firstResponse = await page.request.get(`/api/marketplace/resources?sort=recent&offset=0&limit=${FIRST_PAGE}`, { timeout: 0 });
  expect(firstResponse.ok()).toBe(true);
  const firstPage = await firstResponse.json() as { items: unknown[] };
  expect(firstPage.items).toHaveLength(FIRST_PAGE);
  const readsWithSession: string[] = [];
  await context.route('**/api/marketplace/resources?**', (route) => {
    if (route.request().headers().authorization) readsWithSession.push(route.request().url());
    return route.fulfill({ json: firstPage }).catch(() => undefined);
  });
  await context.route('**/api/me/unlocked-recipes', (route) => route.fulfill({ json: { success: true, bundleIds: has } }));
  return readsWithSession;
}

type TileFrame = { path: string; tiles: Array<string | null> };

/**
 * Records every frame whose recipe tiles read differently from the last, from the document's first
 * frame on, as the words shown of each, upper-cased (the chips are drawn in capitals): the
 * storefront's tiles ("VIEW FREE RECIPE + FREE RECIPE"), a creator page's chips ("FREE RECIPE",
 * "900 CREDITS", "UNLOCKED"). A tile is null where it is not drawn: its HTML has not all arrived
 * (its title, after the chip, is not in yet), or the page is not laid out yet.
 */
const RECORDER = `(() => {
  const frames = [];
  window.__tileFrames = frames;
  let last = '';
  const words = /VIEW FREE RECIPE|VIEW RECIPE|YOUR RECIPE|FREE RECIPE|UNLOCKED|UNLOCK FOR|[\\d,]+ CREDITS?/g;
  const drawn = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
  const read = (tile, title) => {
    if (!tile.querySelector(title) || !drawn(tile)) return null;
    const found = tile.innerText.toUpperCase().match(words);
    return found ? found.join(' + ') : '';
  };
  function sample() {
    const storefront = Array.from(document.querySelectorAll('main a')).filter((link) => link.querySelector('h2') && link.querySelector('time'));
    const creatorPage = Array.from(document.querySelectorAll('[data-creator-grid] [data-creator-card][data-creator-recipe]'));
    const tiles = storefront.length > 0 ? storefront.map((tile) => read(tile, 'h2')) : creatorPage.map((tile) => read(tile, 'h3'));
    if (tiles.length > 0) {
      const frame = { path: location.pathname, tiles };
      const key = JSON.stringify(frame);
      if (key !== last) {
        last = key;
        frames.push(frame);
      }
    }
    if (!window.__tileFramesDone) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();`;

/** The frames recorded on `pathname`, read once two more have passed; the recorder stops. */
async function recordedFrames(page: Page, pathname: string): Promise<TileFrame[]> {
  const frames = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const record = window as unknown as { __tileFrames: TileFrame[]; __tileFramesDone?: boolean };
    record.__tileFramesDone = true;
    return record.__tileFrames;
  });
  return frames.filter((frame) => frame.path === pathname);
}

/** Lets two frames pass, so what the page has committed has been drawn, and recorded. */
async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * The tiles the same in every frame they are drawn in. A frame painted from part of the page's HTML
 * can end before a tile or inside one, so every tile a frame has whole reads as it should, and there
 * are frames with all of them whole.
 */
function expectTilesInEveryFrame(frames: TileFrame[], tiles: string[]) {
  const all = JSON.stringify(frames);
  const whole = frames.filter((frame) => frame.tiles.length === tiles.length && !frame.tiles.includes(null));
  expect(whole.length, all).toBeGreaterThan(0);
  expect(frames.filter((frame) => frame.tiles.some((tile, index) => tile !== null && tile !== tiles[index])), all).toEqual([]);
}

/** The storefront's tiles as the page draws them now. */
function storefrontNow(page: Page) {
  return page.locator('main a').evaluateAll((links) => links
    .filter((link) => link.querySelector('h2') && link.querySelector('time'))
    .map((link) => ((link as HTMLElement).innerText.toUpperCase().match(/VIEW FREE RECIPE|VIEW RECIPE|YOUR RECIPE|FREE RECIPE|UNLOCKED|UNLOCK FOR/g) ?? []).join(' + ')));
}

/** The creator page's recipe chips as the page draws them now. */
function creatorChipsNow(page: Page) {
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
 * does: its router then takes a navigation (login-typed-before-script.spec.ts says why).
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
 * Opens `pathname` by a client navigation, as a link to it does. A push made before the page's
 * script has taken the document over is dropped, so it is made after the root's commit, and made
 * again only while the router has not asked the server for the page
 * (creator-page-own-recipe-chips.spec.ts's openByClientNavigation).
 */
async function openByClientNavigation(page: Page, pathname: string) {
  await expect.poll(() => hydrationCommitted(page), COLD_PAGE).toBe(true);
  let taken = false;
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname === pathname && (url.searchParams.has('_rsc') || request.headers().rsc === '1')) taken = true;
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
      }, { href: pathname, pushNow: push });
    }, { ...COLD_PAGE, intervals: [100] }).toBe(pathname);
  } finally {
    page.off('request', onRequest);
  }
}

/** The storefront's recipe tiles: each a link holding its title and its date. */
const storefrontTiles = (page: Page) => page.locator('main a').filter({ has: page.locator('h2') }).filter({ has: page.locator('time') });
const creatorHeading = (page: Page) => page.getByRole('heading', { level: 1, name: recipePage.creator.display_name });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test.describe('a seller\'s own recipes on the storefront', () => {
  test('the seller, loading the storefront, reads every recipe of theirs as theirs in every frame, while the session is checked', async ({ page, context }) => {
    const checks = await signIn(context, seller);
    checks.hold();
    const readsWithSession = await answerApi(page);
    await page.addInitScript(RECORDER);

    await page.goto(STOREFRONT);
    await expect.poll(() => storefrontNow(page), COLD_PAGE).toHaveLength(FIRST_PAGE);
    // A check is asked for once the page's script has run: held only while the tiles drawn
    // meanwhile are seen, well inside the check's deadline.
    await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
    await twoFrames(page);

    checks.release();
    // The page's own check has named the seller: it reads its listing again with their session.
    await expect.poll(() => readsWithSession.length, COLD_PAGE).toBeGreaterThan(0);
    await twoFrames(page);
    await expect.poll(() => storefrontNow(page)).toEqual(Array(FIRST_PAGE).fill(OWN_TILE));
    expectTilesInEveryFrame(await recordedFrames(page, STOREFRONT), Array(FIRST_PAGE).fill(OWN_TILE));
  });

  test('the seller, opening the storefront from another page, reads every recipe of theirs as theirs in every frame, while the session is checked', async ({ page, context }) => {
    const checks = await signIn(context, seller);
    const readsWithSession = await answerApi(page);
    await page.addInitScript(RECORDER);

    // Any page will do: the way in is a client navigation, which starts the page's session check again.
    await page.goto(CREATOR_PAGE);
    await expect(creatorHeading(page)).toBeVisible(COLD_PAGE);
    // The top bar has the reader before the storefront is opened.
    await expect(page.getByRole('link', { name: /^22 credits/ })).toBeVisible(COLD_PAGE);

    checks.hold();
    await openByClientNavigation(page, STOREFRONT);
    await expect.poll(() => storefrontNow(page), COLD_PAGE).toHaveLength(FIRST_PAGE);
    await expect.poll(checks.held, CHECK_ASKED).toBeGreaterThan(0);
    await twoFrames(page);

    checks.release();
    await expect.poll(() => readsWithSession.length, COLD_PAGE).toBeGreaterThan(0);
    await twoFrames(page);
    await expect.poll(() => storefrontNow(page)).toEqual(Array(FIRST_PAGE).fill(OWN_TILE));
    expectTilesInEveryFrame(await recordedFrames(page, STOREFRONT), Array(FIRST_PAGE).fill(OWN_TILE));
  });

  test('a visitor is offered every recipe in every frame, and never reads the seller\'s words', async ({ page, context }) => {
    await context.route('https://example.supabase.co/auth/**', (route) => route.fulfill({ status: 401, json: {} }));
    await servePictures(context);
    await answerApi(page);
    await page.addInitScript(RECORDER);

    await page.goto(STOREFRONT);
    await expect.poll(() => storefrontNow(page), COLD_PAGE).toHaveLength(FIRST_PAGE);
    // The page's own render has drawn the tiles: the server's HTML draws the seller's words beside
    // everyone else's for the page's rule, and only the page's script takes them out.
    await expect(page.locator('[data-creator-recipe-owner]')).toHaveCount(0, COLD_PAGE);
    await twoFrames(page);
    await expect.poll(() => storefrontNow(page)).toEqual(Array(FIRST_PAGE).fill(OFFERED_TILE));
    expectTilesInEveryFrame(await recordedFrames(page, STOREFRONT), Array(FIRST_PAGE).fill(OFFERED_TILE));
    await expect(storefrontTiles(page).first()).toHaveAttribute('aria-label', /^View free recipe: /);
  });
});

test('a reader who has a creator\'s recipe reads "Unlocked" on it on the creator\'s page, once their recipes are read', async ({ page, context }) => {
  await signIn(context, buyer);
  await answerApi(page, { has: [BOUGHT_RECIPE_ID] });
  await page.addInitScript(RECORDER);

  await page.goto(CREATOR_PAGE);
  await expect(creatorHeading(page)).toBeVisible(COLD_PAGE);
  // Theirs once read: the first recipe, free for everyone, is one they have; the others are offered.
  await expect.poll(() => creatorChipsNow(page), COLD_PAGE).toEqual(['Unlocked', '900 credits', 'Free recipe']);
  // Never the creator's words: the page is not theirs.
  const frames = await recordedFrames(page, CREATOR_PAGE);
  expect(frames.filter((frame) => frame.tiles.some((tile) => tile?.includes('YOUR RECIPE'))), JSON.stringify(frames)).toEqual([]);
});
