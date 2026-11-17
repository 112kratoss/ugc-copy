import fs from 'node:fs';
import path from 'node:path';

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type TestInfo,
} from '@playwright/test';

import exploreReel from './fixtures/explore-reel.json';

// The web sweep of 2026-11-17: on an Explore lane with an active filter (a tool, as here, a recipe
// filter or a kind of resource), the page moved down by the filter bar's row of active filters when
// the full client (ShowcaseClient) took over from the server's shell (ShowcaseBootstrapClient), which
// did not draw that row. A visitor's shell hands over on their first interaction, a scroll of 24px or
// more among them, so the grid jumped under a reader who was scrolling; a signed-in reader's hands
// over once the session check finds them, just after the load. On main (5a3c5d47d) the grid moved
// 46px on a phone and 47px on a laptop: from 640px the row is 50px, and the shell's header was 3px
// taller than the full page's (its eyebrow led by a dot, not the full page's icon).
//
// Every frame from the document's first is recorded: which of Explore's three drawings is on screen
// (the loading outline, (feed)/loading.tsx, which shows until the streamed page is swapped in; the
// server's shell; the full client) and where the grid and its first post's picture are drawn, in the
// page's own coordinates (the window's top plus its scroll), so the reader's own scroll is not counted
// as a move.
//
// The dev server answers Explore's Recent lane for the fixture's own tool
// (support/supabase-server-stub.cjs, fixtures/explore-reel.json): three pictures by a creator of their
// own, read on the server, so the grid is drawn offline. The tool is not in the catalog the page reads
// (none, offline: the app's own list), so its filter is named by its slug.

const LANE = `/showcase?sort=recent&tool=${exploreReel.toolSlug}`;
const TOOL_FILTER_LABEL = exploreReel.toolSlug;
const [FIRST] = exploreReel.posts;
// In `next dev` a page compiles on its first request; offline Explore also waits on reads.
const COLD_PAGE = { timeout: 60_000 };
const PHONE: BrowserContextOptions = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };
const LAPTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
// The reader's scroll: past the 24px at which the shell hands over.
const READER_SCROLL = 40;
const PREVIEW_PICTURE = fs.readFileSync(path.join(__dirname, 'fixtures/red.png'));

test.describe.configure({ timeout: 180_000 });

/** Every API call refused and the lane's grid previews served; signed in as the E2E user when asked. */
async function answerOffline(context: BrowserContext, baseURL: string, { signedIn }: { signedIn: boolean }) {
  if (signedIn) {
    await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: baseURL }]);
  }
  await context.route('https://example.supabase.co/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/storage/v1/object/public/showcase_media/')) {
      return route.fulfill({ contentType: 'image/png', body: PREVIEW_PICTURE });
    }
    if (pathname.startsWith('/rest/v1/')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
}

/**
 * A lane of three posts is shorter than a laptop's window, and a page that cannot scroll cannot be
 * scrolled past the shell's 24px: every load is 6000px tall from its first layout, below the grid
 * (as reload-opens-at-top.spec.ts makes its pages), as a lane of a dozen posts is.
 */
async function tallPage(page: Page) {
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = '.app-shell-content { min-height: 6000px !important; }';
    // An init script can run before the document has a root element.
    const keep = () => {
      const home = document.head ?? document.documentElement;
      if (home && style.parentNode !== home) home.appendChild(style);
    };
    keep();
    new MutationObserver(keep).observe(document, { childList: true, subtree: true });
  });
}

type Drawing = 'outline' | 'shell' | 'full';

type Frame = {
  /** Which of Explore's drawings is on screen. */
  drawing: Drawing | null;
  /** The window's scroll: the reader's own. */
  scrollY: number;
  /** The top of the first post's picture, in the page's coordinates. */
  picture: number | null;
  /** The top of the grid (the outline's placeholder cards too), in the page's coordinates. */
  grid: number | null;
};

type Recorder = { __exploreFrames: Frame[]; __exploreShellListening: boolean };

/**
 * Records every frame from the document's first. It also notes when the shell starts watching its
 * sentinel, which it does in the commit that starts its listeners: a scroll hands over from then on.
 */
async function recordFrames(page: Page) {
  await page.addInitScript((title) => {
    if (window.top !== window) return;
    const recorder = window as unknown as Recorder;
    recorder.__exploreFrames = [];
    recorder.__exploreShellListening = false;
    const observe = IntersectionObserver.prototype.observe;
    IntersectionObserver.prototype.observe = function observeAndTell(this: IntersectionObserver, target: Element) {
      if (target.matches('[data-showcase-bootstrap-sentinel]')) recorder.__exploreShellListening = true;
      return observe.call(this, target);
    };
    const shown = (element: Element | null | undefined): element is Element => Boolean(element && element.getClientRects().length > 0);
    const pageTop = (element: Element) => Math.round((element.getBoundingClientRect().top + window.scrollY) * 100) / 100;
    const labelled = (selector: string, label: string) => [...document.querySelectorAll(selector)]
      .find((element) => element.getAttribute('aria-label') === label && shown(element));
    const read = () => {
      const fullPicture = labelled('button', title);
      const shellPicture = labelled('[data-showcase-bootstrap-card] a', `Open ${title} in viewer`);
      const outline = document.querySelector('[role="status"][aria-label="Loading Explore"]');
      const picture = fullPicture ?? shellPicture;
      const grid = [...document.querySelectorAll('div.grid.items-start')].find(shown);
      recorder.__exploreFrames.push({
        drawing: fullPicture ? 'full' : shellPicture ? 'shell' : shown(outline) ? 'outline' : null,
        scrollY: window.scrollY,
        picture: picture ? pageTop(picture) : null,
        grid: grid ? pageTop(grid) : null,
      });
      requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
  }, FIRST.title);
}

/** The frames so far, once a second of them has passed (so a late change is among them). */
async function framesAfterASecond(page: Page): Promise<Frame[]> {
  return page.evaluate(() => new Promise<Frame[]>((resolve) => {
    let frames = 0;
    const wait = () => {
      frames += 1;
      if (frames < 60) {
        requestAnimationFrame(wait);
        return;
      }
      resolve((window as unknown as Recorder).__exploreFrames.slice());
    };
    requestAnimationFrame(wait);
  }));
}

/** Runs of equal frames, for the report. */
function runsOf(frames: Frame[]) {
  const runs: Array<Frame & { frames: number }> = [];
  for (const frame of frames) {
    const last = runs.at(-1);
    if (last && last.drawing === frame.drawing && last.scrollY === frame.scrollY
      && last.picture === frame.picture && last.grid === frame.grid) {
      last.frames += 1;
    } else {
      runs.push({ ...frame, frames: 1 });
    }
  }
  return runs;
}

/** Each frame in which the grid or its first picture moved in the page, from the frame before. */
function movesOf(frames: Frame[]) {
  return frames.flatMap((frame, index) => {
    const before = frames[index - 1];
    if (!before) return [];
    const pictureMoved = before.picture !== null && frame.picture !== null && before.picture !== frame.picture;
    const gridMoved = before.grid !== null && frame.grid !== null && before.grid !== frame.grid;
    return pictureMoved || gridMoved
      ? [{
        frame: index,
        drawing: `${before.drawing} → ${frame.drawing}`,
        picture: pictureMoved ? Math.round((frame.picture! - before.picture!) * 100) / 100 : 0,
        grid: gridMoved ? Math.round((frame.grid! - before.grid!) * 100) / 100 : 0,
        scrollY: `${before.scrollY} → ${frame.scrollY}`,
      }]
      : [];
  });
}

/**
 * The hand-over is among the frames, the shell's then the full client's, and in none did the grid
 * or its first picture move in the page, or the window scroll but by the reader.
 */
async function expectHandOverMovedNothing(frames: Frame[], readerScrolls: number[], testInfo: TestInfo) {
  const runs = runsOf(frames);
  const moves = movesOf(frames);
  const report = JSON.stringify({ moves, runs });
  console.log(`[${testInfo.titlePath.slice(1).join(' › ')}] ${report}`);
  await testInfo.attach('explore-frames.json', { body: JSON.stringify({ moves, runs, frames }, null, 2), contentType: 'application/json' });

  const firstShellFrame = frames.findIndex((frame) => frame.drawing === 'shell');
  const firstFullFrame = frames.findIndex((frame) => frame.drawing === 'full');
  expect(firstShellFrame, report).toBeGreaterThanOrEqual(0);
  expect(firstFullFrame, report).toBeGreaterThan(firstShellFrame);
  expect([...new Set(frames.map((frame) => frame.scrollY))].filter((y) => !readerScrolls.includes(y)), report).toEqual([]);
  expect(moves, report).toEqual([]);
}

const fullClientDrawn = (page: Page) => page.getByRole('button', { name: `More actions for ${FIRST.title}` });

for (const [where, device] of [['on a laptop', LAPTOP], ['on a phone', PHONE]] as const) {
  test.describe(where, () => {
    test.use(device);

    test('a visitor\'s first scroll hands Explore over to the full page without moving the grid', async ({ page, context, baseURL }, testInfo) => {
      await answerOffline(context, baseURL!, { signedIn: false });
      await tallPage(page);
      await recordFrames(page);
      await page.goto(LANE, COLD_PAGE);

      // The server's shell, listening for the reader, and nothing handed over yet.
      await expect(page.locator('[data-showcase-bootstrap-card]').first()).toBeVisible(COLD_PAGE);
      await expect.poll(() => page.evaluate(() => (window as unknown as Recorder).__exploreShellListening), COLD_PAGE).toBe(true);
      await expect(fullClientDrawn(page)).toHaveCount(0);

      await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), READER_SCROLL);
      await expect(fullClientDrawn(page)).toBeAttached(COLD_PAGE);

      await expectHandOverMovedNothing(await framesAfterASecond(page), [0, READER_SCROLL], testInfo);
    });

    test('a signed-in reader\'s Explore hands over to the full page without moving the grid', async ({ page, context, baseURL }, testInfo) => {
      await answerOffline(context, baseURL!, { signedIn: true });
      await recordFrames(page);
      await page.goto(LANE, COLD_PAGE);
      await expect(fullClientDrawn(page)).toBeAttached(COLD_PAGE);

      await expectHandOverMovedNothing(await framesAfterASecond(page), [0], testInfo);
    });
  });
}

type Box = { top: number; height: number };

type Layout = {
  /** The filter bar. */
  bar: Box;
  /** The bar's row of active filters (or the outline's place for it). */
  row: Box | null;
  grid: number;
  /** The first post's picture (the outline has none). */
  picture: number | null;
};

/** The page's layout at its top, in the page's coordinates. */
async function layoutOf(page: Page): Promise<Layout> {
  return page.evaluate(({ title, toolFilterLabel }) => {
    const shown = (element: Element | null | undefined): element is Element => Boolean(element && element.getClientRects().length > 0);
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { top: Math.round((rect.top + window.scrollY) * 100) / 100, height: Math.round(rect.height * 100) / 100 };
    };
    const bar = [...document.querySelectorAll('[data-explore-filter-bar]')].find(shown);
    const grid = [...document.querySelectorAll('div.grid.items-start')].find(shown);
    if (!bar || !grid) throw new Error('No filter bar and grid on screen');
    // The row is marked in each drawing; before the fix only the full page drew it, unmarked, so it
    // is also found by its pill.
    const pill = [...bar.querySelectorAll('a, button')].find((element) => element.textContent?.trim() === toolFilterLabel);
    const row = bar.querySelector('[data-explore-active-filters]') ?? pill?.parentElement ?? null;
    const picture = [...document.querySelectorAll('a, button')].find((element) => (
      shown(element) && [title, `Open ${title} in viewer`].includes(element.getAttribute('aria-label') ?? '')
    ));
    return {
      bar: box(bar),
      row: shown(row) ? box(row) : null,
      grid: box(grid).top,
      picture: picture ? box(picture).top : null,
    };
  }, { title: FIRST.title, toolFilterLabel: TOOL_FILTER_LABEL });
}

// Each of Tailwind's breakpoints and the width under it, a phone's and a laptop's.
const WIDTHS = [375, 639, 640, 767, 768, 1023, 1024, 1279, 1280, 1440, 1535, 1536];

/**
 * One of Explore's three drawings of the lane, signed in, read at each width: the loading outline
 * (no script, so the streamed page is never swapped in), the server's shell (the full client's code
 * refused, so it stays) and the full client.
 */
async function drawingAtEachWidth(browser: Browser, baseURL: string, drawing: Drawing) {
  const context = await browser.newContext({ ...LAPTOP, javaScriptEnabled: drawing !== 'outline' });
  try {
    await answerOffline(context, baseURL, { signedIn: true });
    let fullClientRefused = false;
    if (drawing === 'shell') {
      await context.route(/\/_next\/static\/chunks\/.*ShowcaseClient/, (route) => {
        fullClientRefused = true;
        return route.abort();
      });
    }
    const page = await context.newPage();
    await page.goto(LANE, COLD_PAGE);
    if (drawing === 'outline') {
      await expect(page.getByRole('status', { name: 'Loading Explore' })).toBeVisible(COLD_PAGE);
    } else if (drawing === 'shell') {
      await expect(page.getByRole('navigation', { name: 'Explore filters' })).toBeVisible(COLD_PAGE);
      await expect.poll(() => fullClientRefused, COLD_PAGE).toBe(true);
      // The shell takes the refusal back (no `aria-busy`) and stays.
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    } else {
      await expect(fullClientDrawn(page)).toBeAttached(COLD_PAGE);
    }

    const layouts: Record<number, Layout> = {};
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: LAPTOP.viewport!.height });
      // Two frames, so what the page's script draws for the new width is drawn (a page without
      // script runs no frame callback: its layout, read below, is the new width's at once).
      if (drawing !== 'outline') {
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      layouts[width] = await layoutOf(page);
    }
    return layouts;
  } finally {
    await context.close();
  }
}

test('the outline, the shell and the full page draw the filter bar, its row of active filters and the grid alike at every width', async ({ browser, baseURL }, testInfo) => {
  const outline = await drawingAtEachWidth(browser, baseURL!, 'outline');
  const shell = await drawingAtEachWidth(browser, baseURL!, 'shell');
  const full = await drawingAtEachWidth(browser, baseURL!, 'full');
  const report = JSON.stringify({ outline, shell, full });
  console.log(`[${testInfo.title}] ${report}`);
  await testInfo.attach('explore-layouts.json', { body: JSON.stringify({ outline, shell, full }, null, 2), contentType: 'application/json' });

  // The full page draws the lane's filter in its row at every width.
  for (const width of WIDTHS) {
    expect(full[width].row, `${width}px: ${report}`).not.toBeNull();
  }
  // The shell draws the full page's layout, picture included...
  expect(shell).toEqual(full);
  // ...and the outline holds the same places for the bar, its row and the grid.
  const withoutPicture = (layouts: Record<number, Layout>) => Object.fromEntries(
    Object.entries(layouts).map(([width, { bar, row, grid }]) => [width, { bar, row, grid }]),
  );
  expect(withoutPicture(outline)).toEqual(withoutPicture(full));
});
