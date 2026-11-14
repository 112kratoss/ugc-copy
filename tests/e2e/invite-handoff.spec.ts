import { expect, test, type Page } from '@playwright/test';

import creator from './fixtures/creator-profile.json';
import recipePost from './fixtures/post-with-recipe.json';

// A shared profile link carries its sharer's invite (`?r=<code>`). A visitor with no account
// who opens one is offered the way to keep it on the device they are on (the cross-device
// plan, 2026-11-10; `src/components/InviteHandoffBar.tsx`). The app in both stores keeps a
// handed-over invite since 0.1.9 (switched on 2026-11-14, `INVITE_APP_HANDOFF_LIVE`), so a
// phone is offered the app first: Play with the invite as the install referrer, and on an
// iPhone the invite's link copied before the App Store opens; joining here comes second. A
// laptop gets a QR code. The page with the switch off (joining here first, the phone's own
// browser from inside another app's) is the rollback, held by invite-handoff-bar.test.tsx.
//
// The creator is the server stub's (support/supabase-server-stub.cjs); the visit route is
// answered here, as the server would for a code it knows.

const CODE = '30b5f916c7aa';
const COLD_PAGE = { timeout: 45_000 };
const PROFILE = `/creators/${creator.username}`;

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.31.90',
  androidChrome: 'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
};
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

test.describe.configure({ timeout: 180_000 });

async function answerVisit(page: Page) {
  const visits: Array<Record<string, unknown>> = [];
  await page.route('**/api/referrals/visit', async (route) => {
    visits.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: { success: true, code: CODE, preserved: false, program: null } });
  });
  return visits;
}

const offer = (page: Page) => page.getByRole('complementary', { name: 'Your invite' });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test.describe('on an iPhone', () => {
  test.use({ userAgent: UA.iphoneSafari, ...PHONE });

  test('a shared profile link offers the app first, above the page, and loses its code from the address', async ({ page }) => {
    const visits = await answerVisit(page);
    await page.goto(`${PROFILE}?s=creator-profile&r=${CODE}`);

    await expect(offer(page).getByText('Get the app and keep your invite')).toBeVisible(COLD_PAGE);
    await expect(offer(page).getByText('Whoever invited you may earn bonus credits if you join.')).toBeVisible();
    await expect(offer(page).getByRole('button', { name: 'Get the app' })).toBeVisible();
    await expect(offer(page).getByRole('link', { name: 'or join here' })).toHaveAttribute('href', `/login?mode=signup&next=${encodeURIComponent(PROFILE)}`);
    await expect(offer(page).getByText(/^Preview:/)).toHaveCount(0);
    expect(visits).toEqual([{ code: CODE, source: 'web', kind: 'shared_link', next: PROFILE }]);
    expect(new URL(page.url()).search).toBe('?s=creator-profile');

    // Above the profile, in the page's flow: nothing of the page is under it.
    const offerBox = await offer(page).boundingBox();
    const headingBox = await page.getByRole('heading', { level: 1 }).first().boundingBox();
    expect(offerBox!.y + offerBox!.height).toBeLessThanOrEqual(headingBox!.y);
    expect(offerBox!.width).toBeLessThanOrEqual(390);

    // A reload opens the page without the code and still offers it; Close puts it away for the tab.
    await page.reload();
    await expect(offer(page).getByText('Get the app and keep your invite')).toBeVisible(COLD_PAGE);
    await offer(page).getByRole('button', { name: 'Close' }).click();
    await expect(offer(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible(COLD_PAGE);
    await expect(offer(page)).toHaveCount(0);
  });

  test('a shared post link draws the offer above the post, and its Close takes the tap', async ({ page }) => {
    const visits = await answerVisit(page);
    const postPath = `/showcase/${recipePost.post.id}`;
    await page.goto(`${postPath}?s=feed&r=${CODE}`);

    await expect(offer(page).getByText('Get the app and keep your invite')).toBeVisible(COLD_PAGE);
    await expect(offer(page).getByRole('link', { name: 'or join here' })).toHaveAttribute('href', `/login?mode=signup&next=${encodeURIComponent(postPath)}`);
    expect(visits).toEqual([{ code: CODE, source: 'web', kind: 'shared_link', next: postPath }]);

    const offerBox = (await offer(page).boundingBox())!;
    const titleBox = (await page.getByRole('heading', { level: 1 }).first().boundingBox())!;
    expect(offerBox.y + offerBox.height).toBeLessThanOrEqual(titleBox.y);
    // Drawn over the page's backdrop, and pressable.
    await offer(page).getByRole('button', { name: 'Close' }).click();
    await expect(offer(page)).toHaveCount(0);
  });

  test('Get the app copies the invite’s link and only then opens the App Store', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await answerVisit(page);
    // The App Store's page, answered here: what it is handed is all this test reads of it.
    await page.route('https://apps.apple.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>App Store</title>' }));
    await page.goto(`${PROFILE}?s=creator-profile&r=${CODE}`);

    await expect(offer(page).getByText('Get the app and keep your invite')).toBeVisible(COLD_PAGE);
    await expect(offer(page).getByText('This copies your invite link. After installing, open the app and tap Paste to keep it.')).toBeVisible();
    const siteOrigin = new URL(page.url()).origin;
    await offer(page).getByRole('button', { name: 'Get the app' }).click();

    await page.waitForURL('https://apps.apple.com/app/id6773286115');
    // Read on the store's page: the link was on the clipboard before the page was left.
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(`${siteOrigin}${PROFILE}?r=${CODE}`);
  });
});

test.describe('on an Android phone', () => {
  test.use({ userAgent: UA.androidChrome, ...PHONE });

  test('Get the app is the Play listing with the invite as its install referrer', async ({ page }) => {
    await answerVisit(page);
    await page.goto(`${PROFILE}?s=creator-profile&r=${CODE}`);

    const getTheApp = offer(page).getByRole('link', { name: 'Get the app' });
    await expect(getTheApp).toBeVisible(COLD_PAGE);
    const href = new URL((await getTheApp.getAttribute('href'))!);
    expect(`${href.origin}${href.pathname}`).toBe('https://play.google.com/store/apps/details');
    expect(href.searchParams.get('id')).toBe('com.magicbooklet.mobile');
    expect(href.searchParams.get('referrer')).toBe(
      `utm_source=magicbooklet-invite&utm_medium=invite&utm_content=shared_link&mb_r=${CODE}&mb_p=${encodeURIComponent(PROFILE)}`,
    );
  });
});

test.describe('inside Instagram on an iPhone', () => {
  test.use({ userAgent: UA.iphoneInstagram, ...PHONE });

  test('the page offers the app, points the web sign-up at Safari, and keeps the code on the address for it', async ({ page }) => {
    await answerVisit(page);
    await page.goto(`${PROFILE}?s=creator-profile&r=${CODE}`);

    await expect(offer(page).getByText('Get the app and keep your invite')).toBeVisible(COLD_PAGE);
    await expect(offer(page).getByRole('button', { name: 'Get the app' })).toBeVisible();
    await expect(offer(page).getByRole('link', { name: 'or join here' })).toHaveCount(0);
    await expect(offer(page).getByText(/To join on the web instead/)).toBeVisible();
    expect(new URL(page.url()).searchParams.get('r')).toBe(CODE);
  });
});

test.describe('on a laptop', () => {
  test('Get the app shows a QR code of the page with the invite on it', async ({ page }) => {
    await answerVisit(page);
    await page.goto(`${PROFILE}?s=creator-profile&r=${CODE}`);

    await expect(offer(page).getByText('On your phone? Take your invite with you')).toBeVisible(COLD_PAGE);
    await offer(page).getByRole('button', { name: 'Get the app' }).click();
    const sheet = page.getByRole('dialog', { name: 'Scan to open this on your phone' });
    await expect(sheet).toBeVisible();
    const code = sheet.getByRole('img', { name: 'QR code for this page, with your invite' });
    await expect(code).toBeVisible();
    // A square of dark modules on white, with room to scan.
    const box = await code.boundingBox();
    expect(Math.abs(box!.width - box!.height)).toBeLessThan(2);
    expect(box!.width).toBeGreaterThan(180);
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toHaveCount(0);
  });

  test('the invite landing makes the same offer once its invite is saved', async ({ page }) => {
    const visits = await answerVisit(page);
    await page.goto(`/r/${CODE}`);

    await expect(page.getByText('Invite ready')).toBeVisible(COLD_PAGE);
    await expect(page.getByText('On your phone? Take your invite with you')).toBeVisible();
    // An invite link's own visit, not a shared link's (the dev server's strict mode sends it twice).
    expect(visits.length).toBeGreaterThan(0);
    for (const visit of visits) expect(visit).toEqual({ code: CODE, source: 'web', next: '/create' });
    await page.getByRole('button', { name: 'Get the app' }).click();
    await expect(page.getByRole('dialog', { name: 'Scan to open this on your phone' })).toBeVisible();
  });
});
