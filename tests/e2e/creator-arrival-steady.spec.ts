import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * What a creator shows while it arrives, frame by frame, signed in at a desktop's width (the web sweep
 * of 2026-11-17, item F, measured on magicbooklet.com):
 * - F1: Generate read "Loading settings…" for about half a second after the page loaded, until the
 *   page's own catalog was in (the sweep took it for the settings chip beside it), and the motion
 *   creator's then turned to "Add both inputs";
 * - F2: then "Calculating..." for about 0.4 s, until the page's own quote came back, at the price the
 *   server had already drawn under the bar;
 * - F3: the "Start from a post" pictures were asked for at about 1.7 s and were the page's LCP at
 *   1.84 s. The posts came in a later part of the page's stream, after the whole first part (about a
 *   megabyte there), drawn as empty places until then, and each picture was lazy, so it was asked for
 *   only once that part was shown and laid out: on a signed-out load of /create-image, after
 *   DOMContentLoaded at 1.56 s, at 1.78 s. And once the page had hydrated, next/image set every
 *   picture's `src` again (its replay of an error React never saw, for the `onError` that
 *   `OptimizedPreviewImage` hands it), which asks for a picture again where the browser has not kept
 *   it, as here, and draws it blank until it is back.
 *
 * Each frame from the document's first is read by an init script's requestAnimationFrame loop: the
 * settings chip, Generate (its face and its name), and the canvas's posts (their cards, the places
 * held for them, and their pictures, each counted once it has drawn). Offline the page's own quote is
 * answered here at the server's price for the run, so the price comes back the same, as it does on
 * production; the pictures are answered with a fixture's, never cached, so each time one is asked for
 * shows as a request.
 *
 * The posts are the "Make this" shelf's pins, which the E2E server answers from
 * fixtures/creator-start-posts.json (supabase-server-stub.cjs).
 */

const COLD_PAGE = { timeout: 45_000 };
const BLUE_PNG = fs.readFileSync(path.join(__dirname, 'fixtures/blue.png'));
/** Where the frames are written as well, for a run that keeps them (a local check). */
const FRAMES_DIR = process.env.CREATOR_ARRIVAL_FRAMES_DIR;

test.use({ viewport: { width: 1440, height: 900 } });

type Frame = {
  chip: string | null;
  generate: { face: string; name: string | null; disabled: boolean; busy: boolean } | null;
  posts: { cards: number; places: number; pictures: number; drawn: number } | null;
  /** The HTML parser had not left the chip or Generate when the frame was drawn (`recordFrames`). */
  parsing: boolean;
};
/** A run of identical frames: what they showed, and from when to when (ms since the navigation began). */
type Stretch = Frame & { from: number; to: number; count: number };

type Arrival = {
  stretches: Stretch[];
  navigation: { responseStart: number; responseEnd: number; domContentLoaded: number; load: number };
  /** Each start-post picture's request, ms since the navigation began. */
  pictures: Array<{ name: string; startTime: number; responseEnd: number }>;
  /** The page's first mount-time request, which only its script sends once React has committed. */
  firstMountRequestAt: number | null;
  largestContentfulPaint: { startTime: number; element: string } | null;
};

async function signIn(context: BrowserContext) {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
}

/** The page's own quote, at the server's price for the run it opened on; returns how many were asked. */
async function answerQuote(page: Page, costCredits: number) {
  const asked: unknown[] = [];
  await page.route('**/api/generation-models/quote', async (route) => {
    const request = (route.request().postDataJSON() ?? {}) as { modelId?: string; catalogRevision?: string };
    asked.push(request);
    await route.fulfill({
      json: { modelId: request.modelId ?? 'unknown', catalogRevision: request.catalogRevision ?? 'unknown', normalizedSettings: {}, costCredits },
    });
  });
  return asked;
}

/** The start posts' pictures, from the placeholder project's storage, which has no address offline. */
async function answerPictures(page: Page) {
  await page.route('https://example.supabase.co/storage/v1/object/public/**', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: BLUE_PNG,
  }));
}

/** Reads every animation frame from the document's first, keeping a run of identical frames as one stretch. */
async function recordFrames(page: Page) {
  await page.addInitScript(() => {
    type Read = {
      chip: string | null;
      generate: { face: string; name: string | null; disabled: boolean; busy: boolean } | null;
      posts: { cards: number; places: number; pictures: number; drawn: number } | null;
      parsing: boolean;
    };
    const stretches: Array<Read & { from: number; to: number; count: number }> = [];
    const lcp: Array<{ startTime: number; element: string }> = [];
    (window as unknown as { __arrival: unknown }).__arrival = { stretches, lcp };
    const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    // Chrome's HTML parser stops to let the page be drawn on a time budget, whether or not the whole
    // document is in, so a frame can be drawn from a part it has not finished: a CI run of
    // 2026-11-17 drew Generate at 204 ms with its attributes and none of its words, 134 ms before
    // DOMContentLoaded (the whole document was in at 126 ms), and the next frame whole. Nothing
    // follows a part in the document until the parser has left it, so such a frame is marked, and
    // the bar's checks leave it out: what the page draws, not where the parser stopped, is judged.
    const unfinished = (element: Element | null | undefined) => {
      if (!element || document.readyState !== 'loading') return false;
      for (let node: Node | null = element; node && node !== document.documentElement; node = node.parentNode) {
        if (node.nextSibling) return false;
      }
      return true;
    };
    const read = (): Read => {
      const bar = document.querySelector('[data-creator-bar]');
      const button = bar
        ? [...bar.querySelectorAll('button')].find((candidate) => (candidate.getAttribute('aria-label') ?? '').startsWith('Generate · ')
          || text(candidate) === 'Sign up to generate')
        : undefined;
      const chip = document.querySelector('[data-testid="creator-settings-summary"]');
      const canvas = document.querySelector('[data-testid="creator-start-posts"]');
      const pictures = canvas ? [...canvas.querySelectorAll('li img')] as HTMLImageElement[] : [];
      return {
        parsing: unfinished(chip) || unfinished(button),
        chip: text(chip),
        generate: button
          ? {
            face: text(button) ?? '',
            name: button.getAttribute('aria-label'),
            disabled: (button as HTMLButtonElement).disabled,
            busy: button.getAttribute('aria-busy') === 'true',
          }
          : null,
        posts: canvas
          ? {
            cards: canvas.querySelectorAll('li a[href^="/showcase/"]').length,
            places: canvas.querySelectorAll('ul[aria-hidden="true"] > li').length,
            pictures: pictures.length,
            drawn: pictures.filter((picture) => picture.complete && picture.naturalWidth > 0).length,
          }
          : null,
      };
    };
    const tick = () => {
      const now = Math.round(performance.now());
      const frame = read();
      const last = stretches.at(-1);
      if (last && JSON.stringify({ ...last, from: 0, to: 0, count: 0 }) === JSON.stringify({ ...frame, from: 0, to: 0, count: 0 })) {
        last.to = now;
        last.count += 1;
      } else {
        stretches.push({ ...frame, from: now, to: now, count: 1 });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<PerformanceEntry & { element?: Element | null }>) {
          const element = entry.element;
          lcp.push({
            startTime: Math.round(entry.startTime),
            element: element ? `${element.tagName}${element instanceof HTMLImageElement ? ` ${element.currentSrc.split('/').pop()}` : ` "${text(element)?.slice(0, 40)}"`}` : 'none',
          });
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      // No LCP in this browser: the frames say what was drawn.
    }
  });
}

async function readArrival(page: Page): Promise<Arrival> {
  return page.evaluate(() => {
    const recorded = (window as unknown as {
      __arrival: { stretches: Stretch[]; lcp: Array<{ startTime: number; element: string }> };
    }).__arrival;
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const mount = resources.find((entry) => /\/api\/(model-catalog\/v1\/current|app-version)/.test(entry.name));
    return {
      stretches: recorded.stretches,
      navigation: {
        responseStart: Math.round(navigation.responseStart),
        responseEnd: Math.round(navigation.responseEnd),
        domContentLoaded: Math.round(navigation.domContentLoadedEventStart),
        load: Math.round(navigation.loadEventStart),
      },
      pictures: resources
        .filter((entry) => entry.name.includes('/storage/v1/object/public/') && entry.name.includes('e2e-shelf-creator'))
        .map((entry) => ({ name: entry.name.split('/').pop() ?? entry.name, startTime: Math.round(entry.startTime), responseEnd: Math.round(entry.responseEnd) })),
      firstMountRequestAt: mount ? Math.round(mount.startTime) : null,
      largestContentfulPaint: recorded.lcp.at(-1) ?? null,
    };
  });
}

/**
 * Opens a creator signed in and reads its arrival once it has settled: its catalog in and, where the run
 * can be priced (`costCredits`), its own quote asked and answered, every start post's picture drawn,
 * and a second more for anything that would still change.
 *
 * The route is asked for once first, so the load measured is a warm server's, as on production: the
 * dev server's first request compiles the route, and the shelf's build is made then and kept, which a
 * slow runner could take past the moment the page stops waiting for the posts.
 */
async function arrive(page: Page, address: string, costCredits: number | null, name: string): Promise<Arrival> {
  await page.request.get(address, { timeout: 0 });
  const quotes = await answerQuote(page, costCredits ?? 0);
  const catalogDetails: string[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/model-catalog/v1/details') catalogDetails.push(response.url());
  });
  await answerPictures(page);
  await recordFrames(page);
  await page.goto(address, COLD_PAGE);
  await expect.poll(() => catalogDetails.length, { ...COLD_PAGE, message: 'the page reads its catalog once its script runs' }).toBeGreaterThan(0);
  if (costCredits !== null) {
    await expect.poll(() => quotes.length, { ...COLD_PAGE, message: 'the page asks its own price' }).toBeGreaterThan(0);
  }
  const posts = page.getByTestId('creator-start-posts');
  await expect(posts.getByRole('link', { name: /^Remix “/ })).toHaveCount(3, COLD_PAGE);
  await expect.poll(() => posts.locator('li img').evaluateAll((pictures) => (
    pictures.filter((picture) => (picture as HTMLImageElement).complete && (picture as HTMLImageElement).naturalWidth > 0).length
  )), COLD_PAGE).toBe(3);
  await page.waitForTimeout(1_000);
  const arrival = await readArrival(page);
  if (FRAMES_DIR) {
    fs.mkdirSync(FRAMES_DIR, { recursive: true });
    fs.writeFileSync(path.join(FRAMES_DIR, `${name}.json`), `${JSON.stringify(arrival, null, 1)}\n`);
  }
  await test.info().attach(`${name}-frames`, { body: JSON.stringify(arrival, null, 1), contentType: 'application/json' });
  return arrival;
}

/** Each stretch as one line, for a failure's message. */
function describeStretches(stretches: Stretch[]): string {
  return stretches.map((stretch) => (
    `${stretch.from}–${stretch.to} ms (${stretch.count} frames): chip ${JSON.stringify(stretch.chip)}, Generate ${JSON.stringify(stretch.generate?.face ?? null)}`
    + (stretch.generate ? ` (${JSON.stringify(stretch.generate.name)}${stretch.generate.disabled ? ', held' : ''}${stretch.generate.busy ? ', busy' : ''})` : '')
    + (stretch.posts ? `, posts ${stretch.posts.cards} cards, ${stretch.posts.places} places, ${stretch.posts.drawn}/${stretch.posts.pictures} pictures drawn` : '')
    + (stretch.parsing ? ', the parser inside the bar' : '')
  )).join('\n');
}

/** The frames that draw the bar, once the parser has left the part of it they show (`recordFrames`). */
function barFrames(arrival: Arrival): Stretch[] {
  const drawn = arrival.stretches.filter((stretch) => !stretch.parsing && (stretch.chip !== null || stretch.generate !== null));
  expect(drawn.length, 'the bar is drawn').toBeGreaterThan(0);
  return drawn;
}

/** What every frame that draws the bar shows: one chip and one Generate, from the first such frame to the last. */
function expectSteadyBar(arrival: Arrival, expected: { chip: string; generate: string }) {
  const unsteady = barFrames(arrival).filter((stretch) => stretch.chip !== expected.chip || stretch.generate?.face !== expected.generate);
  expect.soft(unsteady, `every frame shows "${expected.chip}" and "${expected.generate}":\n${describeStretches(arrival.stretches)}`).toEqual([]);
}

/**
 * Generate's hand-over to the page's own quote: while the server's price stands in, Generate is held and
 * busy, its name saying the price is being checked; once the page's own price is in, its name is the
 * price alone and it is busy no more. `enabledAtLast`: the video creator takes a press with an empty
 * prompt (it refuses one in `handleGenerate`), so its last frame is enabled.
 */
function expectHandOver(arrival: Arrival, { enabledAtLast }: { enabledAtLast: boolean }) {
  const generate = barFrames(arrival).map((stretch) => stretch.generate);
  const standingIn = generate.filter((frame) => frame?.busy);
  const lines = describeStretches(arrival.stretches);
  expect.soft(standingIn.length, `the server's price stands in, busy, before the page's own is in:\n${lines}`).toBeGreaterThan(0);
  const unexplained = standingIn.filter((frame) => !frame!.disabled || frame!.name !== `${frame!.face} · Checking the price`);
  expect.soft(unexplained, `a price standing in is held, and named as being checked:\n${lines}`).toEqual([]);
  const last = generate.at(-1);
  expect.soft(last?.busy, `the last frame has the page's own price:\n${lines}`).toBe(false);
  expect.soft(last?.name, `the last frame's name is its price alone:\n${lines}`).toBe(last?.face);
  if (enabledAtLast) expect.soft(last?.disabled, `the last frame takes a press:\n${lines}`).toBe(false);
}

/** Generate's faces in the order the frames show them, each once in a row. */
function generateFaces(arrival: Arrival): string[] {
  return barFrames(arrival)
    .map((stretch) => stretch.generate?.face ?? '')
    .filter((face, index, faces) => index === 0 || face !== faces[index - 1]);
}

const SHELF_PICTURES = ['giraffe.preview.e2e5f0b1.webp', 'kite.preview.e2e5f0b3.webp', 'mug.preview.e2e5f0b2.webp'];

/**
 * The posts arrive with the page: every frame that draws the canvas's posts draws their cards, never
 * the places held for them; each picture is asked for once, while the page's HTML is read, before the
 * page's script has hydrated; and a picture once drawn is never drawn blank again.
 */
function expectPostsWithThePage(arrival: Arrival) {
  const withPosts = arrival.stretches.filter((stretch) => stretch.posts !== null);
  expect(withPosts.length, 'the canvas draws its posts').toBeGreaterThan(0);
  const held = withPosts.filter((stretch) => stretch.posts!.places > 0 || stretch.posts!.cards === 0);
  expect.soft(held, `no frame holds places for the posts:\n${describeStretches(arrival.stretches)}`).toEqual([]);

  const asked = arrival.pictures.map((picture) => `${picture.name} at ${picture.startTime} ms`).join(', ');
  expect.soft(arrival.pictures.map((picture) => picture.name).sort(), `each picture is asked for once (${asked})`).toEqual(SHELF_PICTURES);
  const late = arrival.pictures.filter((picture) => picture.startTime > arrival.navigation.domContentLoaded);
  expect.soft(late, `each picture is asked for while the HTML is read, before DOMContentLoaded at ${arrival.navigation.domContentLoaded} ms`).toEqual([]);
  expect(arrival.firstMountRequestAt, 'the page\'s script mounted').not.toBeNull();
  const afterHydration = arrival.pictures.filter((picture) => picture.startTime >= arrival.firstMountRequestAt!);
  expect.soft(afterHydration, `no picture is asked for once the page has hydrated (its first mount request at ${arrival.firstMountRequestAt} ms)`).toEqual([]);

  const firstDrawn = withPosts.findIndex((stretch) => stretch.posts!.pictures > 0 && stretch.posts!.drawn === stretch.posts!.pictures);
  expect(firstDrawn, 'the pictures are drawn').toBeGreaterThanOrEqual(0);
  const blanked = withPosts.slice(firstDrawn).filter((stretch) => stretch.posts!.drawn < stretch.posts!.pictures);
  expect.soft(blanked, `a picture once drawn stays drawn:\n${describeStretches(arrival.stretches)}`).toEqual([]);
}

test.describe('signed in, a creator arrives steady', () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test('the image creator: one chip and one price from the first frame, and its posts with the page', async ({ page }) => {
    const arrival = await arrive(page, '/create-image', 8, 'create-image');
    expectSteadyBar(arrival, { chip: '1K · AUTO · JPG', generate: 'Generate · 8 credits' });
    // An empty prompt holds the image creator's Generate.
    expectHandOver(arrival, { enabledAtLast: false });
    expectPostsWithThePage(arrival);
  });

  test('the video creator: one chip and one price from the first frame, and its posts with the page', async ({ page }) => {
    const arrival = await arrive(page, '/create-video', 19, 'create-video');
    expectSteadyBar(arrival, { chip: '480P · 16:9 · 5s · Sound off', generate: 'Generate · 19 credits' });
    expectHandOver(arrival, { enabledAtLast: true });
    expectPostsWithThePage(arrival);
  });

  test('a creator whose own quote answers another price moves to it, straight from the server\'s', async ({ page }) => {
    // The page's own quote is the price a start goes at: the server's stands in only until it is in.
    const arrival = await arrive(page, '/create-video', 21, 'create-video-own-price');
    expect.soft(generateFaces(arrival), describeStretches(arrival.stretches)).toEqual(['Generate · 19 credits', 'Generate · 21 credits']);
    expectHandOver(arrival, { enabledAtLast: true });
    expect.soft(barFrames(arrival).filter((stretch) => stretch.generate?.face === 'Generate · 21 credits' && stretch.generate.busy))
      .toEqual([]);
  });

  test('the motion creator: one chip and "Add both inputs" from the first frame, and its posts with the page', async ({ page }) => {
    // A motion run is priced by its clip's length: there is nothing to price until both inputs are in.
    const arrival = await arrive(page, '/create-motion', null, 'create-motion');
    expectSteadyBar(arrival, { chip: '720P · Add motion', generate: 'Add both inputs' });
    expectPostsWithThePage(arrival);
  });
});
