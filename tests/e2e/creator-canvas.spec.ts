import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

/**
 * The video creator's canvas through a run (PR 3a of the redesign, owner 2026-10-28; the
 * artboards Generating, Failed and Result):
 * - a run at work names its settings and the credits it holds, promises the alert a
 *   finished run sends, and says the page can be left;
 * - a failed run names its cause, says the credits are back, and offers the same run again;
 * - a finished run says Done, and the focus moves there (the build notes).
 *
 * The E2E account holds 25 credits. Offline nothing can be priced or started, so the quotes,
 * the start and the run's status are answered here; the client signs in with a made-up
 * session (as creator-profile-editor.spec.ts does) because a start reads the browser's own.
 * Requests left to the dev server go without that session's token, which its proxy refuses.
 * The start posts come from the server's shelf, which reads nothing offline: they are
 * covered by the unit suites.
 */

const COLD_PAGE = { timeout: 45_000 };
const PROMPT = 'A paper boat drifting across a sunlit pond, gentle ripples, soft morning light, slow push-in.';
const PHONE = { width: 390, height: 844 };

test.describe.configure({ timeout: 180_000 });

function base64url(value: string) {
  return Buffer.from(value).toString('base64url');
}

// The E2E user (src/lib/e2e-auth.ts) as Supabase's auth describes them to the browser.
const user = {
  id: 'workflow-user',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'workflow-user@example.com',
  is_anonymous: false,
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
const session = {
  access_token: [
    base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64url(JSON.stringify({
      sub: user.id, aud: 'authenticated', role: 'authenticated', exp: EXPIRES_AT,
      email: user.email, is_anonymous: false, session_id: 'e2e-session',
    })),
    'e2e-signature',
  ].join('.'),
  token_type: 'bearer',
  expires_in: 365 * 24 * 3600,
  expires_at: EXPIRES_AT,
  refresh_token: 'e2e-refresh-token',
  user,
};

async function signIn(context: BrowserContext) {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  const cookie = `sb-example-auth-token=base64-${base64url(JSON.stringify(session))}`;
  await context.addInitScript((value) => {
    document.cookie = `${value}; path=/; SameSite=Lax`;
  }, cookie);
  await context.route('https://example.supabase.co/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') return route.fulfill({ json: user });
    if (pathname === '/auth/v1/token') return route.fulfill({ json: session });
    if (pathname === '/rest/v1/profiles') {
      const row = { display_name: 'E2E Creator', avatar_url: null, credits: 25 };
      const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
      return route.fulfill({ json: single ? row : [row] });
    }
    // The page's look for a run already under way on load: none.
    if (pathname.startsWith('/rest/v1/')) {
      const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
      return route.fulfill(single ? { status: 406, json: {} } : { json: [] });
    }
    return route.fulfill({ status: 404, json: {} });
  });
}

type Run = { kind?: string; modelId?: string; catalogRevision?: string; settings?: Record<string, unknown> };

/** Production's Seedance 2 Mini (release mini-default-video-20261028); 14 a second for any other video. */
function priceOf(run: Run) {
  const seconds = Number(run.settings?.duration ?? 5);
  if (run.kind === 'image') return run.modelId === 'z-image' ? 1 : 8;
  if (run.modelId === 'seedance-2-mini') return ({ 4: 16, 5: 19, 6: 23 } as Record<number, number>)[seconds] ?? 4 * seconds;
  return 14 * seconds;
}

type StatusAnswer = Record<string, unknown>;

/**
 * Answers what the page asks of the API: both quote routes, the start (19 credits held), and the
 * run's status from `status`, which may hold its answer back. Anything else goes on to the dev
 * server without the made-up session's token.
 */
async function answerApi(page: Page, status: (route: Route) => Promise<void> | void) {
  await page.route('**/api/**', (route) => {
    const headers = { ...route.request().headers() };
    delete headers.authorization;
    return route.continue({ headers });
  });
  const quote = (run: Run) => ({
    modelId: run.modelId ?? 'unknown',
    catalogRevision: run.catalogRevision ?? 'unknown',
    normalizedSettings: run.settings ?? {},
    costCredits: priceOf(run),
  });
  await page.route('**/api/generation-models/quote', (route) => route.fulfill({ json: quote(route.request().postDataJSON() as Run) }));
  await page.route('**/api/generation-models/quotes', (route) => {
    const { quotes } = route.request().postDataJSON() as { quotes: Run[] };
    return route.fulfill({ json: { quotes: quotes.map((run) => ({ ok: true, quote: quote(run) })) } });
  });
  await page.route('**/api/generations**', (route) => (route.request().method() === 'POST'
    ? route.fulfill({
      json: {
        success: true,
        predictionId: 'pred-e2e',
        generationId: 'gen-e2e',
        status: 'processing',
        remainingCredits: 6,
        cost: 19,
        catalogRevision: 'e2e',
        modelId: 'seedance-2-mini',
      },
    })
    : route.fulfill({ json: { generations: [] } })));
  await page.route('**/api/generate-video?id=**', status);
  // The finished clip: no file offline, and the canvas says Done all the same.
  await page.route('https://cdn.example.test/**', (route) => route.fulfill({ status: 404, body: '' }));
}

const answer = (body: StatusAnswer) => (route: Route) => route.fulfill({ json: body });

async function startRun(page: Page) {
  await page.goto('/create-video', COLD_PAGE);
  // Typed only once the page's script runs, or hydration resets the field.
  await expect(page.getByRole('button', { name: 'Generate · 19 credits' })).toBeVisible(COLD_PAGE);
  await page.getByRole('textbox', { name: 'Prompt' }).fill(PROMPT);
  await page.getByRole('button', { name: 'Generate · 19 credits' }).click();
}

function canvas(page: Page) {
  return page.getByRole('region', { name: 'Result' });
}

test('a run at work says what it holds and promises the alert, then says Done and takes the focus', async ({ page, context }) => {
  await signIn(context);
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await answerApi(page, async (route) => {
    await held;
    await route.fulfill({ json: { status: 'succeeded', output: 'https://cdn.example.test/boat.mp4', timing: null } });
  });

  await startRun(page);

  await expect(canvas(page).getByRole('heading', { name: 'Making your video' })).toBeVisible();
  await expect(canvas(page).getByTestId('creator-canvas-chip')).toHaveText('Seedance 2 Mini · 480P · 16:9 · 5s · Sound off · 19 credits');
  await expect(canvas(page)).toContainText('19 credits are held for this run. If it fails, they come back.');
  await expect(canvas(page)).toContainText('you’ll get an alert when it’s ready');

  release!();
  const done = canvas(page).getByRole('heading', { name: 'Done' });
  await expect(done).toBeVisible();
  await expect(done).toBeFocused();
  await expect(canvas(page).getByTestId('creator-canvas-chip')).toHaveText('Seedance 2 Mini · 480P · 16:9 · 5s · Sound off · 19 credits');
  await expect(canvas(page).getByRole('link', { name: /Download video/ })).toBeVisible();
  await expect(canvas(page)).toContainText(PROMPT);
});

test('a failed run names its cause on the canvas, says the credits are back and offers it again, on a phone', async ({ page, context }) => {
  await page.setViewportSize(PHONE);
  await signIn(context);
  await answerApi(page, answer({ status: 'failed', error: 'Unknown error' }));

  await startRun(page);

  const alert = canvas(page).getByRole('alert');
  await expect(alert).toContainText('The model’s service stopped before your video was done.');
  await expect(alert).toContainText('Your 19 credits are back.');
  const heading = canvas(page).getByRole('heading', { name: 'It didn’t finish' });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await expect(canvas(page).getByRole('button', { name: 'Try again · 19 credits' })).toBeVisible();
  // Said once: not again over the column's bar.
  await expect(page.getByText('The model’s service stopped before your video was done.')).toHaveCount(1);

  await canvas(page).getByRole('button', { name: 'Change the prompt' }).click();
  await expect(canvas(page).getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused();
});

// Under the column the canvas can be out of view: a creator at the next prompt hears of the failure from the bar.
test('a failed run is said in the bar on a phone, and See why brings the canvas into view with the focus', async ({ page, context }) => {
  await page.setViewportSize(PHONE);
  await signIn(context);
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await answerApi(page, async (route) => {
    await held;
    await route.fulfill({ json: { status: 'failed', error: 'Unknown error' } });
  });

  await startRun(page);
  await expect(canvas(page).getByRole('heading', { name: 'Making your video' })).toBeVisible();
  // Back at the prompt, typing the next run, while this one works.
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  release!();

  const line = page.getByText('Your run didn’t finish. Your 19 credits are back.', { exact: false });
  await expect(line).toBeVisible();
  await expect(prompt).toBeFocused();
  await expect(canvas(page).getByRole('heading', { name: 'It didn’t finish' })).not.toBeInViewport();

  await page.getByRole('button', { name: 'See why' }).click();
  const heading = canvas(page).getByRole('heading', { name: 'It didn’t finish' });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
});
