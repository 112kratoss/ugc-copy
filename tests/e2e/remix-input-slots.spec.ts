import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A remix not given the creator's inputs (owner, 2026-11-03): the remixer gets an empty box in place
 * of each, named as the prompt names it (`ugc-mobile/lib/remix-input-slots`), in the place its kind
 * is drawn: the image creator's reference strip, the video creator's frames, its rows of pictures,
 * clips and tracks and its named subjects, the motion creator's character and clip. Filled with the
 * remixer's own, the prompt works unchanged. Before 2026-11-03 such a remix opened with no reference
 * at all, and Generate refused the prompt's @mentions as unknown.
 *
 * Vitest draws the boxes; here, that they show and fill in a real browser, through the file field a
 * box opens, and that they fit the column at a phone's width. Each test keeps its screenshots in its
 * output folder (`testInfo.outputPath`).
 */

const COLD_PAGE = { timeout: 45_000 };
const PHONE = { width: 390, height: 844 };

test.describe.configure({ timeout: 180_000 });

// A 4x3 PNG, so a preview that draws has a width to show for it.
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGM4UREFRww4OQB8IhM5G3IQWQAAAABJRU5ErkJggg==',
  'base64',
);
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: PICTURE });
const CLIP = path.join(__dirname, 'fixtures', 'clip-2s.mov');

const GENERATION_ID = '7c1e4a58-93bd-4f06-8a27-d5e0b6f3a914';
const POST_ID = '6f0d2b1c-8a47-4e9b-b3c5-1d2e3f4a5b6c';

/** What /api/remix-source answers a remixer the creator gave nothing: no inputs, a box for each. */
function slotRemix(category: string, model: string, prompt: string, inputSlots: unknown[], settings: Record<string, unknown> = {}) {
  return {
    generation: { id: GENERATION_ID, title: 'Kept back', prompt, category, model },
    result: { mediaType: category === 'image' ? 'image' : 'video', url: null },
    inputs: {},
    inputSlots,
    workflowSettings: { model, ...settings },
    restoreIssues: [],
  };
}

const notice = (rest: string) => `Settings pre-filled from "Kept back".${rest}`;
const TWO_KEPT = ' The creator kept 2 inputs to themselves. Add your own in the empty boxes.';
const ONE_KEPT = ' The creator kept 1 input to themselves. Add your own in the empty box.';
const slotMessage = (handle: string) => `Add your own for ${handle} in its box, or take ${handle} out of the prompt.`;

async function openRemix(page: Page, creator: string, bundle: unknown) {
  await page.route('**/api/remix-source*', (route) => route.fulfill({ json: bundle }));
  await page.goto(`/${creator}?remix=${GENERATION_ID}&remixPost=${POST_ID}`, COLD_PAGE);
}

/** The page scrolls sideways by this much: nothing should. */
function sidewaysScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** A screenshot of `target`, in the test's own output folder. */
async function keep(target: Locator, name: string) {
  await target.screenshot({ path: test.info().outputPath(name) });
}

test.beforeEach(async ({ context }) => {
  // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
});

test('the image creator draws a box for each reference it was not given, and the remixer’s picture fills it', async ({ page }) => {
  await openRemix(page, 'create-image', slotRemix('image', 'nano-banana-2', 'Place @product on a marble counter, soft light', [
    { id: 'slot-1', kind: 'image', role: 'reference_image', handle: '@product', name: 'Reference image 1' },
    { id: 'slot-2', kind: 'image', role: 'reference_image', handle: null, name: 'Reference image 2' },
  ], { aspectRatio: '1:1' }));

  const references = page.locator('section[aria-labelledby="create-image-references"]');
  const productBox = references.getByRole('button', { name: 'Add your image for @product' });
  await expect(productBox).toBeVisible(COLD_PAGE);
  await expect(productBox).toContainText('@product');
  await expect(productBox).toContainText('Add your image');
  await expect(references.getByRole('button', { name: 'Add your image for Reference image 2' })).toBeVisible();
  await expect(page.getByText(notice(TWO_KEPT), { exact: true })).toBeVisible();
  // The prompt's mention of the empty box says so, in place of an unknown mention.
  await expect(page.getByText(slotMessage('@product'), { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Unknown element mention/)).toHaveCount(0);
  await keep(references, 'image-boxes.png');

  await page.locator('input[data-remix-slot="slot-1"]').setInputFiles(png('mine.png'));

  await expect(references.getByRole('button', { name: 'Insert @product' })).toBeVisible();
  await expect(references.getByAltText('Reference image 1', { exact: true })).toBeVisible();
  await expect(productBox).toHaveCount(0);
  await expect(page.getByText(slotMessage('@product'), { exact: true })).toHaveCount(0);
  await expect(page.getByText(notice(ONE_KEPT), { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Place @product on a marble counter, soft light');
  await keep(references, 'image-filled.png');

  // On a phone the strip holds the box and the picture without widening the page.
  await page.setViewportSize(PHONE);
  await expect(references.getByRole('button', { name: 'Add your image for Reference image 2' })).toBeVisible();
  expect(await sidewaysScroll(page)).toBe(0);
  await keep(references, 'image-filled-phone.png');
});

test('the video creator opens a references run on References, a box among each kind and the start image’s', async ({ page }) => {
  // Wan 2.7 keeps its start image beside its references.
  await openRemix(page, 'create-video', slotRemix('video', 'wan-2.7', '@product spins on a turntable under soft light.', [
    { id: 'slot-1', kind: 'image', role: 'start_frame', handle: null, name: 'Start frame' },
    { id: 'slot-2', kind: 'image', role: 'reference_image', handle: '@product', name: 'Reference image 1' },
    { id: 'slot-3', kind: 'video', role: 'reference_video', handle: null, name: 'Reference video 1', durationSeconds: 2 },
    { id: 'slot-4', kind: 'audio', role: 'reference_audio', handle: null, name: 'Reference audio 1' },
  ], { referenceMode: 'elements', duration: 5, aspectRatio: '16:9' }));

  const inputs = page.getByRole('group', { name: 'Inputs' });
  const productBox = inputs.getByRole('button', { name: 'Add your image for @product' });
  await expect(productBox).toBeVisible(COLD_PAGE);
  await expect(inputs.getByRole('radio', { name: 'References' })).toBeChecked();
  await expect(inputs.getByRole('button', { name: 'Add your video for Reference video 1' })).toBeVisible();
  await expect(inputs.getByRole('button', { name: 'Add your audio for Reference audio 1' })).toBeVisible();
  const startBox = inputs.locator('label[for="video-start-frame-input"]');
  await expect(startBox).toContainText('Start frame');
  await expect(startBox).toContainText('Add your image');
  await expect(page.getByText(notice(' The creator kept 4 inputs to themselves. Add your own in the empty boxes.'), { exact: true })).toBeVisible();
  await expect(page.getByText(slotMessage('@product'), { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Unknown element mention/)).toHaveCount(0);
  await keep(inputs, 'video-references-boxes.png');

  await page.locator('input[data-remix-slot="slot-2"]').setInputFiles(png('mine.png'));

  await expect(inputs.getByRole('button', { name: 'Insert @product' })).toBeVisible();
  await expect(productBox).toHaveCount(0);
  await expect(page.getByText(slotMessage('@product'), { exact: true })).toHaveCount(0);
  await expect(page.getByText(notice(' The creator kept 3 inputs to themselves. Add your own in the empty boxes.'), { exact: true })).toBeVisible();

  // A press on a box opens the picker of its kind.
  const chooser = page.waitForEvent('filechooser');
  await inputs.getByRole('button', { name: 'Add your video for Reference video 1' }).click();
  const picker = await chooser;
  expect(await picker.element().getAttribute('accept')).toBe('video/*');
  await picker.setFiles(CLIP);
  await expect(inputs.getByRole('button', { name: 'Remove Reference video 1' })).toBeVisible();
  await expect(inputs.getByRole('button', { name: 'Add your video for Reference video 1' })).toHaveCount(0);
  await keep(inputs, 'video-references-filled.png');
});

test('the video creator draws a subject it was not given as an empty subject under its handle', async ({ page }) => {
  await openRemix(page, 'create-video', slotRemix('video', 'kling-o3', '@maya walks through the rain, slow push in.', [
    { id: 'slot-1', kind: 'image', role: 'subject', handle: '@maya', name: 'Subject 1', pictureCount: 2 },
  ], { duration: 5, aspectRatio: '16:9', resolution: '720p' }));

  const box = page.getByRole('button', { name: 'Add your pictures for @maya' });
  await expect(box).toBeVisible(COLD_PAGE);
  const subjects = page.locator('.ui-card', { has: page.getByRole('heading', { name: 'Named subjects' }) });
  await expect(subjects.getByRole('button', { name: 'Add your pictures for @maya' })).toBeVisible();
  await expect(page.getByText(notice(ONE_KEPT), { exact: true })).toBeVisible();
  await expect(page.getByText(slotMessage('@maya'), { exact: true }).first()).toBeVisible();
  await keep(subjects, 'video-subject-box.png');

  await page.locator('input[data-remix-slot="slot-1"]').setInputFiles([png('front.png'), png('side.png')]);

  await expect(subjects.getByText('2/4 images')).toBeVisible();
  await expect(subjects.getByRole('button', { name: 'Insert @maya' })).toBeVisible();
  await expect(subjects.getByPlaceholder('Subject name')).toHaveValue('Subject 1');
  await expect(box).toHaveCount(0);
  await expect(page.getByText(slotMessage('@maya'), { exact: true })).toHaveCount(0);
  await expect(page.getByText(notice(''), { exact: true })).toBeVisible();
  await keep(subjects, 'video-subject-filled.png');
});

test('the motion creator draws a box on the character and the clip it was not given', async ({ page }) => {
  await openRemix(page, 'create-motion', slotRemix('video', 'kling-3.0', 'Dance on the roof at dusk', [
    { id: 'slot-1', kind: 'image', role: 'character_image', handle: null, name: 'Character image' },
    { id: 'slot-2', kind: 'video', role: 'motion_reference_video', handle: null, name: 'Motion video', durationSeconds: 8 },
  ], { mode: '720p', characterOrientation: 'video', creationMode: 'motion' }));

  const inputs = page.getByRole('group', { name: 'Required inputs' });
  const characterBox = inputs.locator('label[for="motion-character-image-input"]');
  const clipBox = inputs.locator('label[for="motion-reference-video-input"]');
  await expect(page.getByText(notice(TWO_KEPT), { exact: true })).toBeVisible(COLD_PAGE);
  await expect(characterBox).toContainText('Character image');
  await expect(characterBox).toContainText('Add your image');
  await expect(clipBox).toContainText('Motion video');
  await expect(clipBox).toContainText('Add your video');
  await keep(inputs, 'motion-boxes.png');

  await page.locator('#motion-character-image-input').setInputFiles(png('hero.png'));

  await expect(inputs.getByRole('button', { name: 'Replace Character image' })).toBeVisible();
  await expect(characterBox).toHaveCount(0);
  await expect(clipBox).toContainText('Motion video');
  await expect(page.getByText(notice(ONE_KEPT), { exact: true })).toBeVisible();
  await keep(inputs, 'motion-character-filled.png');

  await page.setViewportSize(PHONE);
  await expect(clipBox).toBeVisible();
  expect(await sidewaysScroll(page)).toBe(0);
  await keep(inputs, 'motion-character-filled-phone.png');
});
