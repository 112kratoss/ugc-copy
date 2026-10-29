import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The video creator's inputs as one choice, frames or references (the artboard Inputs, PR 4 of
 * the creator redesign; the owner's answers of 2026-10-29):
 * - a model that takes both shows one side at a time behind a switch;
 * - a switch that would clear something asks first, in a modal question that keeps the keys
 *   and gives the focus back to the switch, and its yes brings the start image along as a
 *   reference, or the first pictures along as the frames;
 * - "@" in the prompt is offered only while References is on;
 * - a remix's references can be replaced in place, keeping their @handles.
 *
 * What vitest cannot see is checked here: a moved picture's preview still draws in a real
 * browser (a revoked object URL draws nothing), the question's focus and the inert page, and
 * the layout at a phone's width.
 */

const COLD_PAGE = { timeout: 45_000 };
const PHONE = { width: 390, height: 844 };

test.describe.configure({ timeout: 180_000 });

function base64url(value: string) {
  return Buffer.from(value).toString('base64url');
}

// A 4x3 PNG, so a preview that draws has a width to show for it.
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGM4UREFRww4OQB8IhM5G3IQWQAAAABJRU5ErkJggg==',
  'base64',
);
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: PICTURE });

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

/** Signs the browser in with a made-up session (a remix reads its source with the session's token). */
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
    // The restored previews of a remix.
    if (pathname.startsWith('/storage/v1/object/sign/')) return route.fulfill({ contentType: 'image/png', body: PICTURE });
    if (pathname === '/rest/v1/profiles') {
      const row = { display_name: 'E2E Creator', avatar_url: null, credits: 25 };
      const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
      return route.fulfill({ json: single ? row : [row] });
    }
    if (pathname.startsWith('/rest/v1/')) {
      const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
      return route.fulfill(single ? { status: 406, json: {} } : { json: [] });
    }
    return route.fulfill({ status: 404, json: {} });
  });
}

/** Requests left to the dev server go without the made-up session's token, which its proxy refuses. */
async function answerApi(page: Page) {
  await page.route('**/api/**', (route) => {
    const headers = { ...route.request().headers() };
    delete headers.authorization;
    return route.continue({ headers });
  });
}

async function openCreator(page: Page, query: string) {
  await page.goto(`/create-video?${query}`, COLD_PAGE);
  await expect(page.getByRole('group', { name: 'Inputs' })).toBeVisible(COLD_PAGE);
}

function inputs(page: Page) {
  return page.getByRole('group', { name: 'Inputs' });
}

/** Whether an image on the page has drawn: a revoked object URL leaves it with no width. */
async function drawn(page: Page, alt: string) {
  return page.getByAltText(alt, { exact: true }).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0);
}

test('a switch that would clear the start image asks first, keeps the keys, and gives the focus back', async ({ page, context }) => {
  await signIn(context);
  await answerApi(page);
  await openCreator(page, 'model=seedance-2-5');

  await expect(inputs(page).getByRole('radio', { name: 'Frames' })).toBeChecked();
  await page.locator('#video-start-frame-input').setInputFiles(png('start.png'));
  await expect(page.getByAltText('Start image', { exact: true })).toBeVisible();
  await expect.poll(() => drawn(page, 'Start image')).toBe(true);

  // From the keyboard: Tab to the switch, an arrow to References.
  await inputs(page).getByRole('radio', { name: 'Frames' }).focus();
  await page.keyboard.press('ArrowRight');

  const dialog = page.getByRole('alertdialog', { name: 'Switch to references?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Seedance 2.5 takes frames or references, not both. Your start image can come with you as a reference.');
  await expect(dialog.getByRole('button', { name: 'Keep frames' })).toBeFocused();
  // Tab stays in the question.
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Move start.png to references' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Keep frames' })).toBeFocused();
  // The page beneath takes no press.
  expect(await page.evaluate(() => (document.querySelector('main')?.closest('[inert]') ?? null) !== null)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(inputs(page).getByRole('radio', { name: 'Frames' })).toBeChecked();
  await expect(inputs(page).getByRole('radio', { name: 'Frames' })).toBeFocused();
  await expect(page.getByAltText('Start image', { exact: true })).toBeVisible();

  // Asked again and answered yes, the start image comes along as a reference and still draws.
  await inputs(page).getByText('References', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Move start.png to references' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(inputs(page).getByRole('radio', { name: 'References' })).toBeChecked();
  await expect(inputs(page).getByRole('radio', { name: 'References' })).toBeFocused();
  await expect(inputs(page).getByRole('button', { name: 'Insert @element_1' })).toBeVisible();
  await expect.poll(() => drawn(page, 'Element 1')).toBe(true);
  await expect(page.locator('#video-start-frame-input')).toHaveCount(0);
  await expect(inputs(page)).toContainText('Type @ in the prompt, or tap a handle, to use a reference. 1 of 30.');
});

test('going back to frames asks the mirror question and brings the first pictures along; "@" waits for References', async ({ page, context }) => {
  await signIn(context);
  await answerApi(page);
  await openCreator(page, 'model=seedance-2-5');

  // Under Frames, "@" in the prompt offers nothing.
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('A harbour at dusk with @');
  await expect(page.getByText('Insert reference', { exact: true })).toHaveCount(0);

  await inputs(page).getByText('References', { exact: true }).click();
  await expect(inputs(page).getByRole('radio', { name: 'References' })).toBeChecked();
  await prompt.fill('A harbour at dusk with @h');
  await expect(page.getByText('Insert reference', { exact: true })).toBeVisible();
  await prompt.fill('A harbour at dusk.');

  await inputs(page).locator('input[type="file"][accept="image/*"][multiple]').setInputFiles([png('hero.png'), png('prop.png'), png('extra.png')]);
  await expect(inputs(page).getByPlaceholder('Rename element')).toHaveCount(3);

  await inputs(page).getByText('Frames', { exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Switch to frames?' });
  await expect(dialog).toContainText('@element_1 and @element_2 can come with you as the start and end images. The other reference is cleared.');
  await dialog.getByRole('button', { name: 'Move both to frames' }).click();

  await expect(inputs(page).getByRole('radio', { name: 'Frames' })).toBeChecked();
  await expect(inputs(page).getByPlaceholder('Rename element')).toHaveCount(0);
  await expect.poll(() => drawn(page, 'Start image')).toBe(true);
  await expect.poll(() => drawn(page, 'End image')).toBe(true);
  await expect(inputs(page)).toContainText('Seedance 2.5 starts from the first image and ends on the last one you set.');
});

test('a remix’s reference is replaced in place, keeping its @handle', async ({ page, context }) => {
  const kept = (place: string) => `generation_inputs/owner-1/gen-1/${place}-reference_image.png`;
  const bundle = {
    generation: { id: 'gen-1', title: 'Harbour', prompt: '@lead walks past @prop at dusk', category: 'video', model: 'seedance-2-mini' },
    result: { mediaType: 'video', url: null },
    inputs: {
      video: {
        referenceMode: 'elements',
        startFrame: null,
        endFrame: null,
        elements: [
          { id: 'remix-00', displayName: 'Hero shot', handle: '@lead', url: `https://example.supabase.co/storage/v1/object/sign/${kept('00')}?token=t`, storagePath: kept('00'), sourceGenerationId: 'gen-1' },
          { id: 'remix-01', displayName: 'Umbrella', handle: '@prop', url: `https://example.supabase.co/storage/v1/object/sign/${kept('01')}?token=t`, storagePath: kept('01'), sourceGenerationId: 'gen-1' },
        ],
        referenceVideos: [],
        referenceAudios: [],
      },
    },
    workflowSettings: { model: 'seedance-2-mini', referenceMode: 'elements', duration: 5, aspectRatio: '16:9' },
    restoreIssues: [],
  };
  await signIn(context);
  await answerApi(page);
  await page.route('**/api/remix-source*', (route) => route.fulfill({ json: bundle }));
  await page.goto('/create-video?remix=gen-1&remixPost=post-1', COLD_PAGE);

  await expect(inputs(page).getByRole('radio', { name: 'References' })).toBeChecked(COLD_PAGE);
  await expect(inputs(page)).toContainText('Replace the photos to make it yours. Each keeps its @handle, so the prompt still works. 2 of 5.');
  const original = await page.getByAltText('Hero shot', { exact: true }).getAttribute('src');

  const chooser = page.waitForEvent('filechooser');
  await inputs(page).getByRole('button', { name: 'Replace @lead with your own photo' }).click();
  await (await chooser).setFiles(png('mine.png'));

  await expect(page.getByAltText('Hero shot', { exact: true })).not.toHaveAttribute('src', original ?? '');
  await expect.poll(() => drawn(page, 'Hero shot')).toBe(true);
  await expect(inputs(page).getByRole('button', { name: 'Insert @lead' })).toBeVisible();
  await expect(inputs(page).getByRole('button', { name: 'Replace @lead with your own photo' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('@lead walks past @prop at dusk');
});

test('on a phone the switch fits its card and the question is a sheet along the bottom', async ({ page, context }) => {
  await page.setViewportSize(PHONE);
  await signIn(context);
  await answerApi(page);
  await openCreator(page, 'model=seedance-2-5');

  const switcher = inputs(page).getByRole('group', { name: 'Start from frames or references' });
  await expect(switcher).toBeVisible();
  const box = await switcher.boundingBox();
  const card = await inputs(page).boundingBox();
  expect(box && card && box.x + box.width <= card.x + card.width + 1).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);

  await page.locator('#video-start-frame-input').setInputFiles(png('start.png'));
  await expect(page.getByAltText('Start image', { exact: true })).toBeVisible();
  await inputs(page).getByText('References', { exact: true }).click();

  const dialog = page.getByRole('alertdialog', { name: 'Switch to references?' });
  await expect(dialog).toBeVisible();
  // Measured once its slide up has ended: a sheet the window's width, on the bottom edge.
  await expect.poll(async () => {
    const sheet = await dialog.boundingBox();
    return sheet ? [Math.round(sheet.y + sheet.height), Math.round(sheet.width)] : null;
  }).toEqual([PHONE.height, PHONE.width]);
  await dialog.getByRole('button', { name: 'Keep frames' }).click();
  await expect(dialog).toHaveCount(0);
});
