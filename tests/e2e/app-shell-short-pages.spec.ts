import { expect, test, type Locator, type Page } from '@playwright/test';

// A short page is no taller than the window. Page roots fill the window with
// `min-h-screen` or `.ui-page` (100vh), but inside the app shell a root sits
// under the sticky top bar and, below 768px, above the bottom navigation's
// room. So every short page was one bar taller than the window (165px at 390px,
// with the room), and a trackpad nudge or Space moved its top under the bar
// over nothing. The bar itself came to 65px, or 67px with the search field,
// against its 64px token. Now the bar is exactly the token, and the shell gives
// a page root what it leaves of the window (`.app-shell-content .ui-page` and
// `.app-shell-content > .min-h-screen` in globals.css).

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

type Fit = {
  maxScroll: number;
  bar: number;
  token: number;
  rootBottom: number;
  roomBottom: number;
  innerBottom: number | null;
};

function readFit(page: Page, inner?: string): Promise<Fit> {
  return page.evaluate((innerSelector) => {
    const html = document.documentElement;
    const main = document.getElementById('main-content')!;
    const root = [...main.children].find((element) => getComputedStyle(element).display !== 'none')!;
    const innerElement = innerSelector ? document.querySelector(innerSelector) : null;
    // The token in pixels: it is 4rem, so it follows the root's font size.
    const tokenProbe = document.createElement('div');
    tokenProbe.style.cssText = 'position: absolute; visibility: hidden; height: var(--app-shell-topbar-height)';
    document.body.append(tokenProbe);
    const token = tokenProbe.getBoundingClientRect().height;
    tokenProbe.remove();
    return {
      maxScroll: html.scrollHeight - html.clientHeight,
      bar: document.querySelector('header.app-shell-header')!.getBoundingClientRect().height,
      token,
      // Where the page's background ends, and where the window ends less the
      // bottom navigation's room (main's padding below 768px, none above).
      rootBottom: root.getBoundingClientRect().bottom + window.scrollY,
      roomBottom: html.clientHeight - parseFloat(getComputedStyle(main).paddingBottom),
      innerBottom: innerElement ? innerElement.getBoundingClientRect().bottom + window.scrollY : null,
    };
  }, inner);
}

// Soft, so that a failure lists every width at once. `inner` names an element
// that must end where the page's root ends.
async function expectFitsAtEveryWidth(page: Page, inner?: { selector: string; name: string }) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const fit = await readFit(page, inner?.selector);
    expect.soft(fit.bar, `the top bar is its token at ${viewport.width}px`).toBe(fit.token);
    expect.soft(fit.maxScroll, `the page scrolls at ${viewport.width}px`).toBe(0);
    expect.soft(fit.rootBottom, `the page's background stops short of the window at ${viewport.width}px`)
      .toBeCloseTo(fit.roomBottom, 0);
    if (inner) {
      expect.soft(fit.innerBottom, `${inner.name} ends at the root's bottom at ${viewport.width}px`)
        .toBeCloseTo(fit.rootBottom, 0);
    }
  }
}

// On screen, and what the browser draws at its centre is the element itself,
// not the bottom navigation over it.
async function expectClearOfTheBottomNav(locator: Locator, name: string) {
  await expect(locator, `${name} is on screen`).toBeInViewport({ ratio: 1 });
  const drawnOnTop = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return Boolean(hit && element.contains(hit));
  });
  expect(drawnOnTop, `nothing covers ${name}`).toBe(true);
}

// Something else is drawn at the centre of every bottom-nav link and at the nav's two
// ends: an overlay that covers the page covers the nav too. `next dev` draws its own
// badge over the bottom-left corner, which is skipped. Soft, so that a failure lists
// every overlay the nav shows over.
async function expectOverTheBottomNav(page: Page, name: string) {
  const showing = await page.evaluate(() => {
    const nav = document.querySelector('nav.app-shell-bottom-nav')!;
    const box = nav.getBoundingClientRect();
    const points = [...nav.querySelectorAll('a')].map((link) => {
      const r = link.getBoundingClientRect();
      return { name: link.getAttribute('aria-label') || link.textContent?.trim() || '', x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    points.push(
      { name: 'its left end', x: box.left + 6, y: box.top + box.height / 2 },
      { name: 'its right end', x: box.right - 6, y: box.top + box.height / 2 },
    );
    return points.filter(({ x, y }) => {
      const hit = document.elementsFromPoint(x, y).find((element) => !element.closest('nextjs-portal'));
      return Boolean(hit && nav.contains(hit));
    }).map((point) => point.name);
  });
  expect.soft(showing, `the bottom navigation shows over ${name} at`).toEqual([]);
}

// A point near (fx, fy) of the pane's part in the window where the pane itself is
// drawn: from there toward the pane's centre until no panel, control or minimap is
// over it. In whole pixels: the browser reports a right-click's clientX/Y in whole
// pixels and the menu is placed from those, so a fractional point here (the walk's,
// whenever it runs) missed the menu's edge by its fraction.
function panePoint(page: Page, fx: number, fy: number) {
  return page.evaluate(([fractionX, fractionY]) => {
    const pane = document.querySelector('.react-flow__pane')!;
    const r = pane.getBoundingClientRect();
    const left = Math.max(r.left, 0) + 2;
    const right = Math.min(r.right, window.innerWidth) - 2;
    const top = Math.max(r.top, 0) + 2;
    const bottom = Math.min(r.bottom, window.innerHeight) - 2;
    const from = { x: left + (right - left) * fractionX, y: top + (bottom - top) * fractionY };
    const centre = { x: (left + right) / 2, y: (top + bottom) / 2 };
    for (let t = 0; t <= 1; t += 0.01) {
      const x = Math.round(from.x + (centre.x - from.x) * t);
      const y = Math.round(from.y + (centre.y - from.y) * t);
      if (document.elementFromPoint(x, y) === pane) return { x, y };
    }
    return null;
  }, [fx, fy] as const);
}

type CanvasNode = { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> };

// A canvas answered from memory: its list, its record, and nothing saved.
async function openCanvas(page: Page, nodes: CanvasNode[] = []) {
  const canvas = {
    id: 'canvas-1',
    title: 'Workflow canvas',
    updated_at: '2026-03-30T04:00:00.000Z',
    revision: 0,
    graph: { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes, edges: [] },
  };
  await page.route('**/api/workflow-canvases', (route) => route.fulfill({
    json: { canvases: [{ id: canvas.id, title: canvas.title, updated_at: canvas.updated_at, revision: canvas.revision }] },
  }));
  await page.route('**/api/workflow-canvases/*', (route) => (
    route.request().method() === 'GET' ? route.fulfill({ json: { canvas } }) : route.abort()
  ));
  await page.goto(`/create-workflow?canvas=${canvas.id}`);
  await expect(page.getByTestId('workflow-canvas-header')).toBeVisible();
  return canvas;
}

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
});

test.describe('a short page in the app shell', () => {
  test('Alerts, short at every width, does not scroll', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { level: 1, name: 'Alerts' })).toBeVisible();
    await expectFitsAtEveryWidth(page);
  });

  // Each page is emptied, so that it is short at every width whatever it shows.
  // Alerts' root is `.ui-page` (its own `min-h-[calc(100dvh-64px)]` always lost to
  // `.ui-page`'s rule, and went in October 2026), Search's is `min-h-screen`; both
  // routes add non-public-utilities.css. Contact is styled by globals.css alone. The
  // workflow library's root was sized by hand (`min-h-[calc(100vh-4rem)]`),
  // which the shell's rule passed by, so below 768px it left the page the
  // room taller than the window.
  for (const { route, heading, root } of [
    { route: '/notifications', heading: 'Alerts', root: /(^|\s)ui-page(\s|$)/ },
    { route: '/search', heading: 'Search the creator community', root: /(^|\s)min-h-screen(\s|$)/ },
    { route: '/contact', heading: 'Get in Touch', root: /(^|\s)ui-page(\s|$)/ },
    { route: '/create-workflow', heading: 'Your creation systems, at a glance.', root: /(^|\s)min-h-screen(\s|$)/ },
  ]) {
    test(`${route} emptied is no taller than the window`, async ({ page }) => {
      await page.setViewportSize(VIEWPORTS[0]);
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.locator('#main-content > div').first()).toHaveClass(root);
      await page.addStyleTag({ content: '#main-content > * > * { display: none !important; }' });
      await expectFitsAtEveryWidth(page);
    });
  }

  // At a larger browser text size the bar's 3rem controls outgrow 64px. The bar grew
  // round them, to 73px (75px with the search field) at 24px, past a token of 64px,
  // and every short page was 9-11px taller than the window. The token is 4rem, which
  // the bar is at every text size. `html { font-size: 24px }` stands in for Chrome's
  // "Very large" text, which sets the root's font size the same way.
  test('Alerts emptied, at a larger text size, is no taller than the window', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { level: 1, name: 'Alerts' })).toBeVisible();
    await page.addStyleTag({ content: 'html { font-size: 24px; } #main-content > * > * { display: none !important; }' });
    await expectFitsAtEveryWidth(page);
  });

  // An address with no page, and a page that calls notFound() with no not-found
  // of its own (a comparison's), draw the app's not-found. Next's default one
  // sets `height: 100vh` inline, which no sheet rule overrides, so it overflowed
  // by the bar and the room (164px at 390px, 64px wider). The comparison's
  // metadata names it "Comparison Not Found"; the not-found's own title wins.
  for (const route of ['/no-page-at-this-address', '/alternatives/no-comparison-at-this-address']) {
    test(`${route} is a 404 no taller than the window`, async ({ page }) => {
      await page.setViewportSize(VIEWPORTS[0]);
      const response = await page.goto(route);
      expect(response?.status()).toBe(404);
      // Any heading first: Next's own page has another, and fails on its band.
      await expect(page.locator('#main-content h1')).toBeVisible();
      await expectFitsAtEveryWidth(page);
      await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
      // Read once, now that the browser has drawn the page and its head.
      expect(await page.title()).toMatch(/^Page not found \| /);
    });
  }
});

// The workflow canvas is an editor of a fixed height that never scrolls the
// page: `h-screen`, which the shell gives what it leaves (`.app-shell-content
// > .h-screen`). Sized by hand as 100vh less the bar, it ended at the window's
// bottom, under the bottom navigation, and the page scrolled by the room.
test.describe('the workflow pages in the app shell', () => {
  test('the workflow library\'s loading fallback is no taller than the window', async ({ page }) => {
    // The library's chunk is never answered, so next/dynamic's fallback stays.
    // The page is read once it commits, as a script still in flight would hold
    // its load event back for good.
    const held: string[] = [];
    await page.route(/WorkflowLibraryClient/, (route) => {
      held.push(route.request().url());
    });
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto('/create-workflow', { waitUntil: 'commit' });
    await expect(page.locator('#main-content > div > svg.animate-spin')).toBeVisible();
    await expect.poll(() => held.length, { message: 'the library chunk is asked for and held' }).toBeGreaterThan(0);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
      .every((link) => link.sheet));
    await expectFitsAtEveryWidth(page);
  });

  test('the workflow canvas fills what the shell leaves and never scrolls the page', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await openCanvas(page);
    // A height, not a minimum: the editor's work area reaches its bottom.
    await expectFitsAtEveryWidth(page, { selector: '[role="application"]', name: 'the work area' });
    // An editor that does not fit has nothing to press below: stop here.
    expect(test.info().errors, 'the editor fits at every width').toHaveLength(0);

    // Below 768px its phone controls clear the bottom navigation: the node
    // library's opener, and the AI Builder's submit row once its popup is
    // scrolled down (from its title, outside the popup's message list).
    await page.setViewportSize(VIEWPORTS[0]);
    await expectClearOfTheBottomNav(page.getByRole('button', { name: 'Open node library' }), 'the node library opener');
    await page.getByTestId('workflow-assistant-trigger').click({ timeout: 10_000 });
    const popup = page.getByTestId('workflow-assistant-popup');
    await popup.getByText('AI Builder', { exact: true }).hover({ timeout: 10_000 });
    await page.mouse.wheel(0, 2000);
    await expectClearOfTheBottomNav(
      popup.getByRole('button', { name: /^(Build proposal|Setup required)$/ }),
      'the AI Builder submit row',
    );

    // On a window too short to leave the editor 20rem (a phone held sideways,
    // its URL bar showing) the editor keeps 20rem and the page scrolls instead.
    await page.setViewportSize({ width: 740, height: 304 });
    const workArea = await page.getByRole('application').boundingBox();
    expect(workArea?.height, 'the work area on a short window').toBeGreaterThan(150);
  });

  // The editor is sized from the bar's token too (the larger-text case above).
  test('the workflow canvas, at a larger text size, still fills what the shell leaves', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await openCanvas(page);
    await page.addStyleTag({ content: 'html { font-size: 24px; }' });
    await expectFitsAtEveryWidth(page, { selector: '[role="application"]', name: 'the work area' });
  });

  // The AI Builder's column runs the canvas's full height on its right, as wide as its
  // trigger row, which grows with the text. It took every tap it covered, so the phone
  // node library's opener, centred along the bottom, lost its right end on a 360px or
  // 390px phone at the default text size and its centre at a larger one, where pressing
  // it did nothing. Only what the column draws takes the pointer now.
  test('the node library opener can be pressed along its length at every text size', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openCanvas(page);
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    const textSize = await page.addStyleTag({ content: '/* the root font size, set below */' });
    const opener = page.getByRole('button', { name: /^Open (node library|nodes and workflows)$/ });
    const library = page.getByRole('dialog', { name: 'Build your graph' });
    for (const width of [360, 390]) {
      for (const text of [16, 20, 24]) {
        const where = `at ${width}px, ${text}px text`;
        await page.setViewportSize({ width, height: 800 });
        await textSize.evaluate((style, px) => { style.textContent = `html { font-size: ${px}px; }`; }, text);
        await expect(opener, `the opener is on screen ${where}`).toBeInViewport({ ratio: 1 });
        // Seven points along its middle, from one rounded end to the other.
        const covered = await opener.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const y = box.top + box.height / 2;
          return Array.from({ length: 7 }, (_, i) => box.left + box.height / 2 + ((box.width - box.height) * i) / 6)
            .flatMap((x) => {
              const hit = document.elementsFromPoint(x, y).find((candidate) => !candidate.closest('nextjs-portal'));
              return hit && element.contains(hit) ? [] : [`${Math.round(x)}px: ${hit?.className ?? 'nothing'}`];
            });
        });
        expect.soft(covered, `what is drawn over the opener ${where}`).toEqual([]);
        const box = (await opener.boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect.soft(library, `a press at its centre opens the library ${where}`).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(library).toBeHidden();
      }
    }
  });

  // Below 768px the bottom navigation (z-60) floats over the page. The canvas's
  // dialogs and its media preview were z-50, so the nav's links stayed on top of
  // them, live, and over the preview's bottom 40px at 390x844; the phone node
  // library's backdrop was z-60, so the nav's right end showed past the drawer. And
  // the unsaved-changes dialog that Import raises sat under the import dialog, where
  // none of its buttons could be pressed.
  test('the canvas\'s dialogs, preview and node library are drawn over the bottom navigation', async ({ page }) => {
    const shareId = '11111111-1111-4111-8111-111111111111';
    const share = {
      id: shareId,
      title: 'Shared workflow',
      nodeCount: 1,
      edgeCount: 0,
      importCount: 0,
      createdAt: '2026-03-30T04:00:00.000Z',
      importPath: `/create-workflow?import=${shareId}`,
      importUrl: `http://127.0.0.1:3100/create-workflow?import=${shareId}`,
    };
    // A tall portrait, so the preview is as tall as it gets (76vh).
    await page.route('**/e2e-canvas-preview.svg', (route) => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1800"><rect width="600" height="1800" fill="#3b4a5a"/></svg>',
    }));
    await page.route('**/api/workflow-canvases/*/share', (route) => route.fulfill({ json: { share } }));
    await page.route('**/api/workflow-shares/*', (route) => route.fulfill({
      json: { share: { ...share, graph: { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }, sourceCanvasId: null, sourceRevision: 0 } },
    }));
    await page.setViewportSize(VIEWPORTS[0]);
    await openCanvas(page, [{
      id: 'image-input-1',
      type: 'image-input',
      position: { x: 0, y: 0 },
      data: {
        title: 'Image input',
        subtitle: 'Upload or connect image',
        imageUrl: '/e2e-canvas-preview.svg',
        storagePath: null,
        runState: { status: 'idle', generationId: null, outputUrl: null, error: null, cost: null, updatedAt: null },
      },
    }]);

    await page.getByRole('button', { name: 'Open image input preview' }).click();
    await expect(page.getByText('Press Escape to close')).toBeVisible();
    await expectOverTheBottomNav(page, 'the media preview');
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // Its link, or the save it asks for first failing (nothing is saved here).
    await page.getByRole('button', { name: 'Share workflow' }).click();
    await expect(page.getByTestId('workflow-share-dialog')).toBeVisible();
    await expect(page.getByText('Creating a fresh snapshot link...')).toBeHidden();
    await expectOverTheBottomNav(page, 'the share dialog');
    // A click on the backdrop closes it.
    await page.mouse.click(8, 8);
    await expect(page.getByTestId('workflow-share-dialog')).toBeHidden();

    await page.getByRole('button', { name: /^Open (node library|nodes and workflows)$/ }).click();
    await expect(page.getByTestId('workflow-left-rail')).toBeVisible();
    await expectOverTheBottomNav(page, 'the node library and its backdrop');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Build your graph' })).toBeHidden();

    // An edit, then Import: the unsaved-changes dialog comes up over the import dialog.
    await page.getByRole('textbox', { name: 'Workflow title' }).fill('Edited workflow canvas');
    await page.getByRole('button', { name: 'Import workflow' }).click();
    const importDialog = page.getByTestId('workflow-import-dialog');
    await expectOverTheBottomNav(page, 'the import dialog');
    await importDialog.getByRole('textbox', { name: 'Shared workflow URL or id' }).fill(shareId);
    await importDialog.getByRole('button', { name: 'Preview import' }).click();
    await expect(importDialog.getByText(share.title, { exact: true })).toBeVisible();
    await importDialog.getByRole('button', { name: 'Import workflow' }).click();
    const unsaved = page.locator('div.max-w-md', { hasText: 'Save before continuing?' });
    await expect(unsaved).toBeVisible();
    for (const name of ['Cancel', 'Discard', 'Save']) {
      await expectClearOfTheBottomNav(unsaved.getByRole('button', { name, exact: true }), `the unsaved-changes dialog's ${name}`);
    }
    await expectOverTheBottomNav(page, 'the unsaved-changes dialog');
    await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(unsaved).toBeHidden();
    await expect(importDialog).toBeVisible();
  });

  // The canvas's context menu never showed: the selection handler the editor gave
  // React Flow closed it in the same commit that drew it, on every right-click. And
  // it was drawn at the pointer, so near the window's right or bottom edge it would
  // have run off the window. It opens on the pointer's other side there, as a native
  // menu does, and on a phone it covers the bottom navigation.
  test('the canvas\'s context menu opens and stays inside the window', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await openCanvas(page);
    const menu = page.getByTestId('canvas-context-menu');
    for (const viewport of [...VIEWPORTS, { width: 740, height: 304 }]) {
      await page.setViewportSize(viewport);
      for (const [where, fx, fy] of [['right edge', 1, 0.5], ['bottom edge', 0.2, 1]] as const) {
        const point = await panePoint(page, fx, fy);
        expect(point, `a point on the pane by its ${where} at ${viewport.width}x${viewport.height}`).not.toBeNull();
        await page.mouse.click(point!.x, point!.y, { button: 'right' });
        await expect(menu, `the menu opened by the pane's ${where} at ${viewport.width}x${viewport.height}`).toBeVisible();
        await expect(menu, `the menu opened by the pane's ${where} at ${viewport.width}x${viewport.height}`).toBeInViewport({ ratio: 1 });
        // It went to the pointer's other side, so this was a case that needed it.
        const box = (await menu.boundingBox())!;
        expect(where === 'right edge' ? box.x + box.width : box.y + box.height, `the menu ends at the pointer (${where})`)
          .toBeCloseTo(where === 'right edge' ? point!.x : point!.y, 0);
        if (viewport.width < 768) await expectOverTheBottomNav(page, 'the context menu');
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
      }
    }
  });
});
