import { expect, test, type Page } from '@playwright/test';

/**
 * A signed-out visitor uses the video creator up to Generate (owner, 2026-10-28),
 * signs up there, and comes back to the run they set up.
 *
 * The page used to send a visitor to the login page before drawing anything. Now:
 * - Generate reads "Sign up to generate" and opens the sign-up sheet.
 * - Leaving for Google marks the visitor's draft for the account.
 * - The account's first page takes the draft over.
 * - The welcome credits need a name and a handle, so one card asks for both and
 *   adds the credits in one press.
 * Nothing runs until Generate is pressed again.
 *
 * Google itself is out of reach offline. Its authorize address is answered here
 * with where /auth/callback sends a new account back (`?welcome=1`,
 * `resolvePostAuthPath`), and the E2E bypass cookie stands in for the session the
 * real return makes. Vitest cannot reach the hand-over: it runs through the page's
 * real draft store (IndexedDB) across two page loads.
 */

const PROMPT = 'A paper boat drifting across a sunlit pond, gentle ripples, soft morning light, slow push-in.';
const COLD_PAGE = { timeout: 45_000 };

// Two cold page loads, either of which the dev server can hold for seconds (the fifth gotcha in
// .claude/rules/e2e.md): more than the config's 60 s once both are held on a slow runner.
test.describe.configure({ timeout: 180_000 });

/** Offline the quote cannot be priced, so the page is given one. Returns the quote requests the page has sent. */
async function answerQuote(page: Page, costCredits: number) {
  const asked: unknown[] = [];
  await page.route('**/api/generation-models/quote', async (route) => {
    const request = (route.request().postDataJSON() ?? {}) as { modelId?: string; catalogRevision?: string };
    asked.push(request);
    await route.fulfill({
      json: {
        modelId: request.modelId ?? 'unknown',
        catalogRevision: request.catalogRevision ?? 'unknown',
        normalizedSettings: {},
        costCredits,
      },
    });
  });
  return asked;
}

/** The account's welcome credits and profile, as the routes answer a new account. */
async function answerNewAccount(page: Page) {
  const profile: Record<string, unknown> = { id: 'workflow-user', username: 'creator-a1b2c3d4', displayName: null };
  const sent: Array<{ path: string; body: unknown }> = [];
  await page.route('**/api/credits/welcome', (route) => route.fulfill({
    json: { status: 'not_eligible', amount: 25, credits: 25, identityComplete: false },
  }));
  await page.route('**/api/credits/welcome/claim', (route) => {
    sent.push({ path: '/api/credits/welcome/claim', body: route.request().postDataJSON() });
    return route.fulfill({ json: { status: 'claimed', amount: 25, credits: 50, identityComplete: true } });
  });
  await page.route('**/api/profile/validate', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/profile', (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { username: string; displayName: string };
      sent.push({ path: '/api/profile', body });
      Object.assign(profile, body);
    }
    return route.fulfill({ json: profile });
  });
  return sent;
}

test('a visitor sets up a video, signs up at Generate and comes back to it, with one card for the welcome credits', async ({ page, context }) => {
  const starts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/generations') starts.push(request.url());
  });
  const quotes = await answerQuote(page, 19);

  await page.goto('/create-video', COLD_PAGE);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toBeVisible(COLD_PAGE);
  await expect(page.getByText('Try it before you sign up')).toBeVisible();
  // What a new account starts with, under the bar (the server stub's welcome grant).
  await expect(page.locator('[data-creator-bar-note]')).toContainText('New accounts get 25 free credits');
  // Typed and pressed only once the page's script runs (the fifth gotcha in .claude/rules/e2e.md). All
  // of the above is in the server's HTML, the price under the bar too (the server's own, for the run
  // the page opens on), so the sign is the page's own quote request, which only its script sends.
  await expect.poll(() => quotes.length, { ...COLD_PAGE, message: 'the page asks for its quote once its script runs' }).toBeGreaterThan(0);
  await prompt.fill(PROMPT);

  await page.getByRole('button', { name: 'Sign up to generate' }).click();
  const sheet = page.getByRole('dialog', { name: 'Continue to generate' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('New here? You get 25 free credits when you pick a name and handle, enough for this 19-credit run.');
  await expect(sheet.getByText('Your prompt stays')).toBeVisible();

  let authorizeUrl: URL | null = null;
  await page.route('https://example.supabase.co/auth/v1/authorize**', (route) => {
    authorizeUrl = new URL(route.request().url());
    // Where /auth/callback sends a new account that signed up from the sheet: its `next`
    // (the creator with the hand-over nonce) with the welcome flag (resolvePostAuthPath).
    const next = new URL(authorizeUrl.searchParams.get('redirect_to') ?? '').searchParams.get('next') ?? '/';
    return route.fulfill({ status: 302, headers: { location: new URL(`${next}&welcome=1`, page.url()).toString() } });
  });
  // Signed in from here on: the bypass's account is a new one, as far as these routes say.
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  const sent = await answerNewAccount(page);

  await sheet.getByRole('button', { name: 'Continue with Google' }).click();

  await expect(page.getByRole('heading', { name: 'Pick your name and handle' })).toBeVisible(COLD_PAGE);
  expect(authorizeUrl).not.toBeNull();
  const redirectTo = new URL(authorizeUrl!.searchParams.get('redirect_to') ?? '');
  expect(authorizeUrl!.searchParams.get('provider')).toBe('google');
  expect(redirectTo.pathname).toBe('/auth/callback');
  expect(redirectTo.searchParams.get('next')).toMatch(/^\/create-video\?handover=[A-Za-z0-9-]{8,64}$/);

  // The visitor's prompt, taken over by the account, and the flag gone from the address.
  await expect(prompt).toHaveValue(PROMPT);
  await expect(page).toHaveURL(/\/create-video$/);
  await expect(page.getByLabel('Display name')).toHaveValue('Workflow User');

  await page.getByRole('button', { name: 'Save and add 25 credits' }).click();

  await expect(page.getByRole('heading', { name: 'You’re in: 25 free credits added' })).toBeVisible();
  expect(sent.map((call) => call.path)).toEqual(['/api/profile', '/api/credits/welcome/claim']);
  expect(sent[1].body).toEqual({ sourceSurface: 'web' });
  // Generate is the account's now, priced, and nothing has run.
  await expect(page.getByRole('button', { name: 'Generate · 19 credits' })).toBeEnabled();
  expect(starts).toEqual([]);
  // The mark is spent: another page of this creator keeps the account's own draft.
  expect(await page.evaluate(() => window.localStorage.getItem('magicbooklet:creator-draft-handover'))).toBeNull();
});
