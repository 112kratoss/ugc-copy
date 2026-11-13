import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type Page, type Route } from '@playwright/test';

import suggestFixture from './fixtures/search-suggestions.json';

// The search box's typeahead in a browser: what it offers while a person
// types, with the keys and with the pointer, an answer that comes back late,
// an answer with nothing in it, at a phone's width; and one request through
// the real proxy and the real /api/search/suggest for the headers of its 200.
//
// On the search page the box offers only what changes the query, the recent
// searches the text matches and the completions: the results under it draw the
// creators and the models live. The top bar's field on another page offers
// every kind (the last tests).
//
// The page's requests are answered here (page.route); the last test's is
// answered by the dev server's own route, whose two database calls the
// server's Supabase stub answers (tests/e2e/support/supabase-server-stub.cjs).

const SEARCH_API = (url: URL) => url.pathname === '/api/search';
const SUGGEST_API = (url: URL) => url.pathname === '/api/search/suggest';
const emptyPage = { items: [], nextCursor: null };

// SEARCH_TYPEAHEAD_SHOTS=<dir> keeps a picture of each state, for a person to look at.
const SHOTS = process.env.SEARCH_TYPEAHEAD_SHOTS;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

function searchResponse(query: string, type: string, creatorName = 'Luna Studio') {
  return {
    query,
    normalizedQuery: query,
    type,
    sort: 'top',
    entities: [],
    filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    correctedQuery: { posts: null, recipes: null },
    exact: false,
    creators: {
      items: [{
        id: 'creator-1',
        username: 'luna-studio',
        displayName: creatorName,
        bio: null,
        avatarUrl: null,
        publicPostCount: 3,
        isFollowing: false,
      }],
      nextCursor: null,
    },
    posts: emptyPage,
    recipes: emptyPage,
  };
}

function suggestions(query: string) {
  return {
    query,
    normalizedQuery: query,
    creators: [
      { id: 'workflow-user', username: 'e2e-creator', displayName: 'E2E Creator', avatarUrl: null, isFollowing: true },
      { id: 'creator-2', username: 'lumen', displayName: 'Lumen Works', avatarUrl: null, isFollowing: false },
    ],
    entities: [{ kind: 'model', key: 'luma-ray-2', label: 'Luma Ray 2', postCount: 14, postCountCapped: false }],
    completions: [{ text: 'luminous portrait' }, { text: 'lumen glow' }],
  };
}

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

// As public-search.spec.ts: a dev-server self-reload mid-journey wipes what was typed. The
// config's one worker does not meet it; a run given several does.
test.describe.configure({ retries: 2 });

test.describe('search typeahead', () => {
  let searches: string[];
  let suggests: string[];

  /**
   * Opens /search with a query already searched, so the results on screen say
   * the page's script has run. `recents`: this browser's recent searches, kept
   * before the page loads.
   */
  async function openSearch(page: Page, suggest: (route: Route, query: string) => Promise<void> | void, recents: string[] = []) {
    searches = [];
    suggests = [];
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      searches.push(url.search);
      await route.fulfill(json(searchResponse(url.searchParams.get('q') ?? '', url.searchParams.get('type') ?? 'top')));
    });
    await page.route(SUGGEST_API, async (route) => {
      const query = new URL(route.request().url()).searchParams.get('q') ?? '';
      suggests.push(query);
      await suggest(route, query);
    });
    if (recents.length) {
      await page.addInitScript((kept) => {
        window.localStorage.setItem('magicbooklet:public-search-history:v1', JSON.stringify(kept));
      }, recents);
    }
    await page.goto('/search?q=luna');
    await expect(page.getByText('Luna Studio')).toBeVisible();
    // On arrival the box does not have the focus: nothing was asked.
    expect(suggests).toEqual([]);
  }

  test('offers only the completions over the results, never a creator or a model they draw, and follows the keys', async ({ page }) => {
    await openSearch(page, (route, query) => route.fulfill(json(suggestions(query))));
    const box = page.getByRole('combobox');
    await expect(box).toHaveAttribute('aria-expanded', 'false');

    await box.fill('lum');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });
    await expect(list).toBeVisible();
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    await expect(box).toHaveAttribute('aria-controls', (await list.getAttribute('id')) ?? 'no id');
    // One request, for what the box holds.
    expect(suggests).toEqual(['lum']);

    // The answer offers two creators and a model too; the results under the box draw those.
    await expect(list.getByRole('option')).toHaveText(['luminous portrait', 'lumen glow']);
    await expect(list.getByRole('group')).toHaveCount(1);
    await expect(page.locator('[data-search-typeahead-status]')).toHaveText('2 suggestions');
    await shot(page, 'desktop-list');

    // The arrows move the highlight; the focus stays in the box.
    const options = list.getByRole('option');
    await box.press('ArrowDown');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(box).toHaveAttribute('aria-activedescendant', (await options.nth(0).getAttribute('id')) ?? 'no id');
    await box.press('End');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await box.press('Home');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await box.press('ArrowUp');
    await expect(list.locator('[aria-selected="true"]')).toHaveCount(0);
    await expect(box).toBeFocused();
    await box.press('ArrowUp');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await shot(page, 'desktop-highlight');

    // Escape closes the list and keeps the text.
    await box.press('Escape');
    await expect(list).toBeHidden();
    await expect(box).toHaveValue('lum');
    await expect(box).toBeFocused();

    // Down opens it again, on its first row; Enter on a completion fills the box and searches for it.
    await box.press('ArrowDown');
    await expect(list).toBeVisible();
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await box.press('Enter');
    await expect(box).toHaveValue('luminous portrait');
    await expect.poll(() => searches.some((search) => search.includes('q=luminous+portrait'))).toBe(true);
    await expect(page).toHaveURL(/[?&]q=luminous\+portrait/);
    // The list never stands over a search the person committed, though its own suggestions arrive.
    await expect.poll(() => suggests.includes('luminous portrait')).toBe(true);
    await expect(list).toBeHidden();
    await expect(page.locator('p[role="status"]')).toContainText('1 result for luminous portrait');

    // Enter with nothing highlighted searches what is typed.
    await box.fill('lume');
    await expect(list).toBeVisible();
    await box.press('Enter');
    await expect(list).toBeHidden();
    await expect(box).toHaveValue('lume');
    await expect(page).toHaveURL(/[?&]q=lume(&|$)/);
  });

  test('takes a press on a recent search and on a completion, and draws what a row adds heavier', async ({ page }) => {
    await openSearch(page, (route, query) => route.fulfill(json(suggestions(query))), ['neon harbor', 'glowing lumen', 'Lumen city']);
    const box = page.getByRole('combobox');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });

    // The recent searches the text begins (as a whole or at a word) come
    // first, most recent first, with a clock; then the completions.
    await box.fill('lum');
    await expect(list.getByRole('option')).toHaveText(['glowing lumen', 'Lumen city', 'luminous portrait', 'lumen glow']);
    await expect(list.getByRole('group')).toHaveCount(2);
    await expect(list.locator('[data-typeahead-row]')).toHaveCount(4);
    expect(await list.locator('[data-typeahead-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-typeahead-row'))))
      .toEqual(['recent', 'recent', 'completion', 'completion']);
    // What was typed is drawn plain and what the row adds heavier; the row's name is whole.
    const weights = await list.getByRole('option', { name: 'Search for luminous portrait' }).locator('span.truncate > span')
      .evaluateAll((runs) => runs.map((run) => [run.textContent, getComputedStyle(run).fontWeight]));
    expect(weights).toEqual([['lum', '400'], ['inous portrait', '600']]);
    await shot(page, 'desktop-recents-and-completions');

    // A completion: the box is filled and searched, the press keeping the focus
    // in the box. The completions came with the answer, under the recent
    // searches drawn before it: new rows, which take a press once they have stood.
    await expect(list).not.toHaveAttribute('aria-busy', 'true');
    await list.getByRole('option', { name: 'Search for lumen glow' }).click();
    await expect(box).toHaveValue('lumen glow');
    await expect(box).toBeFocused();
    await expect.poll(() => searches.some((search) => search.includes('q=lumen+glow'))).toBe(true);
    await expect(list).toBeHidden();

    // A recent search: the same. The search just pressed joins the recent ones
    // when its answer lands, which can be after the list for "lum" is drawn:
    // the rows then move, and a moved row takes no press for a moment.
    await box.fill('lum');
    await expect(list.getByRole('option')).toHaveText(['lumen glow', 'glowing lumen', 'Lumen city', 'luminous portrait']);
    await expect(list).not.toHaveAttribute('aria-busy', 'true');
    await list.getByRole('option', { name: 'Search again for glowing lumen' }).click();
    await expect(box).toHaveValue('glowing lumen');
    await expect.poll(() => searches.some((search) => search.includes('q=glowing+lumen'))).toBe(true);
    await expect(page).toHaveURL(/[?&]q=glowing\+lumen/);
    await expect(list).toBeHidden();
  });

  test('offers nothing where the answer holds only creators and models: the results draw them', async ({ page }) => {
    await openSearch(page, (route, query) => route.fulfill(json({ ...suggestions(query), completions: [] })));
    const box = page.getByRole('combobox');
    await box.fill('lum');
    await expect.poll(() => suggests).toEqual(['lum']);
    await expect(page.locator('p[role="status"]')).toContainText('1 result for lum');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(box).toHaveAttribute('aria-expanded', 'false');
    // The creator the answer offered is on the page once: as a result.
    await expect(page.getByText('Luna Studio')).toHaveCount(1);
  });

  test('keeps the rows of the text before on show, busy, until this text’s answer lands, with the results’ region silent meanwhile', async ({ page }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await openSearch(page, async (route, query) => {
      if (query === 'lumi') {
        await held;
        await route.fulfill(json({
          ...suggestions(query),
          creators: [{ id: 'creator-2', username: 'lumen', displayName: 'Lumen Works', avatarUrl: null, isFollowing: false }],
          entities: [],
          completions: [{ text: 'luminous portrait' }],
        }));
        return;
      }
      await route.fulfill(json(suggestions(query)));
    });
    const box = page.getByRole('combobox');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });
    const said = page.locator('[data-search-typeahead-status]');
    const resultsSaid = page.locator('p[role="status"]');

    await box.fill('lum');
    await expect(list.getByRole('option')).toHaveCount(2);
    await expect(said).toHaveText('2 suggestions');
    // The page searches as the box is typed into; its outcome is not said over the list.
    await expect.poll(() => searches.some((search) => search.includes('q=lum&'))).toBe(true);
    await expect(resultsSaid).toHaveText('');

    // The next letter, its answer held: the list never goes. It keeps what it
    // had and says it is busy.
    await box.press('End');
    await box.press('i');
    await expect(box).toHaveValue('lumi');
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('aria-busy', 'true');
    await expect(list.getByRole('option')).toHaveText(['luminous portrait', 'lumen glow']);
    await expect.poll(() => suggests).toEqual(['lum', 'lumi']);
    // Past the pause a count waits for: a stale list is not announced.
    await page.waitForTimeout(900);
    await expect(list).toHaveAttribute('aria-busy', 'true');
    await expect(said).toHaveText('2 suggestions');
    await expect(resultsSaid).toHaveText('');
    await shot(page, 'desktop-stale-list');

    // The highlight is put on a stale row that the answer keeps: it stays on that row.
    await box.press('ArrowDown');
    await expect(list.getByRole('option', { name: 'Search for luminous portrait' })).toHaveAttribute('aria-selected', 'true');
    release();
    await expect(list.getByRole('option')).toHaveText(['luminous portrait']);
    await expect(list).not.toHaveAttribute('aria-busy', 'true');
    await expect(list.getByRole('option', { name: 'Search for luminous portrait' })).toHaveAttribute('aria-selected', 'true');
    await expect(said).toHaveText('1 suggestion');

    // Enter settles the search: the list goes and the results speak.
    await box.press('ArrowUp');
    await expect(list.locator('[aria-selected="true"]')).toHaveCount(0);
    await box.press('Enter');
    await expect(list).toBeHidden();
    await expect(resultsSaid).toContainText('1 result for lumi');
  });

  test('a press an answer re-lays the list under opens the row pressed or nothing, never the row that took its place', async ({ page }) => {
    await page.clock.install();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const never = new Promise<void>(() => {});
    await openSearch(page, async (route, query) => {
      // "luma" is answered when the test says, with a completion the list did
      // not have above the ones it had; "lumax" not while the test runs.
      if (query === 'luma') {
        await held;
        await route.fulfill(json({
          ...suggestions(query),
          completions: [{ text: 'luma dream' }, { text: 'luminous portrait' }, { text: 'lumen glow' }],
        }));
        return;
      }
      if (query === 'lumax') await never;
      await route.fulfill(json(suggestions(query)));
      // A recent search that "lum" and "luma" match and "lumax" does not: the
      // letter x takes it away at once, and the rows under it move up.
    }, ['luma beam']);
    const box = page.getByRole('combobox');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });
    const options = list.getByRole('option');
    const rowUnder = (x: number, y: number) => page.evaluate(
      ([px, py]) => document.elementFromPoint(px, py)?.closest('[role="option"]')?.getAttribute('aria-label') ?? null,
      [x, y],
    );

    await box.fill('lum');
    await expect(options).toHaveCount(3);
    // The next letter, its answer held: every row is still offered for "luma", and stands where it stood.
    await box.press('End');
    await box.press('a');
    await expect(box).toHaveValue('luma');
    await expect(options).toHaveText(['luma beam', 'luminous portrait', 'lumen glow']);

    // The pointer goes down on "luminous portrait"; the answer lands before it
    // comes up and puts "luma dream" where it stood, in the same group. The
    // pointer comes up only once the list has settled, so the quarter second
    // below is not what refuses the press: a row is its own element wherever
    // it stands (keyed by what it is, not by its place), and a press that goes
    // down on one element and comes up on another is no click on either.
    // Keyed by place, the element under the pointer would have become "luma
    // dream"'s row, and the press its click.
    const frame = (await list.getByRole('option', { name: 'Search for luminous portrait' }).boundingBox())!;
    const x = frame.x + frame.width / 2;
    const y = frame.y + frame.height / 2;
    await page.mouse.move(x, y);
    expect(await rowUnder(x, y)).toBe('Search for luminous portrait');
    await page.mouse.down();
    release();
    await expect(options).toHaveCount(4);
    expect(await rowUnder(x, y)).toBe('Search for luma dream');
    await expect(list).not.toHaveAttribute('aria-busy', 'true');
    await page.mouse.up();
    // Nothing opened: not the row that took the place, and not the row pressed.
    await expect(box).toHaveValue('luma');
    await expect(list).toBeVisible();
    expect(searches.some((search) => /q=luma\+dream|q=luminous/.test(search))).toBe(false);
    await page.mouse.move(0, 0);

    // A press that only begins after the rows have moved, before a person
    // could have seen them move. Time stands still from here, so "just after"
    // is exact: the letter takes the recent search away, and the completions
    // move up, "luma dream" into its place.
    await page.clock.pauseAt(new Date(Date.now() + 5_000));
    await box.press('End');
    await box.press('x');
    await expect(box).toHaveValue('lumax');
    await expect(options).toHaveText(['luma dream', 'luminous portrait', 'lumen glow']);
    // What a sighted person has of it: the rows that moved are dimmed.
    const moved = list.getByRole('option', { name: 'Search for luminous portrait' });
    await expect(moved).toHaveCSS('opacity', '0.6');
    await expect(list.getByRole('option', { name: 'Search for luma dream' })).toHaveCSS('opacity', '0.6');
    await moved.click();
    await expect(box).toHaveValue('lumax');
    await expect(list).toBeVisible();
    // Once the row has stood a quarter of a second, the press counts and opens that row.
    await page.clock.runFor(249);
    await moved.click();
    await expect(box).toHaveValue('lumax');
    await expect(moved).toHaveCSS('opacity', '0.6');
    await page.clock.runFor(1);
    // At full strength again as it starts to take a press.
    await expect(moved).toHaveCSS('opacity', '1');
    await moved.click();
    await expect(box).toHaveValue('luminous portrait');
    await page.clock.resume();
    await expect.poll(() => searches.some((search) => search.includes('q=luminous+portrait'))).toBe(true);
    await expect(list).toBeHidden();
  });

  test('draws nothing for the answer of a request the next letter ended', async ({ page }) => {
    let releaseEarly: () => void = () => {};
    const early = new Promise<void>((resolve) => { releaseEarly = resolve; });
    await openSearch(page, async (route, query) => {
      if (query === 'lu') {
        // Held until the box has moved on, then answered with rows only it would draw.
        await early;
        await route.fulfill(json({ ...suggestions(query), creators: [], entities: [], completions: [{ text: 'lunar stale answer' }] }))
          .catch(() => { /* the page aborted the request it no longer wants */ });
        return;
      }
      await route.fulfill(json({ ...suggestions(query), creators: [], entities: [], completions: [{ text: 'luminous current answer' }] }));
    });
    const box = page.getByRole('combobox');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });

    await box.fill('lu');
    await expect.poll(() => suggests).toEqual(['lu']);
    await box.fill('lum');
    await expect(list.getByRole('option')).toHaveText(['luminous current answer']);
    releaseEarly();
    // Long enough for a late answer to have been drawn, had it been.
    await page.waitForTimeout(400);
    await expect(list.getByRole('option')).toHaveText(['luminous current answer']);
    await expect(page.getByText('lunar stale answer')).toHaveCount(0);
  });

  test('shows nothing, and no error, for an empty, failed or refused answer', async ({ page }) => {
    await openSearch(page, async (route, query) => {
      if (query === 'empty') return route.fulfill(json({ query, normalizedQuery: query, creators: [], entities: [], completions: [] }));
      if (query === 'broken') return route.fulfill(json({ error: 'Failed to load search suggestions.' }, 500));
      if (query === 'busy') return route.fulfill(json({ code: 'RATE_LIMITED', retryAfterSeconds: 2 }, 429));
      return route.fulfill(json(suggestions(query)));
    });
    const box = page.getByRole('combobox');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });

    for (const typed of ['empty', 'broken', 'busy']) {
      await box.fill(typed);
      await expect.poll(() => suggests.at(-1)).toBe(typed);
      // The search for it still runs and settles; the typeahead adds nothing to the page.
      await expect(page.locator('p[role="status"]')).toContainText(`for ${typed}`);
      await expect(list).toHaveCount(0);
      await expect(box).toHaveAttribute('aria-expanded', 'false');
      // No alert of the page's (Next's own route announcer is one, and is not).
      await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
      await expect(page.locator('[data-search-typeahead-status]')).toHaveText('');
    }
    await shot(page, 'desktop-nothing-offered');
  });

  test('fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSearch(page, (route, query) => route.fulfill(json(suggestions(query))));
    const box = page.getByRole('combobox');
    await box.fill('lum');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });
    await expect(list).toBeVisible();
    await shot(page, 'phone-list');

    // Inside the screen's width, under the box, with rows a finger can press.
    const frame = await list.boundingBox();
    const field = await box.boundingBox();
    expect(frame).not.toBeNull();
    expect(frame!.x).toBeGreaterThanOrEqual(0);
    expect(frame!.x + frame!.width).toBeLessThanOrEqual(390);
    expect(frame!.y).toBeGreaterThanOrEqual(field!.y + field!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    for (const option of await list.getByRole('option').all()) {
      expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    // A tap chooses, as a click does.
    await list.getByRole('option', { name: 'Search for luminous portrait' }).tap().catch(async () => {
      // A context without touch: the same row, pressed.
      await list.getByRole('option', { name: 'Search for luminous portrait' }).click();
    });
    await expect(box).toHaveValue('luminous portrait');
    await expect(list).toBeHidden();
  });

  test('offers every kind from the top bar’s field on another page, recent searches first, and a row goes where the search page would', async ({ page }) => {
    const searched: string[] = [];
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      searched.push(url.search);
      await route.fulfill(json(searchResponse(url.searchParams.get('q') ?? '', url.searchParams.get('type') ?? 'top')));
    });
    await page.route(SUGGEST_API, async (route) => {
      await route.fulfill(json(suggestions(new URL(route.request().url()).searchParams.get('q') ?? '')));
    });
    await page.addInitScript(() => {
      window.localStorage.setItem('magicbooklet:public-search-history:v1', JSON.stringify(['lumen city', 'neon harbor']));
    });
    // No timeout of its own: the run's first request for the page waits for its compile.
    await page.goto('/contact');
    // A focus before the page's script has run is heard by nobody: wait for React's own record of the commit.
    await expect.poll(() => page.evaluate(() => {
      const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
      const root = key ? (document as unknown as Record<string, { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } }>)[key] : undefined;
      return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
    }), { timeout: 60_000, message: 'React commits the page’s hydration' }).toBe(true);

    const box = page.getByRole('banner').getByRole('combobox', { name: 'Search creators, posts, and recipes' });
    await expect(box).toHaveAttribute('placeholder', 'Search');
    await box.click();
    await box.pressSequentially('lum', { delay: 30 });
    // Its own clear button, the browser's being hidden.
    await expect(page.getByRole('banner').getByRole('button', { name: 'Clear search' })).toBeVisible();
    const list = page.getByRole('listbox', { name: 'Search suggestions' });
    await expect(list).toBeVisible();
    // No results under it: the recent search the text matches, then creators, models and tools, and completions.
    await expect(list.getByRole('option')).toHaveText([
      'lumen city',
      /E2E Creator.*@e2e-creator/,
      /Lumen Works.*@lumen/,
      /Luma Ray 2.*Model · 14 posts/,
      'luminous portrait',
      'lumen glow',
    ]);
    await expect(list.getByRole('group')).toHaveCount(4);
    await shot(page, 'desktop-top-bar');

    // Down to the first completion, and Enter: the search page, searching for it.
    await page.request.get('/search', { timeout: 0 });
    for (let presses = 0; presses < 5; presses += 1) await box.press('ArrowDown');
    await expect(list.getByRole('option').nth(4)).toHaveAttribute('aria-selected', 'true');
    await box.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=luminous\+portrait$/, { timeout: 60_000 });
    await expect.poll(() => searched.some((search) => search.includes('q=luminous+portrait')), { timeout: 30_000 }).toBe(true);
    // The focus came on into the search page's field, ready to refine the
    // search, with the typeahead closed over the search just committed.
    const pageBox = page.getByRole('main').getByRole('combobox', { name: 'Search creators, posts, and recipes' });
    await expect(pageBox).toBeFocused();
    await expect(pageBox).toHaveValue('luminous portrait');
    await expect(page.getByRole('listbox', { name: 'Search suggestions' })).toHaveCount(0);
  });

  test('takes a press on a creator row and on a model row in the top bar’s field', async ({ page }) => {
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill(json(searchResponse(url.searchParams.get('q') ?? '', url.searchParams.get('type') ?? 'top')));
    });
    await page.route(SUGGEST_API, (route) => route.fulfill(json(suggestions(new URL(route.request().url()).searchParams.get('q') ?? ''))));
    const openContact = async () => {
      await page.goto('/contact');
      await expect.poll(() => page.evaluate(() => {
        const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
        const root = key ? (document as unknown as Record<string, { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } }>)[key] : undefined;
        return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
      }), { timeout: 60_000, message: 'React commits the page’s hydration' }).toBe(true);
      const box = page.getByRole('banner').getByRole('combobox', { name: 'Search creators, posts, and recipes' });
      await box.click();
      await box.pressSequentially('lum', { delay: 30 });
      const list = page.getByRole('listbox', { name: 'Search suggestions' });
      await expect(list.getByRole('option')).toHaveCount(5);
      await expect(list).not.toHaveAttribute('aria-busy', 'true');
      return list;
    };

    // A model or tool: the search page's Posts for what was typed, narrowed to it.
    await page.request.get('/search', { timeout: 0 });
    let list = await openContact();
    await list.getByRole('option', { name: /Luma Ray 2/ }).click();
    await expect(page).toHaveURL(/\/search\?q=lum&type=posts&madeWith=model%3Aluma-ray-2$/, { timeout: 60_000 });
    // Named by its key until an answer names it (this file's answers do not).
    await expect(page.getByRole('button', { name: /^Remove filter: made with / })).toBeVisible();

    // A creator: their profile.
    await page.request.get('/creators/e2e-creator', { timeout: 0 });
    list = await openContact();
    await list.getByRole('option', { name: /E2E Creator/ }).click();
    await expect(page).toHaveURL(/\/creators\/e2e-creator$/, { timeout: 60_000 });
  });

  test('keeps Vary: Authorization on a visitor’s cacheable answer beside the proxy’s CORS headers', async ({ page }) => {
    // The real proxy and the real route, no page.route: an allowed origin, as the app's web build
    // sends, and no token, so this is the answer the edge may keep.
    const origin = 'http://127.0.0.1:3100';
    const response = await page.request.get(`/api/search/suggest?q=${encodeURIComponent(suggestFixture.query)}`, {
      headers: { Origin: origin },
      timeout: 0,
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      query: suggestFixture.query,
      normalizedQuery: suggestFixture.query,
      creators: [{ id: 'workflow-user', username: 'e2e-creator', displayName: 'E2E Creator', avatarUrl: null, isFollowing: false }],
      entities: [{ kind: 'tool', key: 'e2e-tool', label: 'E2E Tool', postCount: 2, postCountCapped: false }],
      completions: [{ text: 'e2e typeahead vary proof' }],
    });
    const headers = response.headers();
    expect(headers['cache-control']).toBe('public, s-maxage=60, stale-while-revalidate=300');
    // The proxy answered this path as one of the app's: its CORS grant is on the response.
    expect(headers['access-control-allow-origin']).toBe(origin);
    // Both are named: the answer is a visitor's and not a token's, and the grant is this origin's.
    const vary = (headers.vary ?? '').split(',').map((name) => name.trim().toLowerCase());
    expect(vary).toContain('authorization');
    expect(vary).toContain('origin');
  });
});
