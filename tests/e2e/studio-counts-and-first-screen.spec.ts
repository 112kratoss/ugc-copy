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
    await page.goto('/creations', COLD_PAGE);
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

  test('on a phone, a creation shows in the first screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/creations', COLD_PAGE);
    await expect(firstTile(page)).toBeVisible(COLD_PAGE);

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

    // The setup card still asks, and its steps open from it.
    const setup = page.getByRole('region', { name: 'Portfolio setup' });
    const steps = setup.getByRole('button', { name: 'Steps' });
    await expect(setup.getByRole('link', { name: 'Complete profile' })).toBeVisible();
    await expect(steps).toHaveAttribute('aria-expanded', 'false');
    await expect(setup.getByText('Strengthen creator profile')).toBeHidden();
    await expect(setup.getByRole('link', { name: 'View portfolio' })).toBeHidden();
    await steps.click();
    await expect(steps).toHaveAttribute('aria-expanded', 'true');
    await expect(setup.getByText('Strengthen creator profile')).toBeVisible();
    await expect(setup.getByRole('link', { name: 'View portfolio' })).toBeVisible();
    await steps.click();
    await expect(setup.getByText('Strengthen creator profile')).toBeHidden();
  });

  test('on a laptop, the setup card shows its steps with no disclosure', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/creations', COLD_PAGE);

    const setup = page.getByRole('region', { name: 'Portfolio setup' });
    await expect(setup.getByText('Strengthen creator profile')).toBeVisible(COLD_PAGE);
    await expect(setup.getByRole('link', { name: 'View portfolio' })).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Steps' })).toBeHidden();
    // The section tabs and the line that says what the open one holds, as before.
    await expect(page.getByText('Preview private outputs, then turn the strongest ones into posts.')).toBeVisible();
  });
});
