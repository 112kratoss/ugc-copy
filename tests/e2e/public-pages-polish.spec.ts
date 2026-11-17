import { expect, test, type Locator, type Page } from '@playwright/test';

// The defects the signed-out sweep of 2026-11-17 (part B of sweep 4) found on public pages, each
// measured as the sweep measured it, at a phone's 375 × 812 unless a case says otherwise:
// 1. /developers/mcp/posting scrolled sideways: its "Connect it" grid kept one column as wide as the
//    longest code line (`min-width: auto`), so the document was 489px wide and the bottom bar sat
//    partly off the screen.
// 2. /models showed no costs: each cost table was 600px wide in a 343px scroll box, the Model column
//    alone in view, with no cue that more lay to the side; descriptions ran past its edge.
// 3. /models/<slug> hid its "Approx. cost" (380px in 343px) and its settings' Default (520px).
// 4. /marketplace: once the full client took over, the open filter panel was 445px on a 375px screen:
//    its Kind row of six chips widened the grid (`FilterGroup` lacked the shell's `min-w-0`).
// 5. /blog: each post card link wrapped an <article>, and Chrome takes no name from inside one.
// 6. The MCP pages' code boxes were cut mid-character ("https://magicbooklet.c").
// 7. On a desktop the legal pages were titled "Workspace", /ai-workflow-builder "Workflow Canvas",
//    and the section line under a title was cut mid-word ("…and workflo…").
// 8. /pricing: the currency capsule grew as "Updating FX..." and then the rates' date came into it,
//    from 92px at the first paint to 307px (the sweep saw 173px to 305px), and only its 50 × 19
//    select opened the picker.

const COLD_PAGE = { timeout: 45_000 };
const PHONE_WIDTHS = [320, 375, 414];

test.describe.configure({ timeout: 240_000 });

/** React has committed the document's hydration (as login-typed-before-script.spec.ts reads it). */
async function hydrated(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    type HostRoot = { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } };
    const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
    const root = key ? (document as unknown as Record<string, HostRoot>)[key] : undefined;
    return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
  }).catch(() => false), COLD_PAGE).toBe(true);
}

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'load', ...COLD_PAGE });
  await hydrated(page);
  await page.evaluate(() => document.fonts.ready);
}

/** How far the document scrolls sideways. */
function pageOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

type DrawnText = { text: string; inSight: boolean; where: string };

/**
 * The text drawn under each element `roots` finds, one list per element: each piece with whether it
 * is wholly in sight across, inside the window and inside every box that clips or scrolls it. Text
 * wholly out of a scroll box is out of sight too (the cost columns /models scrolled out of view),
 * which the sweep's own check left out. Its words are measured, not the whole text: a space is not
 * drawn, and a wrapped line's last space may hang past its box.
 */
function drawnText(roots: Locator) {
  return roots.evaluateAll((elements) => elements.map((root) => {
    const out: DrawnText[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue?.trim();
      const element = node.parentElement;
      if (!text || !element || element.closest('.sr-only, script, style, select')) continue;
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const rects: DOMRect[] = [];
      for (const word of node.nodeValue!.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, word.index!);
        range.setEnd(node, word.index! + word[0].length);
        rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0));
      }
      if (rects.length === 0) continue;
      const left = Math.min(...rects.map((rect) => rect.left));
      const right = Math.max(...rects.map((rect) => rect.right));
      let shownLeft = 0;
      let shownRight = document.documentElement.clientWidth;
      for (let box = element; box && box !== document.body; box = box.parentElement!) {
        if (getComputedStyle(box).overflowX === 'visible') continue;
        const frame = box.getBoundingClientRect();
        shownLeft = Math.max(shownLeft, frame.left + box.clientLeft);
        shownRight = Math.min(shownRight, frame.left + box.clientLeft + box.clientWidth);
      }
      out.push({
        text,
        inSight: left >= shownLeft - 0.5 && right <= shownRight + 0.5,
        where: `spans ${Math.round(left)}-${Math.round(right)}px, in sight ${Math.round(shownLeft)}-${Math.round(shownRight)}px`,
      });
    }
    return out;
  }));
}

/** Every piece of text in the page's `main` that is drawn but not wholly in sight. */
async function textOutOfSight(page: Page) {
  const [main] = await drawnText(page.locator('main'));
  expect(main, 'the page has a main').toBeDefined();
  return main.filter((piece) => !piece.inSight).map((piece) => `"${piece.text.slice(0, 48)}" ${piece.where}`);
}

/**
 * What each body row of the page's tables shows in sight, one string per row; only the tables with a
 * column headed `header`, when one is named.
 */
async function rowsInSight(page: Page, header?: string) {
  const tables = page.locator('main table');
  const named = header ? tables.filter({ has: page.getByRole('columnheader', { name: header, exact: true }) }) : tables;
  const rows = await drawnText(named.locator('tbody tr'));
  return rows.map((row) => row.filter((piece) => piece.inSight).map((piece) => piece.text).join(' '));
}

test.describe('the MCP pages on a phone', () => {
  for (const path of ['/developers/mcp/posting', '/developers/mcp']) {
    for (const width of PHONE_WIDTHS) {
      test(`${path} at ${width}px: no sideways scroll, the bottom bar on the screen, every code value whole`, async ({ page }) => {
        await page.setViewportSize({ width, height: 812 });
        await open(page, path);
        expect(await pageOverflow(page), 'the page scrolls sideways by').toBe(0);
        const bar = await page.locator('nav.app-shell-bottom-nav').boundingBox();
        expect(bar, 'the bottom bar is drawn').not.toBeNull();
        expect(bar!.x + bar!.width).toBeLessThanOrEqual(width);
        // Each value a person copies reads whole where it is drawn, none past its box's edge.
        const codes = page.locator('main pre[role="region"]');
        expect(await codes.count()).toBeGreaterThan(0);
        const cut = await codes.evaluateAll((boxes) => boxes
          .filter((box) => box.scrollWidth > box.clientWidth)
          .map((box) => `${box.getAttribute('aria-label')}: ${box.scrollWidth}px of text in ${box.clientWidth}px`));
        expect(cut).toEqual([]);
        expect(await textOutOfSight(page)).toEqual([]);
      });
    }
  }

  test('/developers/mcp on a desktop: the long commands read whole too', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, '/developers/mcp');
    const cut = await page.locator('main pre[role="region"]').evaluateAll((boxes) => boxes
      .filter((box) => box.scrollWidth > box.clientWidth)
      .map((box) => `${box.getAttribute('aria-label')}: ${box.scrollWidth}px of text in ${box.clientWidth}px`));
    expect(cut).toEqual([]);
    expect(await textOutOfSight(page)).toEqual([]);
  });
});

test.describe('/models on a phone', () => {
  for (const width of PHONE_WIDTHS) {
    test(`at ${width}px every model shows its cost per run, and nothing is cut`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      await open(page, '/models');
      expect(await pageOverflow(page), 'the page scrolls sideways by').toBe(0);
      const rows = await rowsInSight(page);
      // The code catalog's models, each one row: video, image and motion.
      expect(rows.length).toBeGreaterThan(20);
      const missing = rows.filter((row) => !(
        /\d[\d,]* credits?|—/.test(row) && /₹[\d,]+\.\d\d|—/.test(row) && /\$[\d,]+\.\d\d|—/.test(row)
      ));
      expect(missing, 'rows that show no cost in sight').toEqual([]);
      expect(await textOutOfSight(page)).toEqual([]);
    });
  }

  test('a desktop keeps the four columns', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, '/models');
    const headers = page.locator('main table').first().locator('thead th');
    await expect(headers.filter({ visible: true })).toHaveText(['Model', 'Credits', '₹ per run', '$ per run']);
    expect(await textOutOfSight(page)).toEqual([]);
  });
});

test.describe('a model page on a phone', () => {
  // The two the sweep read, and the motion model its trial read, which has a settings table.
  for (const slug of ['seedance-2-mini', 'grok-imagine-video', 'kling-2-6']) {
    for (const width of PHONE_WIDTHS) {
      test(`/models/${slug} at ${width}px shows every column of its tables`, async ({ page }) => {
        await page.setViewportSize({ width, height: 812 });
        await open(page, `/models/${slug}`);
        expect(await pageOverflow(page), 'the page scrolls sideways by').toBe(0);
        const tables = page.locator('main table');
        expect(await tables.count()).toBeGreaterThan(0);
        for (const header of ['Generations', 'Approx. cost']) {
          await expect(page.locator('main th', { hasText: header })).toBeVisible();
        }
        const scaleRows = await rowsInSight(page, 'Approx. cost');
        expect(scaleRows).toHaveLength(3);
        for (const row of scaleRows) expect(row).toMatch(/^\d+ [\d,]+ ₹ ?[\d,]+$/);
        expect(await textOutOfSight(page)).toEqual([]);
      });
    }
  }

  // Every model the code catalog holds, at the narrowest phone: no table hides a column of its own.
  test('every model page at 320px keeps its settings and costs in sight', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 812 });
    await open(page, '/models');
    const slugs = await page.locator('main table a[href^="/models/"]').evaluateAll((links) => (
      [...new Set(links.map((link) => link.getAttribute('href')!))]
    ));
    expect(slugs.length).toBeGreaterThan(20);
    const problems: string[] = [];
    let settingsTables = 0;
    for (const href of slugs) {
      await page.goto(href, { waitUntil: 'load', ...COLD_PAGE });
      await page.evaluate(() => document.fonts.ready);
      const overflow = await pageOverflow(page);
      if (overflow > 0) problems.push(`${href}: the page scrolls sideways by ${overflow}px`);
      problems.push(...(await textOutOfSight(page)).map((line) => `${href}: ${line}`));
      if (await page.locator('main th', { hasText: 'Default' }).count()) {
        settingsTables += 1;
        // Each setting's default is drawn in sight, a dash where it has none.
        const settings = await rowsInSight(page, 'Default');
        for (const row of settings) if (row.split(' ').length < 3) problems.push(`${href}: a setting row shows only "${row}"`);
      }
    }
    expect(problems).toEqual([]);
    expect(settingsTables).toBeGreaterThan(10);
  });
});

test.describe('Marketplace on a phone, once the full client has taken over', () => {
  for (const width of PHONE_WIDTHS) {
    test(`at ${width}px the open filters fit the screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      // Offline the list API cannot answer; the server draws the first page from the stub's fixture.
      await page.context().route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
      await page.goto('/marketplace', { waitUntil: 'domcontentloaded', ...COLD_PAGE });
      await page.locator('[data-marketplace-bootstrap-shell]').waitFor(COLD_PAGE);
      // Scrolled towards its end, the first-paint shell hands the list to the full client.
      await page.mouse.move(width / 2, 400);
      await expect(async () => {
        await page.mouse.wheel(0, 2000);
        await expect(page.locator('[data-marketplace-bootstrap-shell]')).toHaveCount(0, { timeout: 1000 });
      }).toPass(COLD_PAGE);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      const filters = page.getByRole('button', { name: /^Filters/ });
      await filters.click();
      await expect(filters).toHaveAttribute('aria-expanded', 'true');
      const panel = page.locator('#marketplace-filters');
      await expect(panel.getByText('Kind', { exact: true })).toBeVisible();
      const box = await panel.boundingBox();
      expect(box!.x + box!.width, 'the filters reach past the right edge to').toBeLessThanOrEqual(width);
      expect(await pageOverflow(page), 'the page scrolls sideways by').toBe(0);
    });
  }
});

test.describe('/blog', () => {
  test('each post card is a link Chrome names by the post title, inside an article with that heading', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, '/blog');
    const titles = await page.locator('main article h2').allTextContents();
    expect(titles.length).toBeGreaterThan(0);

    // The names Chrome itself gives the links, as the sweep read them (its accessibility tree).
    const cdp = await page.context().newCDPSession(page);
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'main a[href^="/blog/"]' });
    const names: string[] = [];
    for (const nodeId of nodeIds) {
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      names.push(String(nodes[0]?.name?.value ?? ''));
    }
    await cdp.detach();
    expect(names).toEqual(titles);

    // Each card is an article named by its heading, and a press anywhere on it opens the post.
    for (const title of titles) {
      const card = page.getByRole('article').filter({ has: page.getByRole('heading', { level: 2, name: title }) });
      await expect(card).toHaveCount(1);
      const link = card.getByRole('link', { name: title, exact: true });
      await expect(link).toHaveCount(1);
      const misses = await card.evaluate((article, href) => {
        // Points are read in the window: the card is brought into it first.
        article.scrollIntoView({ block: 'center', behavior: 'instant' });
        const box = article.getBoundingClientRect();
        const out: string[] = [];
        for (const fx of [0.03, 0.5, 0.97]) {
          for (const fy of [0.08, 0.5, 0.92]) {
            const x = box.left + box.width * fx;
            const y = box.top + box.height * fy;
            const hit = document.elementFromPoint(x, y)?.closest('a');
            if (hit?.getAttribute('href') !== href) out.push(`(${fx}, ${fy}): ${hit?.getAttribute('href') ?? 'no link'}`);
          }
        }
        return out;
      }, await link.getAttribute('href'));
      expect(misses, title).toEqual([]);
    }
  });
});

/** The top bar's title, and its section line cut inside a word where it is cut at all. */
function readTopBar(page: Page) {
  return page.evaluate(() => {
    const title = document.querySelector('header.app-shell-header [data-app-shell-title] span:not([aria-hidden])');
    const line = title?.closest('[data-app-shell-title]')?.nextElementSibling as HTMLElement | null | undefined;
    const lineShown = Boolean(line && line.getClientRects().length > 0);
    const cutInsideWord: string[] = [];
    if (line && lineShown) {
      const frame = line.getBoundingClientRect();
      const edge = frame.left + line.clientLeft + line.clientWidth;
      const ellipsis = getComputedStyle(line).textOverflow === 'ellipsis';
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        // A copy for screen readers alone is not drawn.
        if (node.parentElement?.closest('.sr-only')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (!(rect.left < edge - 0.5 && rect.right > edge + 0.5)) continue;
        // Text across the edge is cut there, unless it is a word drawn as an atomic inline, which a
        // line's ellipsis hides whole (CSS Overflow 3: "hide characters and atomic inline-level
        // elements at the end edge of the line as necessary to fit the ellipsis").
        const atomic = getComputedStyle(node.parentElement!).display === 'inline-block';
        if (!(ellipsis && atomic)) cutInsideWord.push(node.nodeValue!.trim());
      }
    }
    const lineText = (line?.querySelector('.sr-only') ?? line)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    return { title: title?.textContent?.trim() ?? null, line: lineText, lineShown, cutInsideWord };
  });
}

test.describe('the top bar on a desktop', () => {
  const TITLED: Record<string, string> = {
    '/cancellation': 'Cancellation',
    '/privacy': 'Privacy',
    '/terms': 'Terms',
    '/delete-account': 'Delete account',
    '/ai-workflow-builder': 'AI workflow builder',
  };
  test('names the legal pages and the workflow builder\'s landing for what they are', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [path, title] of Object.entries(TITLED)) {
      await open(page, path);
      expect((await readTopBar(page)).title, path).toBe(title);
    }
  });

  // Pages a visitor sees with a section line (the canvas itself asks a visitor to sign in first),
  // each read at the widths that draw the line, from 1024px, where it has the least room.
  for (const path of ['/ai-workflow-builder', '/create-image', '/create-video']) {
    test(`${path}: the section line is never cut inside a word`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, path);
      const cut: string[] = [];
      const widths = [1024, 1180, 1280, 1440];
      let shown = 0;
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        const read = await readTopBar(page);
        expect(read.line, `${path} has a section line at ${width}px`).toBeTruthy();
        if (read.lineShown) shown += 1;
        cut.push(...read.cutInsideWord.map((word) => `${width}px: "${word}"`));
      }
      expect(shown).toBe(widths.length);
      expect(cut).toEqual([]);
    });
  }
});

test.describe('/pricing currency', () => {
  const FX = { base: 'INR', rates: { USD: 0.012, EUR: 0.011, GBP: 0.0095 }, updatedAt: 'Fri, 06 Nov 2026 00:02:31 +0000' };
  const FX_LINE = 'Rates updated Nov 6, 2026, 12:02 AM';
  test.use({ locale: 'en-US', timezoneId: 'UTC' });

  for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 900 }]) {
    test(`at ${viewport.width}px the currency box keeps its size from the first paint, and all of it opens the picker`, async ({ page }) => {
      await page.setViewportSize(viewport);
      // The rates come a second after the page asks, so "Updating" has its moment.
      await page.route('**/api/fx', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await route.fulfill({ json: FX });
      });
      // The page's own chunk is held, so the server's HTML can be measured before the script runs.
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route(/\/_next\/static\/chunks\/app\/pricing\/page\.js(\?|$)/, async (route) => {
        await gate;
        await route.continue();
      });
      const select = page.locator('#pricing-currency');
      const read = () => select.evaluate((field: HTMLElement) => {
        // The bordered box drawn around the select: the select itself, or the box that holds it.
        let box = field;
        for (let at: HTMLElement | null = field; at; at = at.parentElement) {
          if (parseFloat(getComputedStyle(at).borderTopWidth) > 0) { box = at; break; }
        }
        const frame = box.getBoundingClientRect();
        // The points of the box that are not the select's: a press there does not open the picker.
        const misses: string[] = [];
        for (const fx of [0.06, 0.25, 0.5, 0.75, 0.94]) {
          for (const fy of [0.2, 0.5, 0.8]) {
            const hit = document.elementFromPoint(frame.left + frame.width * fx, frame.top + frame.height * fy);
            if (hit !== field) misses.push(`(${fx}, ${fy}) of ${Math.round(frame.width)}x${Math.round(frame.height)}: ${hit?.tagName.toLowerCase() ?? 'nothing'}`);
          }
        }
        // What follows the heading's block, which nothing above may push down.
        const next = document.querySelector('main h1')?.parentElement?.nextElementSibling;
        return {
          box: { x: Math.round(frame.x), y: Math.round(frame.y), width: Math.round(frame.width), height: Math.round(frame.height) },
          nextTop: next ? Math.round(next.getBoundingClientRect().top + window.scrollY) : null,
          misses,
        };
      });

      await page.goto('/pricing', { waitUntil: 'commit' });
      await expect(select).toBeVisible(COLD_PAGE);
      // The heading's block rises in (`ui-enter`, a transform, which moves nothing in the layout):
      // read once it stands. Not `document.fonts.ready`, which waits for the document's load, and so
      // for the held chunk; the page draws in the system face.
      await page.waitForFunction(() => document.getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .every((animation) => animation.playState !== 'running'));
      const firstPaint = await read();
      release();
      await expect(page.getByText('Updating FX...', { exact: true })).toBeVisible(COLD_PAGE);
      const updating = await read();
      await expect(page.getByText(FX_LINE, { exact: true })).toBeVisible(COLD_PAGE);
      const settled = await read();
      expect(updating).toEqual(firstPaint);
      expect(settled).toEqual(firstPaint);
      expect(settled.misses).toEqual([]);
      expect(settled.box.height, 'a press target of at least 24px').toBeGreaterThanOrEqual(24);

      // It still prices the packs in the currency picked.
      await select.selectOption('EUR');
      await expect(page.locator('h2', { hasText: 'Starter' }).locator('xpath=../following-sibling::div[1]')).toContainText('EUR');
    });
  }
});
