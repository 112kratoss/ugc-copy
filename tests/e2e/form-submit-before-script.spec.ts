import { expect, test, type Page, type Request } from '@playwright/test';

/**
 * A form submitted before the page's script has run never writes what was typed into the
 * address (2026-11-01).
 *
 * The server's HTML draws these forms before any script runs, and until the page's script
 * has run nothing stops Enter in a field from submitting the form the browser's own way. A
 * form with no method submits that way as a GET, which writes every named field into the
 * URL: /login put the password in the address bar, the history and any log that keeps query
 * strings. Each form now posts to its own address, which the server answers with the same
 * page; the address keeps its query, so /login still returns the visitor where they came
 * from.
 *
 * The page's own chunk is held until Enter has been pressed, as in
 * creator-prompt-before-script.spec.ts, so the press always lands on the server's HTML.
 * /admin/login draws its form only where admin access is configured, which this run's env
 * cannot be; src/__tests__/form-submit-method.test.ts holds every form's method in the code.
 */

const COLD_PAGE = { timeout: 45_000 };

type ServerDrawnForm = {
  /** Opened with whatever query the page reads, which a submission must keep. */
  path: string;
  /** What each field is given, by its id; a field left out keeps the value the server drew. */
  typed: Record<string, string>;
  /** The field Enter is pressed in. */
  enterIn: string;
};

const FORMS: ServerDrawnForm[] = [
  {
    path: '/login?redirect=%2Fcreate-image',
    typed: {
      'login-email': 'early-visitor@example.com',
      'login-password': 'typed-before-the-script-5150',
    },
    enterIn: 'login-password',
  },
  {
    // The subject keeps the value the server drew.
    path: '/contact',
    typed: {
      name: 'Early Visitor',
      email: 'early-visitor@example.com',
      message: 'Typed before the page could answer',
    },
    enterIn: 'email',
  },
];

/** Holds the page's own script chunk while `held` is on; every request for it waits. */
async function holdPageChunk(page: Page, pathname: string) {
  let release = () => {};
  let gate: Promise<void> = Promise.resolve();
  const chunk = { requests: 0 };
  await page.route(new RegExp(`/_next/static/chunks/app${pathname}/page\\.js(\\?|$)`), async (route) => {
    chunk.requests += 1;
    await gate;
    // The submission leaves the page this request was for, which can cancel it first.
    await route.continue().catch(() => {});
  });
  return {
    requests: () => chunk.requests,
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
  };
}

function isDocumentRequest(page: Page, request: Request) {
  return request.isNavigationRequest() && request.frame() === page.mainFrame();
}

/** Whether a URL carries a typed value, in its path or its query, encoded or not. */
function carries(url: string, value: string) {
  const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
  return decoded.includes(value);
}

for (const form of FORMS) {
  const pathname = new URL(form.path, 'http://localhost').pathname;

  test(`${pathname}: Enter pressed before the page's script runs keeps what was typed out of the address`, async ({ page }) => {
    test.setTimeout(120_000);
    const addresses: string[] = [];
    page.on('request', (request) => {
      if (isDocumentRequest(page, request)) addresses.push(request.url());
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) addresses.push(frame.url());
    });
    const chunk = await holdPageChunk(page, pathname);

    chunk.hold();
    // No timeout of its own: this can be the run's first request for the route, which waits
    // for its compile, and on a busy machine that outlasts any fixed wait (.claude/rules/e2e.md).
    await page.goto(form.path, { waitUntil: 'commit' });
    await expect(page.locator(`#${form.enterIn}`)).toBeVisible(COLD_PAGE);
    // Else the page's script was never asked for here, and Enter below would reach a live page.
    await expect.poll(chunk.requests, { ...COLD_PAGE, message: 'the page asks for its own chunk, which is held' }).toBeGreaterThan(0);
    for (const [id, value] of Object.entries(form.typed)) {
      await page.locator(`#${id}`).fill(value);
    }

    // The answer comes back at the same address with the same form, so this document is marked
    // to tell the two apart.
    await page.evaluate(() => {
      (window as Window & { submittedFrom?: true }).submittedFrom = true;
    });
    const submission = page.waitForRequest((request) => isDocumentRequest(page, request), COLD_PAGE);
    await page.locator(`#${form.enterIn}`).press('Enter');
    // The browser submits the form itself: no script of the page has run to stop it.
    const submitted = await submission;
    chunk.release();

    for (const value of Object.values(form.typed)) {
      expect(carries(submitted.url(), value), `${submitted.method()} ${submitted.url()} carries "${value}"`).toBe(false);
    }
    expect(submitted.method()).toBe('POST');
    expect(submitted.url()).toBe(new URL(form.path, page.url()).href);
    // The server answers the post with the same page, which replaces the one it came from.
    expect((await submitted.response())?.status()).toBe(200);
    await expect.poll(
      () => page.evaluate(() => !('submittedFrom' in window)).catch(() => false),
      { ...COLD_PAGE, message: 'the answer to the post replaces the page' },
    ).toBe(true);
    await expect(page.locator(`#${form.enterIn}`)).toBeVisible();

    await expect(page).toHaveURL(new URL(form.path, page.url()).href);
    for (const address of [...addresses, page.url()]) {
      for (const value of Object.values(form.typed)) {
        expect(carries(address, value), `${address} carries "${value}"`).toBe(false);
      }
    }
  });
}

test(`/login: once the page's script has run, Enter signs in through it and the browser submits nothing`, async ({ page }) => {
  test.setTimeout(120_000);
  const documents: Request[] = [];
  page.on('request', (request) => {
    if (isDocumentRequest(page, request)) documents.push(request);
  });
  const signIns: unknown[] = [];
  await page.route(/^https:\/\/example\.supabase\.co\/auth\/v1\/token\?grant_type=password$/, async (route) => {
    signIns.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { error: 'invalid_grant', error_description: 'Invalid login credentials' } });
  });

  await page.goto('/login?redirect=%2Fcreate-image');
  const password = page.locator('#login-password');
  // A sign that only the page's script gives: the eye button shows the password. A press
  // on the server's HTML does nothing, so it is pressed until one lands.
  await expect(async () => {
    await page.locator('#login-password ~ button').click();
    await expect(password).toHaveAttribute('type', 'text', { timeout: 1_000 });
  }).toPass(COLD_PAGE);

  await page.locator('#login-email').fill('early-visitor@example.com');
  await password.fill('typed-after-the-script-5150');
  await password.press('Enter');

  await expect.poll(() => signIns.length, { message: 'the page signs in through Supabase' }).toBe(1);
  expect(signIns[0]).toMatchObject({ email: 'early-visitor@example.com', password: 'typed-after-the-script-5150' });
  await expect(page.locator('#auth-error')).toBeVisible();
  expect(documents.map((request) => `${request.method()} ${request.url()}`)).toEqual([
    `GET ${new URL('/login?redirect=%2Fcreate-image', page.url()).href}`,
  ]);
});
