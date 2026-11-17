import { expect, test, type Locator, type Page } from '@playwright/test';

import creationPost from './fixtures/creation-post.json';
import creator from './fixtures/creator-profile.json';

// The web's share buttons (`PublicShareButton`, `ProfileShareButton`), from a live sweep of
// magicbooklet.com (2026-11-17):
//
// - They went `disabled` while they shared, and a focused button that goes disabled gives the
//   focus up: a keyboard or screen-reader user who pressed Share landed at the top of the page.
//   They stay focusable now, busy (`aria-disabled`) and taking no second press meanwhile, and
//   look as they did.
// - Where the browser's share sheet refused the link, the clipboard was asked next, after the
//   sheet had spent the click's activation, so it refused too ("Write permission denied" in an
//   embedded Chromium; in-app browsers and webviews alike), and the person was told "Sharing
//   failed. Try again." with no way to share at all. The link now comes up to copy by hand,
//   selected in a read-only field, with a Copy link whose press is the person's own again.
//
// The browser's share sheet and clipboard are stand-ins here (`standInSharing`). Both pages are
// drawn signed out; the dev server answers their server reads (support/supabase-server-stub.cjs).

// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };

test.describe.configure({ timeout: 120_000 });

interface SharingStandIn {
  shares: number;
  writes: string[];
  clipboardAllowed: boolean;
  refuseShare: (() => void) | null;
}

const POST_SHARE = /^(Share|Sharing\.\.\.|Try again|Copied link|Shared)$/;
const PROFILE_SHARE = /^(Share profile|Sharing\.\.\.|Try again|Copied link|Shared)$/;

/**
 * A share sheet that stays up until the test closes it and then refuses the link (refused, not
 * dismissed: a dismissal is an AbortError, the person's own no), and a clipboard that refuses a
 * write until the test allows it, as Chromium refuses one whose click the share has spent.
 */
async function standInSharing(page: Page) {
  await page.addInitScript(() => {
    const standIn = { shares: 0, writes: [] as string[], clipboardAllowed: false, refuseShare: null as (() => void) | null };
    (window as unknown as { __sharing: typeof standIn }).__sharing = standIn;
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: () => {
        standIn.shares += 1;
        return new Promise<void>((_resolve, reject) => {
          standIn.refuseShare = () => reject(new DOMException('The share was refused.', 'NotAllowedError'));
        });
      },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (!standIn.clipboardAllowed) throw new DOMException('Write permission denied.', 'NotAllowedError');
          standIn.writes.push(text);
        },
      },
    });
  });
}

function sharing(page: Page) {
  return page.evaluate(() => {
    const standIn = (window as unknown as { __sharing: SharingStandIn }).__sharing;
    return { shares: standIn.shares, writes: [...standIn.writes] };
  });
}

function refuseTheShare(page: Page) {
  return page.evaluate(() => (window as unknown as { __sharing: SharingStandIn }).__sharing.refuseShare?.());
}

function allowTheClipboard(page: Page) {
  return page.evaluate(() => {
    (window as unknown as { __sharing: SharingStandIn }).__sharing.clipboardAllowed = true;
  });
}

/** Signed out, nothing from the browser answered but the share counts, which are kept. */
async function visitSignedOut(page: Page, shareCount: string) {
  const recorded: unknown[] = [];
  const context = page.context();
  await context.route('https://example.supabase.co/**', (route) => route.fulfill({ status: 401, json: {} }));
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await context.route(shareCount, (route) => {
    recorded.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, json: { success: true } });
  });
  return recorded;
}

/**
 * Share pressed from the keyboard, as the people the focus matters to press it. A press before
 * the page's script has taken the server's HTML over is dropped (the fifth gotcha in
 * .claude/rules/e2e.md), so it is pressed until the share sheet has been asked.
 */
async function pressShareFromKeyboard(page: Page, share: Locator) {
  await expect(async () => {
    if ((await sharing(page)).shares === 0) {
      await share.focus({ timeout: 2_000 });
      await page.keyboard.press('Enter');
    }
    expect((await sharing(page)).shares).toBeGreaterThan(0);
  }).toPass(COLD_PAGE);
}

/** Whatever has the focus, by its tag and name, for a message that says where it went. */
function focusedElement(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return 'the page';
    const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 40);
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''} "${name}"`;
  });
}

async function expectFocusKeptThroughTheShare(page: Page, share: Locator) {
  await expect(share).toHaveAccessibleName('Sharing...');
  await expect(share).toHaveAttribute('aria-busy', 'true');
  // Long enough for a browser to have moved the focus off a button that went disabled.
  await page.waitForTimeout(500);
  await expect(share, `the focus stays on Share while it shares (it is on ${await focusedElement(page)})`).toBeFocused();
  // Busy, and still a button the keyboard is on: not disabled. (Playwright's `toBeDisabled` counts
  // `aria-disabled` as disabled, so the property is read.)
  await expect(share).toHaveAttribute('aria-disabled', 'true');
  expect(await share.evaluate((button: HTMLButtonElement) => button.disabled)).toBe(false);

  // A press while it shares asks for no second share sheet.
  const before = (await sharing(page)).shares;
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect((await sharing(page)).shares).toBe(before);
}

test.describe('a post\'s Share', () => {
  test('keeps the focus while it shares, and takes no second press meanwhile', async ({ page }) => {
    await visitSignedOut(page, '**/api/showcase/share');
    await standInSharing(page);
    await page.goto(`/showcase/${creationPost.post.id}`);
    const share = page.getByRole('button', { name: POST_SHARE });
    await expect(share).toBeVisible(COLD_PAGE);

    await pressShareFromKeyboard(page, share);
    await expectFocusKeptThroughTheShare(page, share);
  });

  test('refused by the share sheet and the clipboard, offers the link to copy by hand', async ({ page }, testInfo) => {
    const recorded = await visitSignedOut(page, '**/api/showcase/share');
    await standInSharing(page);
    await page.goto(`/showcase/${creationPost.post.id}`);
    const share = page.getByRole('button', { name: POST_SHARE });
    await expect(share).toBeVisible(COLD_PAGE);
    const link = `${new URL(page.url()).origin}/showcase/${creationPost.post.id}?s=detail-page`;

    await pressShareFromKeyboard(page, share);
    await refuseTheShare(page);

    // The link, selected as the sheet comes up, so a keyboard copies it at once.
    const sheet = page.getByRole('dialog', { name: 'Copy the link' });
    await expect(sheet).toBeVisible();
    const field = sheet.getByRole('textbox', { name: 'Link' });
    await expect(field).toHaveValue(link);
    await expect(field).not.toBeEditable();
    await expect(field).toBeFocused();
    expect(await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, link.length]);
    // Nothing was shared, so nothing is counted.
    expect(recorded).toEqual([]);
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    await page.screenshot({ path: testInfo.outputPath('post-share-copy-by-hand.png'), animations: 'disabled' });

    // Copy link refused too: it says so, and the link is selected again for a copy by hand.
    const copy = sheet.getByRole('button', { name: 'Copy link' });
    await copy.click();
    await expect(sheet.getByText('Copying is blocked here too. Select the link and copy it yourself.')).toBeVisible();
    await expect(field).toBeFocused();
    expect(await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, link.length]);
    expect(recorded).toEqual([]);
    expect((await sharing(page)).writes).toEqual([]);

    // A browser that allows a press of its own copies it: the share is counted once, as a copied link.
    await allowTheClipboard(page);
    await copy.click();
    await expect(sheet).toBeHidden();
    expect((await sharing(page)).writes).toEqual([link]);
    await expect.poll(() => recorded).toEqual([
      { generationId: creationPost.post.id, sourceSurface: 'detail-page', channel: 'copy-link' },
    ]);
    // Back on Share, which says the link is on the clipboard.
    await expect(share).toBeFocused();
    await expect(share).toHaveAccessibleName('Copied link');
  });
});

// A post as the reel reads it (`/api/showcase/posts/<id>`), drawn on the E2E creator's page, the
// one creator page the dev server answers offline.
const REEL_POST = 'e2e5a8e0-0000-4000-8000-0000000000c1';
const reelItem = {
  id: REEL_POST,
  mediaUrl: 'https://cdn.example.test/reel.png',
  mediaKind: 'image',
  model: 'nano-banana-2',
  title: 'Harbour at first light',
  prompt: '',
  body: '',
  category: 'image',
  postFormat: 'media',
  saveCount: 0,
  remixCount: 0,
  commentCount: 0,
  createdAt: '2026-10-01T10:00:00.000Z',
  creator: { id: creator.id, username: creator.username, name: creator.display_name, avatar: null },
  isSaved: false,
  sourceKind: 'magicbooklet',
  sourceTool: null,
  generationId: null,
  canRemix: false,
  visibility: 'public',
  asset: null,
};

// The reel takes Escape, the arrows, swipes and the wheel for itself, and keeps Tab inside it.
test('in the reel, on a phone, the copy-by-hand sheet goes on Escape and leaves the reel open on its Share', async ({ page }, testInfo) => {
  const recorded = await visitSignedOut(page, '**/api/showcase/share');
  await page.route(`**/api/showcase/posts/${REEL_POST}`, (route) => route.fulfill({ json: { item: reelItem } }));
  await page.route('https://cdn.example.test/**', (route) => route.fulfill({ status: 404, body: '' }));
  await standInSharing(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/creators/${creator.username}?post=${REEL_POST}`);
  const reel = page.getByRole('dialog', { name: /reel viewer$/ });
  await expect(reel).toBeVisible(COLD_PAGE);
  const share = reel.getByRole('button', { name: POST_SHARE });
  await expect(share).toBeVisible(COLD_PAGE);

  await pressShareFromKeyboard(page, share);
  await expectFocusKeptThroughTheShare(page, share);
  await refuseTheShare(page);

  const sheet = page.getByRole('dialog', { name: 'Copy the link' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('textbox', { name: 'Link' })).toHaveValue(
    `${new URL(page.url()).origin}/showcase/${REEL_POST}?s=showcase-reel`,
  );
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.screenshot({ path: testInfo.outputPath('reel-share-copy-by-hand-phone.png'), animations: 'disabled' });

  // The sheet's Escape, not the reel's: the sheet goes, the reel stays, back on its Share.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(reel).toBeVisible();
  await expect(share).toBeFocused();
  await expect(share).toHaveAccessibleName('Share');
  expect(recorded).toEqual([]);
});

test.describe('a creator\'s Share profile', () => {
  test('keeps the focus and its look while it shares', async ({ page }) => {
    await visitSignedOut(page, '**/api/profile/share');
    await standInSharing(page);
    await page.goto(`/creators/${creator.username}`);
    // Drawn once the page's script has read the session: the page is live.
    await expect(page.getByRole('button', { name: `More actions for @${creator.username}` })).toBeVisible(COLD_PAGE);
    const share = page.getByRole('button', { name: PROFILE_SHARE });
    await expect(share).toHaveCSS('opacity', '1');
    await expect(share).toHaveCSS('cursor', 'pointer');

    await pressShareFromKeyboard(page, share);
    await expectFocusKeptThroughTheShare(page, share);
    // Dimmed while it shares, as it was disabled, and the arrow the app's disabled buttons show.
    await expect(share).toHaveCSS('opacity', '0.7');
    await expect(share).toHaveCSS('cursor', 'default');
  });

  test('refused by the share sheet and the clipboard, offers the link to copy by hand', async ({ page }) => {
    const recorded = await visitSignedOut(page, '**/api/profile/share');
    await standInSharing(page);
    await page.goto(`/creators/${creator.username}`);
    await expect(page.getByRole('button', { name: `More actions for @${creator.username}` })).toBeVisible(COLD_PAGE);
    const share = page.getByRole('button', { name: PROFILE_SHARE });
    const link = `${new URL(page.url()).origin}/creators/${creator.username}?s=creator-profile`;

    // A press with the pointer this time.
    await share.click();
    await expect(share).toHaveAttribute('aria-busy', 'true');
    await refuseTheShare(page);
    const sheet = page.getByRole('dialog', { name: 'Copy the link' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('textbox', { name: 'Link' })).toHaveValue(link);

    // Put away with Escape: nothing shared, nothing counted, and back on Share profile.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(share).toBeFocused();
    await expect(share).toHaveAccessibleName('Share profile');
    expect(recorded).toEqual([]);

    // Shared again, refused again, and copied this time.
    await allowTheClipboard(page);
    await share.click();
    await refuseTheShare(page);
    // The clipboard, asked after the refusal, takes it now: no sheet.
    await expect(share).toHaveAccessibleName('Copied link');
    await expect(sheet).toHaveCount(0);
    expect((await sharing(page)).writes).toEqual([link]);
    await expect.poll(() => recorded).toEqual([
      { username: creator.username, sourceSurface: 'creator-profile', channel: 'copy-link' },
    ]);
  });
});
