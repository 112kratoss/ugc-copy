import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type Page, type Route } from '@playwright/test';

import suggestFixture from './fixtures/search-suggestions.json';

// The search box's typeahead in a browser: what it offers while a person
// types, with the keys and with the pointer, an answer that comes back late,
// an answer with nothing in it, at a phone's width; and one request through
// the real proxy and the real /api/search/suggest for the headers of its 200.
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

  /** Opens /search with a query already searched, so the results on screen say the page's script has run. */
  async function openSearch(page: Page, suggest: (route: Route, query: string) => Promise<void> | void) {
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
    await page.goto('/search?q=luna');
    await expect(page.getByText('Luna Studio')).toBeVisible();
    // On arrival the box does not have the focus: nothing was asked.
    expect(suggests).toEqual([]);
  }

  test('offers creators, models and tools, and completions, and follows the keys', async ({ page }) => {
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

    // Creators, then models and tools, then completions.
    await expect(list.getByRole('option')).toHaveText([
      /E2E Creator.*@e2e-creator/,
      /Lumen Works.*@lumen/,
      /Luma Ray 2.*Model · 14 posts/,
      'luminous portrait',
      'lumen glow',
    ]);
    await expect(list.getByRole('group')).toHaveCount(3);
    await expect(page.locator('[data-search-typeahead-status]')).toHaveText('5 suggestions');
    await shot(page, 'desktop-list');

    // The arrows move the highlight; the focus stays in the box.
    const options = list.getByRole('option');
    await box.press('ArrowDown');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(box).toHaveAttribute('aria-activedescendant', (await options.nth(0).getAttribute('id')) ?? 'no id');
    await box.press('End');
    await expect(options.nth(4)).toHaveAttribute('aria-selected', 'true');
    await box.press('Home');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await box.press('ArrowUp');
    await expect(list.locator('[aria-selected="true"]')).toHaveCount(0);
    await expect(box).toBeFocused();
    await box.press('ArrowUp');
    await expect(options.nth(4)).toHaveAttribute('aria-selected', 'true');
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
    await box.press('ArrowDown');
    await box.press('ArrowDown');
    await box.press('ArrowDown');
    await expect(options.nth(3)).toHaveAttribute('aria-selected', 'true');
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

  test('takes a press on each kind of row', async ({ page }) => {
    await openSearch(page, (route, query) => route.fulfill(json(suggestions(query))));
    const box = page.getByRole('combobox');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });

    // A model or tool: Posts for what is typed, narrowed to it.
    await box.fill('lum');
    await list.getByRole('option', { name: /Luma Ray 2/ }).click();
    await expect(list).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Posts' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Remove filter: made with Luma Ray 2' })).toBeVisible();
    await expect(page).toHaveURL(/[?&]q=lum&type=posts&madeWith=model%3Aluma-ray-2/);
    await expect(box).toHaveValue('lum');
    // The press did not take the focus from the box.
    await expect(box).toBeFocused();

    // A completion: the box is filled and searched. The rows of "lum" stay on
    // show until the answer for "lumi" lands and puts the model back among
    // them, moving the rows under the pointer. A row that has just moved takes
    // no press for a moment, and the list says it is busy until it does.
    await box.fill('lumi');
    await expect.poll(() => suggests.at(-1)).toBe('lumi');
    await expect(list.getByRole('option')).toHaveCount(5);
    await expect(list).not.toHaveAttribute('aria-busy', 'true');
    await list.getByRole('option', { name: 'Search for lumen glow' }).click();
    await expect(box).toHaveValue('lumen glow');
    await expect.poll(() => searches.some((search) => search.includes('q=lumen+glow'))).toBe(true);
    await expect(list).toBeHidden();

    // A creator: their profile.
    await box.fill('lum');
    await page.request.get('/creators/e2e-creator', { timeout: 0 });
    await list.getByRole('option', { name: /E2E Creator/ }).click();
    await expect(page).toHaveURL(/\/creators\/e2e-creator$/, { timeout: 30_000 });
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
    await expect(list.getByRole('option')).toHaveCount(5);
    await expect(said).toHaveText('5 suggestions');
    // The page searches as the box is typed into; its outcome is not said over the list.
    await expect.poll(() => searches.some((search) => search.includes('q=lum&'))).toBe(true);
    await expect(resultsSaid).toHaveText('');

    // The next letter, its answer held: the list never goes. It keeps what it
    // had, less the model "lumi" no longer names, and says it is busy.
    await box.press('End');
    await box.press('i');
    await expect(box).toHaveValue('lumi');
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('aria-busy', 'true');
    await expect(list.getByRole('option')).toHaveText([
      /E2E Creator.*@e2e-creator/,
      /Lumen Works.*@lumen/,
      'luminous portrait',
      'lumen glow',
    ]);
    await expect.poll(() => suggests).toEqual(['lum', 'lumi']);
    // Past the pause a count waits for: a stale list is not announced.
    await page.waitForTimeout(900);
    await expect(list).toHaveAttribute('aria-busy', 'true');
    await expect(said).toHaveText('5 suggestions');
    await expect(resultsSaid).toHaveText('');
    await shot(page, 'desktop-stale-list');

    // The highlight is put on a stale row that the answer keeps: it stays on that row.
    await box.press('ArrowDown');
    await box.press('ArrowDown');
    await expect(list.getByRole('option', { name: /Lumen Works/ })).toHaveAttribute('aria-selected', 'true');
    release();
    await expect(list.getByRole('option')).toHaveText([/Lumen Works.*@lumen/, 'luminous portrait']);
    await expect(list).not.toHaveAttribute('aria-busy', 'true');
    await expect(list.getByRole('option', { name: /Lumen Works/ })).toHaveAttribute('aria-selected', 'true');
    await expect(said).toHaveText('2 suggestions');

    // Enter settles the search: the list goes and the results speak.
    await box.press('ArrowUp');
    await expect(list.locator('[aria-selected="true"]')).toHaveCount(0);
    await box.press('Enter');
    await expect(list).toBeHidden();
    await expect(resultsSaid).toContainText('1 result for lumi');
  });

  test('opens a creator pressed inside the search’s pause, however slowly their page answers, and Back returns to the search left', async ({ page }) => {
    // CI, #778: the press on the creator's row opened nothing and the page
    // stayed on its own address. The search page wrote that address a pause
    // after the last letter through Next's patched history.replaceState;
    // Next's router read the write as a navigation, and a navigation discards
    // the one to the creator's page while that is still loading. The write no
    // longer reaches the router (public-search.spec.ts holds the same for a
    // result and for a link of the sidebar). The page's clock is the test's
    // here, so the pause passes exactly while the creator's page is held back.
    await page.clock.install();
    let releaseCreator: () => void = () => {};
    const creatorHeld = new Promise<void>((resolve) => { releaseCreator = resolve; });
    await openSearch(page, (route, query) => route.fulfill(json(suggestions(query))));
    // The route is compiled before it is held: the hold is the page's answer, not the compiler's.
    await page.request.get('/creators/e2e-creator', { timeout: 0 });
    await page.route((url) => url.pathname === '/creators/e2e-creator', async (route) => {
      await creatorHeld;
      await route.continue();
    });
    const box = page.getByRole('combobox');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });

    await box.fill('lum');
    await expect(list.getByRole('option')).toHaveCount(5);
    await expect(page).toHaveURL(/[?&]q=lum(&|$)/);
    await expect.poll(() => searches.filter((search) => /[?&]q=lum(&|$)/.test(search)).length).toBe(1);

    // Time stands still: the next letter's pauses (140 ms for its suggestions,
    // 300 ms for its search) pass only when the test says so.
    await page.clock.pauseAt(new Date(Date.now() + 5_000));
    await box.press('End');
    await box.press('i');
    await expect(box).toHaveValue('lumi');
    // The rows of "lum" are still on show, the creators where they stood.
    await list.getByRole('option', { name: /E2E Creator/ }).click();

    // The press wrote the search being left, ahead of the way out.
    expect(new URL(page.url()).searchParams.get('q')).toBe('lumi');

    // The search's pause passes while the creator's page has not answered:
    // the search the page says it is running is asked, and the page is still here.
    await page.clock.runFor(1_000);
    expect(searches.filter((search) => /[?&]q=lumi(&|$)/.test(search))).toHaveLength(1);
    expect(new URL(page.url()).pathname).toBe('/search');

    releaseCreator();
    await page.clock.resume();
    await expect(page).toHaveURL(/\/creators\/e2e-creator$/, { timeout: 30_000 });

    // Back: the search the person left, in the box, in the address and run again.
    const asked = searches.length;
    await page.goBack();
    await expect(page).toHaveURL(/\/search\?q=lumi$/);
    await expect(page.getByRole('combobox')).toHaveValue('lumi');
    await expect.poll(() => searches.slice(asked)).toEqual(['?q=lumi&type=top']);
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
    });
    const box = page.getByRole('combobox');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });
    const options = list.getByRole('option');
    const rowUnder = (x: number, y: number) => page.evaluate(
      ([px, py]) => document.elementFromPoint(px, py)?.closest('[role="option"]')?.getAttribute('aria-label') ?? null,
      [x, y],
    );

    await box.fill('lum');
    await expect(options).toHaveCount(5);
    // The next letter, its answer held: every row is still named by "luma", and stands where it stood.
    await box.press('End');
    await box.press('a');
    await expect(box).toHaveValue('luma');
    await expect(options).toHaveText([/E2E Creator/, /Lumen Works/, /Luma Ray 2/, 'luminous portrait', 'lumen glow']);

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
    await expect(options).toHaveCount(6);
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
    // is exact: the letter takes the model away, and the completions move up,
    // "luma dream" into the model's place.
    await page.clock.pauseAt(new Date(Date.now() + 5_000));
    await box.press('End');
    await box.press('x');
    await expect(box).toHaveValue('lumax');
    await expect(options).toHaveText([/E2E Creator/, /Lumen Works/, 'luma dream', 'luminous portrait', 'lumen glow']);
    // What a sighted person has of it: the rows that moved are dimmed, and the
    // creators above them, which stand where they stood, are not.
    const moved = list.getByRole('option', { name: 'Search for luminous portrait' });
    await expect(moved).toHaveCSS('opacity', '0.6');
    await expect(list.getByRole('option', { name: 'Search for luma dream' })).toHaveCSS('opacity', '0.6');
    await expect(list.getByRole('option', { name: /E2E Creator/ })).toHaveCSS('opacity', '1');
    await expect(list.getByRole('option', { name: /Lumen Works/ })).toHaveCSS('opacity', '1');
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

  test('offers the same from the top bar’s field on another page, and a row goes where the search page would', async ({ page }) => {
    const searched: string[] = [];
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      searched.push(url.search);
      await route.fulfill(json(searchResponse(url.searchParams.get('q') ?? '', url.searchParams.get('type') ?? 'top')));
    });
    await page.route(SUGGEST_API, async (route) => {
      await route.fulfill(json(suggestions(new URL(route.request().url()).searchParams.get('q') ?? '')));
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
    await box.click();
    await box.pressSequentially('lum', { delay: 30 });
    const list = page.getByRole('listbox', { name: 'Search suggestions' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('option')).toHaveCount(5);
    await shot(page, 'desktop-top-bar');

    // Down to the first completion, and Enter: the search page, searching for it.
    await page.request.get('/search', { timeout: 0 });
    for (let presses = 0; presses < 4; presses += 1) await box.press('ArrowDown');
    await expect(list.getByRole('option').nth(3)).toHaveAttribute('aria-selected', 'true');
    await box.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=luminous\+portrait$/, { timeout: 60_000 });
    await expect.poll(() => searched.some((search) => search.includes('q=luminous+portrait')), { timeout: 30_000 }).toBe(true);
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
