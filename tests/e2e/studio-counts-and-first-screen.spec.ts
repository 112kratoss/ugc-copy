import path from 'node:path';

import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

/**
 * Studio as the live sweep of 2026-11-17 found it, signed in with 54 finished creations: its first
 * page of 36 held 29 of them, 5 failed runs and 2 still processing, and "Load more creations" waited
 * below the grid.
 *
 * - The counts: the header read the library's total from the server ("54 CREATIONS TOTAL") while
 *   the media filters counted the finished creations of the loaded page ("All (29)", "Images (29)").
 * - The phone (375 × 812): the header, the section tabs wrapped onto two lines and the portfolio
 *   setup card filled the first screen, and no creation showed in it.
 * - The Post Library, which loads its posts 36 at a time too, counted only the pages loaded in its
 *   header and its visibility filters (#836's note, fixed after it).
 * - A filter's own total: since 20261117192621 the server splits the creations by kind and the
 *   live posts by visibility, and each filter says its number while pages wait; a profile without
 *   the splits, as a database from before them answers, keeps a filter's number for the whole list.
 *
 * Studio reads its data from the browser, so page.route answers each request; nothing here reads
 * Supabase on the server.
 */

const COLD_PAGE = { timeout: 45_000 };
test.describe.configure({ timeout: 120_000 });

const PICTURE = path.join(__dirname, 'fixtures/blue.png');
const NEXT_PAGE_CURSOR = 'e2e-studio-page-2';

const PROFILE = {
  id: 'workflow-user',
  username: 'maya-k',
  suggestedUsername: 'maya-k',
  displayName: 'Maya K',
  // No photo and no bio: the setup card asks to finish the profile, as it did in the sweep.
  bio: null,
  avatarUrl: null,
  coverUrl: null,
  websiteUrl: null,
  twitterHandle: null,
  instagramHandle: null,
  tiktokHandle: null,
  location: null,
  // owner_profile_counts: the library's totals, counted by the grid's own rules.
  stats: { creations: 54, failedCreations: 5, archivedCreations: 0, posts: 1, archivedPosts: 0, saved: 0 },
};

type Kind = 'image' | 'video';
type Status = 'succeeded' | 'failed' | 'processing';

/** A run of the library, newest first by its number. */
function creation(index: number, kind: Kind, status: Status = 'succeeded') {
  const createdAt = new Date(Date.UTC(2026, 10, 16, 12) - index * 60_000).toISOString();
  const succeeded = status === 'succeeded';
  return {
    id: `gen-e2e-studio-${index}`,
    output_url: succeeded
      ? `https://cdn.example.com/e2e/studio-${index}.${kind === 'image' ? 'png' : 'mp4'}`
      : null,
    preview_url: succeeded && kind === 'video' ? `https://cdn.example.com/e2e/studio-${index}-poster.png` : null,
    status,
    created_at: createdAt,
    completed_at: status === 'processing' ? null : createdAt,
    duration: 30,
    cost: 1,
    category: kind,
    model: kind === 'image' ? 'nano-banana-2' : 'veo3_fast',
    title: `Studio ${kind} ${index}`,
    description: '',
    prompt: 'A product still lit like a window display, soft morning light',
    origin: 'creation',
    linked_post_id: null,
    archived_at: null,
    ...(status === 'failed' ? { error_message: 'The model could not finish this run.' } : {}),
  };
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, offset) => from + offset);

// 36 runs: 2 processing, 29 finished pictures, 5 failed.
const FIRST_PAGE = [
  ...range(0, 2).map((index) => creation(index, 'image', 'processing')),
  ...range(2, 29).map((index) => creation(index, 'image')),
  ...range(31, 5).map((index) => creation(index, 'image', 'failed')),
];
// The other 25 finished creations: 18 pictures and 7 clips. 29 + 25 = 54.
const SECOND_PAGE = [
  ...range(36, 18).map((index) => creation(index, 'image')),
  ...range(54, 7).map((index) => creation(index, 'video')),
];

// One public post, so the setup card reads "Finish the profile behind your published work."
const PUBLIC_POST = {
  id: 'post-e2e-studio-public',
  generationId: null,
  visibility: 'public',
  archivedAt: null,
  mediaUrl: null,
  mediaKind: null,
  title: 'A public text post',
  description: '',
  prompt: '',
  body: 'Made in Magic Booklet.',
  category: 'text',
  postFormat: 'text',
  sourceKind: 'magicbooklet',
  sourceTool: null,
  sourceLabel: 'Magic Booklet',
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
  publicPath: '/showcase/post-e2e-studio-public',
  ownerPath: '/post/post-e2e-studio-public/edit',
  resourcePath: null,
  canShare: true,
  bundle: null,
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function answerStudio(page: Page) {
  await page.context().addCookies([
    // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
    { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
  ]);
  await page.route('https://cdn.example.com/**', (route) => (
    route.request().url().endsWith('.png') ? route.fulfill({ path: PICTURE }) : route.fulfill({ status: 404 })
  ));
  await page.route('**/api/source-tools**', (route) => json(route, { tools: [] }));
  await page.route('**/api/profile', (route) => json(route, PROFILE));
  await page.route('**/api/posts?**', (route) => json(route, {
    posts: [PUBLIC_POST],
    pageInfo: { hasMore: false, nextOffset: null },
  }));
  await page.route('**/api/generations?**', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('detail') === 'status') {
      // The processing runs are still processing.
      const ids = new Set((url.searchParams.get('ids') ?? '').split(','));
      return json(route, { generations: FIRST_PAGE.filter((run) => ids.has(run.id)) });
    }
    if (url.searchParams.get('cursor') === NEXT_PAGE_CURSOR) {
      return json(route, { generations: SECOND_PAGE, pagination: { limit: 36, hasMore: false, nextCursor: null } });
    }
    return json(route, { generations: FIRST_PAGE, pagination: { limit: 36, hasMore: true, nextCursor: NEXT_PAGE_CURSOR } });
  });
}

/** The media filters' labels, in their order. */
async function filterLabels(page: Page) {
  const all = page.getByRole('link', { name: /^All( \(\d+\))?$/ });
  await expect(all).toBeVisible(COLD_PAGE);
  return all.locator('xpath=..').getByRole('link').allTextContents();
}

const header = (page: Page) => page.getByRole('heading', { level: 1, name: 'Studio' }).locator('xpath=following-sibling::p[1]');
const firstTile = (page: Page) => page.locator('#main-content article').first();
const sectionTabs = (page: Page) => page.getByRole('navigation', { name: 'Studio sections' }).getByRole('link');

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error('not drawn');
  return found;
}

test.describe('Studio with more creations than its first page', () => {
  test.beforeEach(async ({ page }) => {
    await answerStudio(page);
  });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('the header and the media filters say the same totals, and a filter shows a number only when it is a total', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // No timeout of its own: the run's first request for the route waits for its compile.
    await page.goto('/creations');
    await expect(page.getByText('Studio image 2', { exact: true })).toBeVisible(COLD_PAGE);

    await expect(header(page)).toHaveText('54 CREATIONS TOTAL');
    // The sweep's "All (29)" and "Images (29)": the loaded page, not the library.
    expect(await filterLabels(page)).toEqual(['All (54)', 'Images']);

    await page.getByRole('button', { name: 'Load more creations' }).click();
    await expect(page.getByText('Studio video 60', { exact: true })).toBeVisible(COLD_PAGE);
    await expect(page.getByRole('button', { name: 'Load more creations' })).toBeHidden();

    // Every page loaded: each number is the library's.
    await expect(header(page)).toHaveText('54 CREATIONS TOTAL');
    expect(await filterLabels(page)).toEqual(['All (54)', 'Images (47)', 'Videos (7)']);
  });

  // owner_profile_counts counts each kind too since 20261117192621 (the owner's ask of 2026-11-17):
  // a media filter says the library's number while pages wait.
  test("with the server's kinds, a media filter says its total while pages wait", async ({ page }) => {
    await page.route('**/api/profile', (route) => json(route, {
      ...PROFILE,
      stats: { ...PROFILE.stats, creationsByKind: { images: 47, videos: 7, audio: 0 } },
    }));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/creations');
    await expect(page.getByText('Studio image 2', { exact: true })).toBeVisible(COLD_PAGE);

    await expect(header(page)).toHaveText('54 CREATIONS TOTAL');
    // A kind with nothing loaded is still no filter.
    expect(await filterLabels(page)).toEqual(['All (54)', 'Images (47)']);

    await page.getByRole('button', { name: 'Load more creations' }).click();
    await expect(page.getByText('Studio video 60', { exact: true })).toBeVisible(COLD_PAGE);
    expect(await filterLabels(page)).toEqual(['All (54)', 'Images (47)', 'Videos (7)']);
  });

  test('on a phone, a creation shows in the first screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/creations');
    // Loaded, not loading: a run in progress draws its card while the posts and the profile are
    // still being read, before the setup card above it, which only a loaded page draws.
    const setup = page.getByRole('region', { name: 'Portfolio setup' });
    await expect(setup).toBeVisible(COLD_PAGE);
    await expect(page.getByRole('link', { name: 'All (54)' })).toBeVisible();
    await expect(firstTile(page)).toBeVisible();

    // The section tabs keep to one row.
    const tabTops = await Promise.all((await sectionTabs(page).all()).map(async (tab) => (await box(tab)).y));
    expect(tabTops).toHaveLength(3);
    expect(new Set(tabTops).size, `the tabs' tops: ${tabTops.join(', ')}`).toBe(1);

    // The first creation starts in the first screen, with a good part of it above the bottom
    // navigation that floats over the page.
    const tile = await box(firstTile(page));
    const bottomNavigation = await box(page.getByRole('navigation', { name: 'Primary mobile navigation' }));
    expect(tile.y, `the first creation's top, the bottom navigation's at ${bottomNavigation.y}`).toBeLessThan(bottomNavigation.y - 160);

    // Nothing widens the page.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);

    // The setup card still asks, and its steps open from it, below it: the button stays under
    // the finger, and what it opens comes after it, where a screen reader goes next (review of
    // #836: the line under the title opened above the button and pushed it down).
    const steps = setup.getByRole('button', { name: 'Steps' });
    // The card holds the line twice, under the title from 640px and under Steps on a phone: the
    // one drawn at this width.
    const detail = setup.getByText('Your creation and public proof are in place.', { exact: false }).filter({ visible: true });
    await expect(setup.getByRole('link', { name: 'Complete profile' })).toBeVisible();
    await expect(steps).toHaveAttribute('aria-expanded', 'false');
    await expect(detail).toBeHidden();
    await expect(setup.getByText('Strengthen creator profile')).toBeHidden();
    await expect(setup.getByRole('link', { name: 'View portfolio' })).toBeHidden();
    const closedButton = await box(steps);
    await steps.click();
    await expect(steps).toHaveAttribute('aria-expanded', 'true');
    await expect(detail).toBeVisible();
    await expect(setup.getByText('Strengthen creator profile')).toBeVisible();
    await expect(setup.getByRole('link', { name: 'View portfolio' })).toBeVisible();
    // Where it was, but for the 1px a hovered button lifts by (`.ui-button:hover`).
    expect(Math.abs((await box(steps)).y - closedButton.y)).toBeLessThanOrEqual(1);
    for (const opened of [detail, setup.getByRole('link', { name: 'View portfolio' }), setup.getByText('Strengthen creator profile')]) {
      expect(await steps.evaluate(
        (button, element) => Boolean(button.compareDocumentPosition(element!) & Node.DOCUMENT_POSITION_FOLLOWING),
        await opened.elementHandle(),
      )).toBe(true);
    }
    for (const id of (await steps.getAttribute('aria-controls'))!.split(' ')) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
    await steps.click();
    await expect(detail).toBeHidden();
    await expect(setup.getByText('Strengthen creator profile')).toBeHidden();
  });

  test('on a laptop, the setup card shows its steps with no disclosure', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/creations');

    const setup = page.getByRole('region', { name: 'Portfolio setup' });
    await expect(setup.getByText('Strengthen creator profile')).toBeVisible(COLD_PAGE);
    await expect(setup.getByText('Your creation and public proof are in place.', { exact: false }).filter({ visible: true })).toBeVisible();
    await expect(setup.getByRole('link', { name: 'View portfolio' })).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Steps' })).toBeHidden();
    // The section tabs and the line that says what the open one holds, as before.
    await expect(page.getByText('Preview private outputs, then turn the strongest ones into posts.')).toBeVisible();
  });
});

type PostVisibility = 'public' | 'unlisted' | 'private';

/** A text post of the library, newest first by its number. An archived one keeps its visibility. */
function libraryPost(index: number, visibility: PostVisibility, archived = false) {
  const createdAt = new Date(Date.UTC(2026, 10, 16, 12) - index * 60_000).toISOString();
  const shown = !archived && visibility !== 'private';
  return {
    ...PUBLIC_POST,
    id: `post-e2e-library-${index}`,
    visibility,
    archivedAt: archived ? createdAt : null,
    title: `Library post ${index}`,
    createdAt,
    updatedAt: createdAt,
    publicPath: shown ? `/showcase/post-e2e-library-${index}` : null,
    ownerPath: `/post/post-e2e-library-${index}/edit`,
    canShare: shown,
  };
}

// 36 posts: 22 public, 9 private and 5 archived.
const FIRST_POSTS_PAGE = [
  ...range(0, 22).map((index) => libraryPost(index, 'public')),
  ...range(22, 9).map((index) => libraryPost(index, 'private')),
  ...range(31, 5).map((index) => libraryPost(index, 'public', true)),
];
// The other 14: 8 public, the one unlisted post left from before 2026-10-17, 2 private and 3
// archived. The library: 42 posts (30 public, 1 unlisted, 11 private) and 8 archived.
const SECOND_POSTS_PAGE = [
  ...range(36, 8).map((index) => libraryPost(index, 'public')),
  libraryPost(44, 'unlisted'),
  ...range(45, 2).map((index) => libraryPost(index, 'private')),
  ...range(47, 3).map((index) => libraryPost(index, 'public', true)),
];

/**
 * The Post Library's reads and writes, answered as the owner list answers them: every post of the
 * library, archived ones too, newest first, a page of `limit` from `offset` (owner-posts.ts). A
 * delete takes its post out of the list, an archive leaves it in its place.
 */
async function answerPostLibrary(page: Page) {
  // Each test's own copy: an archive or a delete changes it.
  const library = [...FIRST_POSTS_PAGE, ...SECOND_POSTS_PAGE].map((post) => ({ ...post }));
  await page.context().addCookies([
    { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
  ]);
  await page.route('**/api/source-tools**', (route) => json(route, { tools: [] }));
  // owner_profile_counts: the library's 42 posts and 8 archived ones.
  await page.route('**/api/profile', (route) => json(route, {
    ...PROFILE,
    stats: { creations: 0, failedCreations: 0, archivedCreations: 0, posts: 42, archivedPosts: 8, saved: 0 },
  }));
  await page.route('**/api/generations?**', (route) => json(route, {
    generations: [],
    pagination: { limit: 36, hasMore: false, nextCursor: null },
  }));
  await page.route('**/api/posts?**', (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 36);
    const hasMore = library.length > offset + limit;
    return json(route, {
      posts: library.slice(offset, offset + limit),
      pageInfo: { hasMore, nextOffset: hasMore ? offset + limit : null },
    });
  });
  await page.route('**/api/posts/post-e2e-library-*/archive', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    const archived = library.find((post) => post.id === id);
    if (archived) archived.archivedAt = '2026-11-17T12:00:00.000Z';
    return json(route, { success: true });
  });
  await page.route('**/api/posts/post-e2e-library-*', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const index = library.findIndex((post) => post.id === id);
    if (index === -1) return json(route, { error: 'Post not found.' }, 404);
    library.splice(index, 1);
    return json(route, { success: true });
  });
}

/** The visibility filters' labels, in their order. */
async function postFilterLabels(page: Page) {
  const filters = page.getByRole('group', { name: 'Filter posts by visibility' });
  await expect(filters).toBeVisible(COLD_PAGE);
  return filters.getByRole('link').allTextContents();
}

/**
 * Chooses one of a post's actions behind its More actions menu. A menu closes on any scroll, and a
 * scroll's event comes a frame after it: the row is brought into view first, and the press repeated
 * if that event closed the menu (as in post-page-comments-rail.spec.ts).
 */
async function choosePostAction(page: Page, title: string, action: string) {
  const postMenu = page.getByRole('button', { name: `More actions for ${title}`, exact: true });
  const item = page.getByRole('menu').getByRole('menuitem', { name: action });
  await postMenu.scrollIntoViewIfNeeded();
  await expect(async () => {
    if (await page.getByRole('menu').count() === 0) await postMenu.click({ timeout: 2_000 });
    await expect(item).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await item.click();
}

test.describe("Studio's Post Library with more posts than its first page", () => {
  test.beforeEach(async ({ page }) => {
    await answerPostLibrary(page);
  });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('the header and the visibility filters say the same totals, and a filter shows a number only when it is a total', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // No timeout of its own: the run's first request for the route waits for its compile.
    await page.goto('/creations?view=posts');
    await expect(page.getByText('Library post 0', { exact: true })).toBeVisible(COLD_PAGE);

    // The first page alone said "31 POSTS · 5 ARCHIVED" over "All (31)", "Public (22)",
    // "Private (9)" and "Archived (5)".
    await expect(header(page)).toHaveText('42 POSTS · 8 ARCHIVED');
    expect(await postFilterLabels(page)).toEqual(['All (42)', 'Public', 'Private', 'Archived (8)']);

    await page.getByRole('button', { name: 'Load more posts' }).click();
    await expect(page.getByText('Library post 46', { exact: true })).toBeVisible(COLD_PAGE);
    await expect(page.getByRole('button', { name: 'Load more posts' })).toBeHidden();

    // Every page loaded: each number is the library's.
    await expect(header(page)).toHaveText('42 POSTS · 8 ARCHIVED');
    expect(await postFilterLabels(page))
      .toEqual(['All (42)', 'Public (30)', 'Unlisted (1)', 'Private (11)', 'Archived (8)']);

    // A post archived here moves from one total to the other at once.
    await choosePostAction(page, 'Library post 0', 'Archive post');
    await page.getByRole('alertdialog', { name: 'Archive this post?' }).getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText('Post archived. Find it under Archived.')).toBeVisible();
    await expect(header(page)).toHaveText('41 POSTS · 9 ARCHIVED');
    expect(await postFilterLabels(page))
      .toEqual(['All (41)', 'Public (29)', 'Unlisted (1)', 'Private (11)', 'Archived (9)']);
  });

  // owner_profile_counts counts the live posts by visibility since 20261117192621, which #860 left
  // for a migration: Public and Private say the library's numbers while pages wait.
  test("with the server's visibilities, a visibility filter says its total while pages wait", async ({ page }) => {
    await page.route('**/api/profile', (route) => json(route, {
      ...PROFILE,
      stats: {
        creations: 0,
        failedCreations: 0,
        archivedCreations: 0,
        posts: 42,
        postsByVisibility: { public: 30, unlisted: 1, private: 11 },
        archivedPosts: 8,
        saved: 0,
      },
    }));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/creations?view=posts');
    await expect(page.getByText('Library post 0', { exact: true })).toBeVisible(COLD_PAGE);

    await expect(header(page)).toHaveText('42 POSTS · 8 ARCHIVED');
    // Unlisted is a filter only once a post saved as one is loaded.
    expect(await postFilterLabels(page)).toEqual(['All (42)', 'Public (30)', 'Private (11)', 'Archived (8)']);

    // A post archived here moves from its visibility to the archived total at once, pages waiting.
    await choosePostAction(page, 'Library post 0', 'Archive post');
    await page.getByRole('alertdialog', { name: 'Archive this post?' }).getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText('Post archived. Find it under Archived.')).toBeVisible();
    await expect(header(page)).toHaveText('41 POSTS · 9 ARCHIVED');
    expect(await postFilterLabels(page)).toEqual(['All (41)', 'Public (29)', 'Private (11)', 'Archived (9)']);
  });

  // The next page is asked for by offset, the place of its first post in the owner list. A delete
  // moves every later post up a place, and Load more asked a place too far on: "Library post 36",
  // which moved up into the next page's first place, never came.
  test('a post deleted while more pages wait leaves no gap: the next page starts a place earlier', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/creations?view=posts');
    await expect(page.getByText('Library post 1', { exact: true })).toBeVisible(COLD_PAGE);

    await choosePostAction(page, 'Library post 1', 'Delete post');
    await page.getByRole('alertdialog', { name: 'Delete this post permanently?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Post deleted.')).toBeVisible();
    await expect(page.getByText('Library post 1', { exact: true })).toBeHidden();

    const nextPage = page.waitForRequest((request) => (
      request.url().includes('/api/posts?') && new URL(request.url()).searchParams.get('offset') !== '0'
    ));
    await page.getByRole('button', { name: 'Load more posts' }).click();
    expect(new URL((await nextPage).url()).searchParams.get('offset')).toBe('35');
    await expect(page.getByText('Library post 36', { exact: true })).toBeVisible(COLD_PAGE);
    await expect(page.getByRole('button', { name: 'Load more posts' })).toBeHidden();

    // The whole library, the deleted post out of it.
    await expect(header(page)).toHaveText('41 POSTS · 8 ARCHIVED');
    expect(await postFilterLabels(page))
      .toEqual(['All (41)', 'Public (29)', 'Unlisted (1)', 'Private (11)', 'Archived (8)']);
  });
});
