import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type BrowserContext, type Locator, type Page, type Request } from '@playwright/test';

import exploreReel from './fixtures/explore-reel.json';

// The owner's recording of the live Explore (2026-11-16, signed in, Chrome on a laptop):
//
// - A tile opened in the reel kept its hover controls (its kind, ⋯, share and save) after the
//   reel closed, with the pointer elsewhere, until something else was clicked: focus comes back
//   to the tile on close, as it should, and the controls showed for any focus inside a tile.
// - A tap opened the reel in three steps: the grid dimmed under "Opening preview", then the reel
//   with a black picture and no Follow in its details, then the picture and Follow.
//
// The dev server answers Explore's Recent lane for the fixture's own tool
// (support/supabase-server-stub.cjs, fixtures/explore-reel.json): three pictures by a creator who
// is not the E2E user, each with the grid's preview and the reel's larger display copy. Here the
// display copy and the Follow read are slowed, as a phone network and a cold display copy slow
// them in production, so what the reel draws while they are on their way can be seen.

const LANE = `/showcase?sort=recent&tool=${exploreReel.toolSlug}`;
const [OPENED] = exploreReel.posts;
// In `next dev` a page compiles on its first request; offline Explore also waits on reads.
const COLD_PAGE = { timeout: 60_000 };
const DISPLAY_COPY_DELAY_MS = 1_500;
const FOLLOW_READ_DELAY_MS = 1_200;
const PREVIEW_PICTURE = fs.readFileSync(path.join(__dirname, 'fixtures/red.png'));
const DISPLAY_PICTURE = fs.readFileSync(path.join(__dirname, 'fixtures/blue.png'));

test.describe.configure({ timeout: 180_000 });
test.use({ viewport: { width: 1440, height: 900 } });

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Answers = {
  /** What the Follow read answers, after `FOLLOW_READ_DELAY_MS`. */
  following?: boolean;
};

/**
 * Signed in as the E2E user, every API call refused but the Follow read, and the lane's pictures
 * served: each grid preview at once, each display copy only after `DISPLAY_COPY_DELAY_MS`.
 */
async function answerOffline(page: Page, context: BrowserContext, { following = false }: Answers = {}) {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  await context.route('https://example.supabase.co/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/storage/v1/object/public/showcase_media/')) {
      if (/\.preview\.[a-f0-9]+\.webp$/.test(pathname)) {
        return route.fulfill({ contentType: 'image/png', body: PREVIEW_PICTURE });
      }
      if (/\.display\.[a-f0-9]+\.webp$/.test(pathname)) {
        await delay(DISPLAY_COPY_DELAY_MS);
        return route.fulfill({ contentType: 'image/png', body: DISPLAY_PICTURE }).catch(() => undefined);
      }
      return route.fulfill({ status: 404, body: '' });
    }
    if (pathname.startsWith('/rest/v1/')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await page.route('**/api/profile/follow?**', async (route) => {
    await delay(FOLLOW_READ_DELAY_MS);
    return route.fulfill({ json: { following } }).catch(() => undefined);
  });
}

/** The lane's grid, drawn by the full client (each tile with its controls). */
async function openLane(page: Page, context: BrowserContext, answers: Answers = {}) {
  await answerOffline(page, context, answers);
  // The reel's code (Explore loads it ahead, on idle and when the pointer comes over the grid): its
  // chunk asked for, and no chunk still on its way.
  let reelChunkAsked = false;
  const chunksInFlight = new Set<Request>();
  page.on('request', (request) => {
    if (!request.url().includes('/_next/static/chunks/')) return;
    chunksInFlight.add(request);
    if (/ShowcaseReelViewer/.test(request.url())) reelChunkAsked = true;
  });
  page.on('requestfinished', (request) => chunksInFlight.delete(request));
  page.on('requestfailed', (request) => chunksInFlight.delete(request));
  const reelCodeLoaded = async () => {
    await expect.poll(() => reelChunkAsked && chunksInFlight.size === 0, { timeout: 30_000 }).toBe(true);
    // Its scripts have run by the time the page is next idle.
    for (let idle = 0; idle < 2; idle += 1) {
      await page.evaluate(() => new Promise((resolve) => requestIdleCallback(() => resolve(null), { timeout: 2_000 })));
    }
  };
  await page.goto(LANE, COLD_PAGE);
  // The full grid, which draws each tile's controls, mounts once the session is known.
  await expect(page.getByRole('button', { name: `More actions for ${OPENED.title}` })).toBeVisible(COLD_PAGE);
  return { reelCodeLoaded };
}

function openButton(page: Page): Locator {
  return page.getByRole('button', { name: OPENED.title, exact: true });
}

/** The opened tile's frame, which takes the focus colour for keyboard focus in it. */
function tileFrame(page: Page): Locator {
  return page.locator('div.group:has(.showcase-card-actions)', { has: openButton(page) });
}

/** The opened tile's controls: its kind, ⋯, share and save, shown on hover. */
function tileControls(page: Page): Locator {
  return tileFrame(page).locator('.showcase-card-actions');
}

function tileMenuButton(page: Page): Locator {
  return page.getByRole('button', { name: `More actions for ${OPENED.title}` });
}

function controlsOpacity(page: Page) {
  return tileControls(page).evaluate((element) => getComputedStyle(element).opacity);
}

// The frame's border for keyboard focus in the tile (ShowcaseClient.tsx).
const TILE_FOCUS_BORDER = 'rgba(255, 122, 89, 0.34)';

function frameBorderColor(page: Page) {
  return tileFrame(page).evaluate((element) => getComputedStyle(element).borderTopColor);
}

function reel(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Explore reel viewer' });
}

/** Moves the pointer onto the page's title, away from every tile. */
async function pointerAway(page: Page) {
  const box = await page.getByRole('heading', { level: 1, name: 'Explore' }).boundingBox();
  if (!box) throw new Error('No Explore heading to move the pointer to');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
}

test('a tile opened in the reel and closed with the pointer shows no controls once the pointer has left it', async ({ page, context }) => {
  await openLane(page, context);
  await openButton(page).hover();
  await expect.poll(() => controlsOpacity(page)).toBe('1');

  await openButton(page).click();
  await expect(reel(page)).toBeVisible();
  await reel(page).getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(reel(page)).toBeHidden();
  // Focus comes back to the tile the reel was opened from (a keyboard reader's place).
  await expect(openButton(page)).toBeFocused();

  await pointerAway(page);
  await expect.poll(() => controlsOpacity(page), { timeout: 3_000 }).toBe('0');
});

test('a tile opened in the reel and closed from the keyboard keeps its controls in view', async ({ page, context }) => {
  await openLane(page, context);
  // Tabbed to, as a keyboard reader reaches it.
  for (let presses = 0; presses < 150; presses += 1) {
    if (await openButton(page).evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(openButton(page)).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(reel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reel(page)).toBeHidden();
  await expect(openButton(page)).toBeFocused();

  await pointerAway(page);
  await expect.poll(() => controlsOpacity(page), { timeout: 3_000 }).toBe('1');
});

// Review of #834: Escape is a key, and a browser draws focus given back by script just after a key
// as keyboard focus. A reel opened with the pointer and closed with Escape left the tile its
// controls and its frame's focus colour once the pointer had gone.
test('a tile opened in the reel with the pointer and closed with Escape shows no controls once the pointer has left it', async ({ page, context }) => {
  await openLane(page, context);
  await openButton(page).click();
  await expect(reel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reel(page)).toBeHidden();
  await expect(openButton(page)).toBeFocused();
  // Chromium takes focus({ focusVisible: false }): the tile holds focus without the browser's own
  // keyboard focus (where the option is unknown it would match: the last of these cases),
  // and it is marked for the tile's rules, as in every browser.
  expect(await openButton(page).evaluate((element) => element.matches(':focus-visible'))).toBe(false);
  await expect(openButton(page)).toHaveAttribute('data-quiet-focus', '');

  await pointerAway(page);
  await expect.poll(() => controlsOpacity(page), { timeout: 3_000 }).toBe('0');
  await expect.poll(() => frameBorderColor(page), { timeout: 3_000 }).not.toBe(TILE_FOCUS_BORDER);
});

test('a tile opened in the reel with the pointer shows its controls again once the reader tabs on after the close', async ({ page, context }) => {
  await openLane(page, context);
  await openButton(page).click();
  await expect(reel(page)).toBeVisible();
  await reel(page).getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(openButton(page)).toBeFocused();
  await pointerAway(page);
  await expect.poll(() => controlsOpacity(page), { timeout: 3_000 }).toBe('0');

  // By keyboard now: focus moves to the tile's own ⋯, and shows.
  await page.keyboard.press('Tab');
  await expect(tileMenuButton(page)).toBeFocused();
  await expect.poll(() => controlsOpacity(page), { timeout: 3_000 }).toBe('1');
  await expect.poll(() => frameBorderColor(page), { timeout: 3_000 }).toBe(TILE_FOCUS_BORDER);
});

// Review of #834: a key pressed later with focus still on the tile (Escape again, End) must not bring
// its controls back, wherever a browser would draw that focus as keyboard focus again: the mark
// holds until the reader moves on.
test('a tile given focus back quietly keeps its controls hidden through later keys that do not move focus', async ({ page, context }) => {
  await openLane(page, context);
  await openButton(page).click();
  await expect(reel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reel(page)).toBeHidden();
  await expect(openButton(page)).toBeFocused();

  await page.keyboard.press('Escape');
  await page.keyboard.press('End');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(openButton(page)).toBeFocused();
  await expect(openButton(page)).toHaveAttribute('data-quiet-focus', '');

  await pointerAway(page);
  await expect.poll(() => controlsOpacity(page), { timeout: 3_000 }).toBe('0');
  await expect.poll(() => frameBorderColor(page), { timeout: 3_000 }).not.toBe(TILE_FOCUS_BORDER);
});

// A browser whose focus() takes no `focusVisible` option (src/app/showcase/reel-focus-return.ts):
// the tile focus goes back to is marked instead, until the reader moves on by keyboard.
test('where focus() takes no focusVisible option, a tile closed with Escape is marked quiet until the reader tabs on', async ({ page, context }) => {
  await page.addInitScript(() => {
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function focusWithoutVisibilityOption(this: HTMLElement, options?: FocusOptions) {
      return focus.call(this, options ? { preventScroll: options.preventScroll } : undefined);
    };
  });
  await openLane(page, context);
  await openButton(page).click();
  await expect(reel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reel(page)).toBeHidden();
  await expect(openButton(page)).toBeFocused();
  // Without the option the browser draws the focus given back after a key as keyboard focus...
  expect(await openButton(page).evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  // ...and the mark is what keeps the tile's controls and frame quiet.
  await expect(openButton(page)).toHaveAttribute('data-quiet-focus', '');

  await pointerAway(page);
  await expect.poll(() => controlsOpacity(page), { timeout: 3_000 }).toBe('0');
  await expect.poll(() => frameBorderColor(page), { timeout: 3_000 }).not.toBe(TILE_FOCUS_BORDER);

  await page.keyboard.press('Tab');
  await expect(tileMenuButton(page)).toBeFocused();
  await expect(openButton(page)).not.toHaveAttribute('data-quiet-focus');
  await expect.poll(() => controlsOpacity(page), { timeout: 3_000 }).toBe('1');
});

type ReelFrame = {
  /** A picture is drawn where the media goes: loaded, not faded out and not covered in black. */
  pictureShown: boolean;
  /** The reel's own <img>, and the tile's picture copied in for it while that loads. */
  pictures: Array<{ kind: 'img' | 'tile picture'; src: string; complete: boolean; width: number; opacity: number }>;
  covered: boolean;
  /** Follow, or the place held for it, in the details. */
  follow: { x: number; y: number; width: number; height: number; text: string } | null;
  titleTop: number | null;
};

test('a tile opens its reel in one step: no "Opening preview", the tile\'s picture and Follow\'s place from the first frame', async ({ page, context }, testInfo) => {
  const { reelCodeLoaded } = await openLane(page, context);
  // The reel's code is warmed while the reader looks at the grid (idle time, the pointer over
  // it): nothing needs waiting for when the tile is pressed.
  await openButton(page).hover();
  await reelCodeLoaded();

  await page.evaluate((openedTitle) => {
    const probe = {
      sawOpeningPreview: false,
      frames: [] as unknown[],
    };
    (window as unknown as { __reelProbe: typeof probe }).__reelProbe = probe;
    const effectiveOpacity = (element: Element | null) => {
      let opacity = 1;
      for (let node = element; node; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
      }
      return opacity;
    };
    const snapshot = () => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Explore reel viewer"]');
      if (!dialog) return null;
      const stage = dialog.querySelector('[data-showcase-media-viewport]');
      const pictures = [
        ...Array.from(stage?.querySelectorAll('img') ?? []).map((image) => ({
          kind: 'img',
          src: image.currentSrc || image.src,
          complete: image.complete,
          width: image.naturalWidth,
          opacity: Number(effectiveOpacity(image).toFixed(3)),
        })),
        ...Array.from(stage?.querySelectorAll<HTMLCanvasElement>('canvas[data-tile-picture-stand-in]') ?? []).map((canvas) => ({
          kind: 'tile picture',
          src: '',
          complete: canvas.dataset.drawn === 'true',
          width: canvas.width,
          opacity: Number(effectiveOpacity(canvas).toFixed(3)),
        })),
      ];
      const cover = dialog.querySelector('[data-showcase-media-state="loading"]');
      const covered = Boolean(cover
        && effectiveOpacity(cover) > 0.05
        && getComputedStyle(cover).backgroundColor !== 'rgba(0, 0, 0, 0)');
      const followElement = dialog.querySelector('[data-reel-follow]')
        ?? Array.from(dialog.querySelectorAll('button')).find((button) => /^Follow(ing)? /.test(button.getAttribute('aria-label') ?? ''))
        ?? null;
      const followBox = followElement?.getBoundingClientRect();
      const title = Array.from(dialog.querySelectorAll('h2'))
        .find((heading) => heading.textContent?.trim() === openedTitle && heading.getBoundingClientRect().height > 0);
      return {
        pictureShown: !covered && pictures.some((picture) => picture.complete && picture.width > 0 && picture.opacity > 0.99),
        pictures,
        covered,
        follow: followBox && followElement
          ? { x: Math.round(followBox.x), y: Math.round(followBox.y), width: Math.round(followBox.width), height: Math.round(followBox.height), text: followElement.textContent?.trim() ?? '' }
          : null,
        titleTop: title ? Math.round(title.getBoundingClientRect().top) : null,
      };
    };
    let dialogSeen = false;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node.textContent?.includes('Opening preview')) probe.sawOpeningPreview = true;
        }
      }
      if (!dialogSeen && document.querySelector('[role="dialog"][aria-label="Explore reel viewer"]')) {
        dialogSeen = true;
        // What the reel's first frame draws: the commit that added the dialog, before its paint.
        probe.frames.push(snapshot());
        requestAnimationFrame(() => probe.frames.push(snapshot()));
        setTimeout(() => probe.frames.push(snapshot()), 250);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, OPENED.title);

  await openButton(page).click();
  await expect(reel(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('reel-just-opened.png') });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __reelProbe: { frames: unknown[] } }).__reelProbe.frames.length)).toBe(3);
  const probe = await page.evaluate(() => (window as unknown as { __reelProbe: { sawOpeningPreview: boolean; frames: ReelFrame[] } }).__reelProbe);
  testInfo.attach('reel-first-frames.json', { body: JSON.stringify(probe, null, 2), contentType: 'application/json' });
  console.log('reel probe', JSON.stringify(probe));

  // One step: the reel itself, never the "Opening preview" interstitial.
  expect(probe.sawOpeningPreview).toBe(false);
  const [first, nextFrame, later] = probe.frames;
  // The tile's picture from the first frame, and still while the reel's own copy is on its way.
  expect(first.pictureShown).toBe(true);
  expect(nextFrame.pictureShown).toBe(true);
  expect(later.pictureShown).toBe(true);
  // Follow's place is held from the first frame.
  expect(first.follow).not.toBeNull();
  expect(first.follow?.height).toBeGreaterThanOrEqual(40);

  // Then Follow itself, in the same place, and nothing under it moves.
  const follow = reel(page).getByRole('button', { name: `Follow ${exploreReel.creator.display_name}` });
  await expect(follow).toBeVisible();
  const followBox = await follow.boundingBox();
  expect(followBox).not.toBeNull();
  expect(Math.round(followBox!.x)).toBe(first.follow!.x);
  expect(Math.round(followBox!.y)).toBe(first.follow!.y);
  expect(Math.round(followBox!.width)).toBe(first.follow!.width);
  expect(Math.round(followBox!.height)).toBe(first.follow!.height);
  const title = reel(page).getByRole('heading', { level: 2, name: OPENED.title });
  expect(Math.round((await title.boundingBox())!.y)).toBe(first.titleTop);

  // And the reel's own, larger copy once it arrives.
  await expect.poll(() => reel(page).locator('[data-showcase-media-viewport] img').evaluateAll((images) => images
    .filter((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)
    .map((image) => (image as HTMLImageElement).currentSrc)), { timeout: 10_000 })
    .toEqual([expect.stringMatching(/\.display\.[a-f0-9]+\.webp$/)]);
  await page.screenshot({ path: testInfo.outputPath('reel-settled.png') });
});

// A refresh, or a shared link, on a post's reel address: the reel's code is not in the document
// yet, so the page is covered by the reel's own stage until the reel draws (reel-address-refresh
// .spec.ts, src/lib/reel-opening-restore.ts), as before.
test("Explore loaded on a post's reel address covers the page with the reel's stage until the reel draws", async ({ page, context }) => {
  await answerOffline(page, context);
  // The address once, unmeasured, so `next dev` has compiled the lane and the reel's chunk before
  // the load the frames are read from. A first compile of the reel outlasted the stage's 10-second
  // limit for a reel that never comes (`REEL_OPENING_COVER_MAX_MS`) on main's run of 2026-11-17:
  // the reel drew 16 s after the load, so the stage had given the page back. Built for production,
  // the chunk is ready with the page.
  await page.goto(`${LANE}&post=${OPENED.id}`, COLD_PAGE);
  await expect(reel(page).getByRole('heading', { level: 2, name: OPENED.title })).toBeVisible(COLD_PAGE);
  // What each frame drew until the reel's dialog was there: the stage, or the grid uncovered.
  await page.addInitScript(() => {
    const seen = { stage: false, gridUncovered: false };
    (window as unknown as { __beforeReel: typeof seen }).__beforeReel = seen;
    const watch = () => {
      if (document.querySelector('[role="dialog"][aria-label="Explore reel viewer"]')) return;
      const cover = document.querySelector('.reel-opening-cover');
      const covered = Boolean(cover && getComputedStyle(cover).display !== 'none');
      if (covered) seen.stage = true;
      else if (document.querySelector('[data-showcase-bootstrap-card], .showcase-card-actions')) seen.gridUncovered = true;
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  await page.goto(`${LANE}&post=${OPENED.id}`, COLD_PAGE);

  await expect(reel(page).getByRole('heading', { level: 2, name: OPENED.title })).toBeVisible(COLD_PAGE);
  expect(await page.evaluate(() => (window as unknown as { __beforeReel: unknown }).__beforeReel))
    .toEqual({ stage: true, gridUncovered: false });
  await expect(page.locator('.reel-opening-cover')).toBeHidden();
  expect(await page.locator('html').getAttribute('data-reel-opening')).toBeNull();
  // And the reel's own copy, in the end, whatever stood in for it meanwhile.
  await expect.poll(() => reel(page).locator('[data-showcase-media-viewport] img').evaluateAll((images) => images
    .filter((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)
    .map((image) => (image as HTMLImageElement).currentSrc)), { timeout: 10_000 })
    .toEqual([expect.stringMatching(/\.display\.[a-f0-9]+\.webp$/)]);
});

// Review of #834: the place held for Follow was Follow's own width, and a reader who already follows
// the creator gets "Following", with a border: the button grew leftwards when the answer landed.
test('Follow\'s place is held at the width the answer takes, "Following" for a creator the reader follows', async ({ page, context }) => {
  const { reelCodeLoaded } = await openLane(page, context, { following: true });
  await openButton(page).hover();
  await reelCodeLoaded();
  await openButton(page).click();

  const held = reel(page).locator('[data-reel-follow="pending"]');
  await expect(held).toBeVisible();
  const heldBox = await held.boundingBox();
  const title = reel(page).getByRole('heading', { level: 2, name: OPENED.title });
  const titleTop = (await title.boundingBox())!.y;

  const following = reel(page).getByRole('button', { name: `Following ${exploreReel.creator.display_name}` });
  await expect(following).toBeVisible();
  await expect(held).toHaveCount(0);
  const followingBox = await following.boundingBox();
  const rounded = (box: { x: number; y: number; width: number; height: number } | null) => box && {
    x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height),
  };
  expect(rounded(followingBox)).toEqual(rounded(heldBox));
  expect((await title.boundingBox())!.y).toBe(titleTop);
});
