import { expect, test, type Page } from '@playwright/test';

// Five small phone-layout defects from the live sweep of 2026-11-17, each measured at the widths a
// phone has (320, 360, 375, 390, 414):
// - The top bar's page title was cut to "Crea…" on /creators/magicbooklet: the "Sign in" pill takes the
//   room. On a phone a title is drawn whole or not at all, since every page has a heading of its own;
//   from 640px it keeps its ellipsis and is never dropped (the left cluster shares the row with the
//   search field there and is often a few pixels wide, so dropping it would make the page nameless).
// - Marketplace's search placeholder read "Search prompts, tools, creat".
// - /contact's footer links were 20px tall, and Marketplace's "Filter tools" box focused only on its
//   19px input, not on a tap in the rest of the box.
// - /login held a second, hidden and empty <h1>, the email form's title while the choices show.

const WIDTHS = [320, 360, 375, 390, 414];
const WIDE_WIDTHS = [640, 768, 1024, 1180, 1280, 1440];
const COLD_PAGE = { timeout: 45_000 };

test.describe.configure({ timeout: 180_000 });

type TitleRead = {
  text: string;
  /** Whether the whole title is inside the box it is drawn in. */
  whole: boolean;
  /** Whether it is left out of sight entirely (no part of it shows). */
  gone: boolean;
  clientWidth: number;
  scrollWidth: number;
  docOverflow: number;
};

function readTitle(page: Page): Promise<TitleRead | null> {
  return page.evaluate(() => {
    const box = document.querySelector('header.app-shell-header [data-app-shell-title]');
    if (!box) return null;
    const label = box.querySelector('span:not([aria-hidden])') ?? box;
    const text = label.textContent?.trim() ?? '';
    const range = document.createRange();
    range.selectNodeContents(label);
    const rect = range.getBoundingClientRect();
    const frame = box.getBoundingClientRect();
    const slack = 0.75;
    const whole = rect.left >= frame.left - slack && rect.right <= frame.right + slack
      && rect.top >= frame.top - slack && rect.bottom <= frame.bottom + slack;
    const gone = rect.left >= frame.right - slack || rect.top >= frame.bottom - slack || frame.width < 1;
    const style = getComputedStyle(box);
    const clipped = style.visibility === 'hidden' || style.display === 'none';
    return {
      text,
      whole: whole && !clipped,
      gone: gone || clipped,
      clientWidth: (box as HTMLElement).clientWidth,
      scrollWidth: (box as HTMLElement).scrollWidth,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

/** Every page the sweep reads, with the title its top bar names: each must be read, at every width. */
const TITLES: Record<string, string> = {
  '/creators/magicbooklet': 'Creator',
  '/contact': 'Contact',
  '/blog': 'Blog',
  '/alternatives': 'Compare',
  '/ai-image-generator': 'AI image generator',
  '/ai-video-generator': 'AI video generator',
  '/ai-motion-transfer': 'Motion transfer',
  '/marketplace/not-a-page': 'Marketplace',
};
const TITLE_PAGES = Object.keys(TITLES);

const base64Url = (text: string) => Buffer.from(text).toString('base64url');

/**
 * A signed-in reader as a browser holds one: a session cookie for the placeholder project (the E2E
 * bypass cookie leaves the shell signed out), whose user and balance the page asks Supabase for and
 * are answered here (`marketplace-keeps-place.spec.ts` draws its reader the same way).
 */
async function signInReader(page: Page, origin: string) {
  const user = {
    id: 'e2e-phone-reader', aud: 'authenticated', role: 'authenticated', email: 'phone-reader@example.com',
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { name: 'Phone Reader' },
    identities: [], is_anonymous: false, created_at: '2026-01-01T00:00:00.000Z',
  };
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ sub: user.id, exp: 4_102_444_800, role: 'authenticated', aud: 'authenticated' }));
  const session = {
    access_token: `${header}.${payload}.c2lnbmF0dXJl`, refresh_token: 'e2e-refresh-token', token_type: 'bearer',
    expires_in: 3600, expires_at: 4_102_444_800, user,
  };
  await page.context().addCookies([
    { name: 'sb-example-auth-token', value: `base64-${base64Url(JSON.stringify(session))}`, url: origin },
    { name: 'mb_name_step_shown', value: user.id, url: origin },
  ]);
  await page.context().route('https://example.supabase.co/auth/v1/user*', (route) => route.fulfill({ json: user }));
  await page.context().route('https://example.supabase.co/rest/v1/profiles*', async (route) => {
    const row = { credits: 617, promotional_credits: 0, saver_notice_seen_at: null, display_name: 'Phone Reader', avatar_url: null };
    const accept = route.request().headers().accept ?? '';
    await route.fulfill({ json: accept.includes('vnd.pgrst.object') ? row : [row] });
  });
}

/**
 * The page's own script has run and the fonts are in, so the row has its final widths: the signed-in
 * credits pill (drawn once the session check answers), or, for a visitor, hydration's commit and then
 * the "Sign in" pill (the shell draws a narrower placeholder until the session check answers); then
 * the fonts, then two reads of the bar's pieces a moment apart that agree.
 */
async function settle(page: Page, signedIn: boolean) {
  await page.locator('header.app-shell-header').waitFor(COLD_PAGE);
  if (signedIn) {
    await page.locator('header a[href="/pricing"][aria-label$=" credits"]').first().waitFor(COLD_PAGE);
  } else {
    // React has committed the document's hydration (the root no longer marks its tree dehydrated, as
    // login-typed-before-script.spec.ts reads it). A dev-server reload can land mid-poll: that read is retried.
    await expect.poll(() => page.evaluate(() => {
      type HostRoot = { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } };
      const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
      const root = key ? (document as unknown as Record<string, HostRoot>)[key] : undefined;
      return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
    }).catch(() => false), COLD_PAGE).toBe(true);
    // The pill ("Sign in" or "Sign in for 25 free credits"), which replaces the pending placeholder.
    await page.locator('header a[aria-label^="Sign in"]').first().waitFor(COLD_PAGE);
  }
  await page.evaluate(() => document.fonts.ready);
  // Two reads of the bar's pieces 250ms apart that agree: nothing is still moving (a dev-server
  // reload mid-read is just another read).
  const reads: string[] = [];
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const now = await page.locator('header.app-shell-header').evaluate((header) => (
      [...header.querySelectorAll('[data-app-shell-title], :scope > div > *')].map((element) => Math.round(element.getBoundingClientRect().width)).join(',')
    )).catch(() => '');
    reads.push(now);
    if (now && reads.length > 1 && reads[reads.length - 2] === now) return;
    await page.waitForTimeout(250);
  }
  expect(reads, 'the top bar never stopped changing').toEqual([]);
}

for (const signedIn of [false, true]) {
  for (const width of [...WIDTHS, ...WIDE_WIDTHS]) {
    const phone = width < 640;
    test(`top bar title, ${signedIn ? 'signed in' : 'signed out'}, ${width}px: ${phone ? 'whole or not drawn' : 'on its own line, as before'}`, async ({ page, baseURL }) => {
      if (signedIn) await signInReader(page, baseURL!);
      await page.setViewportSize({ width, height: 812 });
      const problems: string[] = [];
      let wholeOnContact = false;
      const readPages: string[] = [];
      for (const path of TITLE_PAGES) {
        await page.goto(path, { waitUntil: 'domcontentloaded', ...COLD_PAGE });
        await settle(page, signedIn);
        const read = await readTitle(page);
        if (!read) {
          problems.push(`${path}: the top bar has no title box`);
          continue;
        }
        readPages.push(path);
        if (read.text !== TITLES[path]) problems.push(`${path}: the title reads "${read.text}", not "${TITLES[path]}"`);
        if (read.docOverflow > 0) problems.push(`${path}: page scrolls sideways by ${read.docOverflow}px`);
        if (phone) {
          if (!read.whole && !read.gone) problems.push(`${path}: "${read.text}" is cut off (${read.scrollWidth}px of ${read.clientWidth}px)`);
          if (path === '/contact') wholeOnContact = read.whole;
        } else if (read.gone && read.clientWidth > 0 && read.text) {
          // Before this change the title showed from 640px, truncated where it had no room: it is
          // never dropped there, even when the cluster leaves it a few pixels.
          problems.push(`${path}: "${read.text}" is dropped (${read.clientWidth}px of room)`);
        }
      }
      expect(problems).toEqual([]);
      // Every page was read: none dropped out unmeasured.
      expect(readPages).toEqual(TITLE_PAGES);
      // Dropping the title is for a bar with no room: on a phone wide enough, it stays.
      if (phone && width >= 414) expect(wholeOnContact).toBe(true);
    });
  }
}

/** The placeholder of every visible search box of the storefront's own (not the top bar's), measured. */
async function placeholderMisfits(page: Page, width: number) {
  return page.evaluate((at) => {
    const out: string[] = [];
    for (const field of document.querySelectorAll<HTMLInputElement>('main input[type="search"], main input:not([type])')) {
      if (field.getAttribute('role') === 'combobox' || !field.placeholder || field.offsetParent === null) continue;
      const style = getComputedStyle(field);
      const probe = document.createElement('span');
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${style.font};letter-spacing:${style.letterSpacing}`;
      probe.textContent = field.placeholder;
      document.body.appendChild(probe);
      const text = probe.getBoundingClientRect().width;
      probe.remove();
      const room = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (text > room) out.push(`@${at}: "${field.placeholder}" is ${Math.round(text)}px in ${Math.round(room)}px`);
    }
    return out;
  }, width);
}

test.describe('Marketplace on a phone', () => {
  test('its search placeholder fits its field, in the first-paint shell and in the live list', async ({ page }) => {
    const misfits: string[] = [];
    let shell = 0;
    let live = 0;
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 812 });
      await page.context().route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
      await page.goto('/marketplace', { waitUntil: 'domcontentloaded', ...COLD_PAGE });
      // The first-paint shell's box is the one with a name; the live list's has none.
      const shellBox = page.locator('main input[name="q"]:not([role="combobox"])').first();
      await shellBox.waitFor(COLD_PAGE);
      await page.evaluate(() => document.fonts.ready);
      shell += await page.locator('main input[name="q"]:not([role="combobox"]):visible').count();
      misfits.push(...(await placeholderMisfits(page, width)).map((line) => `shell ${line}`));
      // The shell goes live when the reader scrolls (MarketplaceToolFilter): scroll until the list's own box is drawn.
      const liveBox = page.locator('main input[placeholder^="Search"]:not([name]):not([role="combobox"])');
      await expect(async () => {
        await page.mouse.move(width / 2, 400);
        await page.mouse.wheel(0, 2000);
        await expect(liveBox.first()).toBeVisible({ timeout: 1500 });
      }).toPass({ timeout: 40_000 });
      live += await liveBox.count();
      misfits.push(...(await placeholderMisfits(page, width)).map((line) => `live ${line}`));
      // The live list's box (min-w-[190px]) stays inside the window too.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) misfits.push(`live @${width}: the page scrolls sideways by ${overflow}px`);
    }
    expect(shell).toBeGreaterThan(0);
    expect(live).toBeGreaterThan(0);
    expect(misfits).toEqual([]);
  });

  test('"Filter tools" is a target of at least 24px that a tap anywhere in its box focuses', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/marketplace', { waitUntil: 'domcontentloaded', ...COLD_PAGE });
    const summary = page.locator('details summary', { hasText: 'All tools' }).first();
    const filter = page.getByLabel('Filter tools');
    // The page is a shell that goes live when the reader scrolls; the filter box exists only then.
    await expect(async () => {
      await page.mouse.wheel(0, 300);
      await page.mouse.wheel(0, -300);
      if (!(await filter.isVisible())) {
        const filters = page.getByRole('button', { name: 'Filters' });
        if ((await filters.getAttribute('aria-expanded')) !== 'true') await filters.click({ timeout: 2000 });
        const open = await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open);
        if (!open) await summary.click({ timeout: 2000 });
      }
      await expect(filter).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 40_000 });
    const rowOf = () => filter.evaluate((element) => {
      const row = element.parentElement!.getBoundingClientRect();
      return { x: row.x, y: row.y, width: row.width, height: row.height };
    });
    expect((await rowOf()).height).toBeGreaterThanOrEqual(24);
    // The search icon at the box's left, its right end, and the padding above and below the input.
    const spots = [
      (row: Awaited<ReturnType<typeof rowOf>>) => ({ x: row.x + 14, y: row.y + row.height / 2 }),
      (row: Awaited<ReturnType<typeof rowOf>>) => ({ x: row.x + row.width - 6, y: row.y + row.height / 2 }),
      (row: Awaited<ReturnType<typeof rowOf>>) => ({ x: row.x + row.width / 2, y: row.y + 2 }),
      (row: Awaited<ReturnType<typeof rowOf>>) => ({ x: row.x + row.width / 2, y: row.y + row.height - 2 }),
    ];
    for (const [index, spot] of spots.entries()) {
      // The row is measured at the press: the list's hand-over to the interactive one can move it.
      await expect(async () => {
        await filter.evaluate((element) => (element as HTMLInputElement).blur());
        const point = spot(await rowOf());
        await page.mouse.click(point.x, point.y);
        await expect(filter).toBeFocused({ timeout: 1500 });
      }, `a tap at spot ${index}`).toPass({ timeout: 15_000 });
    }
  });
});

test.describe('/contact footer', () => {
  test('its three links are 24px targets and the footer does not move', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/contact', { waitUntil: 'domcontentloaded', ...COLD_PAGE });
    const footer = page.locator('div.border-t.border-zinc-800').last();
    await footer.waitFor(COLD_PAGE);
    const heights: Record<string, number> = {};
    for (const name of ['Terms of Service', 'Privacy Policy', 'Pricing']) {
      const box = await footer.getByRole('link', { name, exact: true }).boundingBox();
      heights[name] = box?.height ?? 0;
    }
    for (const [name, height] of Object.entries(heights)) expect(height, name).toBeGreaterThanOrEqual(24);
    // The footer block is as tall as it was with 20px links (text-sm: a 20px line, a 16px gap, the
    // copyright line and the border's padding).
    const block = await footer.boundingBox();
    expect(block!.height).toBeLessThanOrEqual(125);
  });
});

test.describe('/login', () => {
  for (const url of ['/login', '/login?email=1']) {
    test(`${url} holds one heading level 1`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(url, { waitUntil: 'domcontentloaded', ...COLD_PAGE });
      await page.locator('h1').first().waitFor({ state: 'attached', ...COLD_PAGE });
      await expect(page.getByRole('heading', { level: 1, includeHidden: true })).toHaveCount(1);
      expect(await page.locator('h1').count()).toBe(1);
    });
  }
});
