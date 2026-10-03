import { expect, test, type Page } from '@playwright/test';

/**
 * A long handle stays inside a sentence that the video creator builds as one string.
 *
 * Pressing Generate with an unknown handle in the prompt puts "Unknown element
 * mention: @..." in the run panel. The sentence was a string, so the handle in
 * it was plain text that could not break. A handle of 68 characters stood
 * 149px past its box there in a 1280px window and 219px on a 390px phone,
 * where the page scrolled 165px sideways, and one of 36 characters stood 41px
 * past it at 320px (2026-10-03).
 *
 * It follows the rule of the other sentences now (typed-mention-handles.spec.ts):
 * a handle stays on one line while a line can hold it, and where none can it
 * breaks after an underscore. The run panel's line also prints a subject's
 * name, which is free text. A name of 44 characters with no space in it stood
 * 18px past the box at 390px, so a word that no line can hold breaks where its
 * line ends.
 *
 * Vitest cannot reach this. The words were always in the document, and only
 * the layout pushed them out of their box.
 */

const SHORT = '@hero';
const LONG_WORDS = '@protagonist_in_the_crimson_raincoat';
const VERY_LONG = '@the_quick_brown_fox_jumps_over_the_lazy_dog_by_the_old_harbour_wall';

const VIEWPORTS = [
  { width: 320, height: 720 },
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
];

type SentenceReading = {
  /** How far the document is wider than its window, in pixels. */
  pageOverflow: number;
  /** The sentence as the page prints it. */
  text: string;
  /** One line for each thing the layout gets wrong. */
  faults: string[];
};

/** Measures the run panel's sentence that starts with `start`, or answers null while the page does not show it. */
async function readSentence(page: Page, start: string): Promise<SentenceReading | null> {
  try {
    return await page.evaluate((opening) => {
      // The run panel is the section headed "Run summary".
      const sentence = Array.from(document.querySelectorAll<HTMLElement>('section p'))
        .find((candidate) => (candidate.textContent ?? '').trim().startsWith(opening)
          && (candidate.closest('section')?.textContent ?? '').includes('Run summary'));
      const frame = sentence?.parentElement;
      if (!sentence || !frame) return null;

      const faults: string[] = [];
      const px = (value: number) => `${Math.round(value)}px`;

      // Content that runs out of its box where it shows.
      for (const element of [frame, ...Array.from(frame.querySelectorAll<HTMLElement>('*'))]) {
        if (
          element.clientWidth > 0
          && getComputedStyle(element).overflowX === 'visible'
          && element.scrollWidth > element.clientWidth + 1
        ) {
          faults.push(`a ${element.clientWidth}px box holds ${element.scrollWidth}px of content: ${(element.textContent ?? '').trim().slice(0, 40)}`);
        }
      }
      // An inline box reports no width, which would pass the check above.
      if (sentence.clientWidth === 0) {
        faults.push('the sentence has no box of its own to measure');
      }

      // Every character of the sentence, with the box it is drawn in. White space
      // at the end of a line is not drawn and has none.
      const drawn: Array<{ character: string; box: DOMRect | null }> = [];
      const walker = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.textContent ?? '';
        for (let index = 0; index < value.length; index += 1) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          drawn.push({
            character: value[index],
            box: Array.from(range.getClientRects()).find((candidate) => candidate.width > 0) ?? null,
          });
        }
      }

      // The room the frame gives the sentence: its box less its padding and border.
      const frameBox = frame.getBoundingClientRect();
      const frameStyle = getComputedStyle(frame);
      const roomLeft = frameBox.left + parseFloat(frameStyle.paddingLeft) + parseFloat(frameStyle.borderLeftWidth);
      const roomRight = frameBox.right - parseFloat(frameStyle.paddingRight) - parseFloat(frameStyle.borderRightWidth);
      const boxes = drawn.flatMap(({ box }) => (box ? [box] : []));
      const left = Math.min(...boxes.map((box) => box.left));
      const right = Math.max(...boxes.map((box) => box.right));
      if (left < roomLeft - 1 || right > roomRight + 1) {
        faults.push(`the sentence is drawn from ${px(left)} to ${px(right)}, outside the ${px(roomLeft)} to ${px(roomRight)} its box gives it`);
      }

      // A handle stays on one line while a line can hold it. Where none can, each
      // of its lines but the last ends with an underscore.
      const text = drawn.map(({ character }) => character).join('');
      for (const match of text.matchAll(/\S+/g)) {
        const word = match[0];
        if (!/(?:^|\W)@\w/.test(word)) continue;
        const lines: Array<{ top: number; text: string; width: number }> = [];
        for (const { character, box } of drawn.slice(match.index, match.index + word.length)) {
          if (!box) continue;
          const line = lines.find((candidate) => Math.abs(candidate.top - box.top) < 4);
          if (line) {
            line.text += character;
            line.width += box.width;
          } else {
            lines.push({ top: box.top, text: character, width: box.width });
          }
        }
        const whole = lines.reduce((sum, line) => sum + line.width, 0);
        if (lines.length > 1 && whole <= sentence.clientWidth + 1) {
          faults.push(`${word} wraps onto ${lines.length} lines, though its ${px(whole)} fit one line of ${px(sentence.clientWidth)}`);
        }
        for (const line of lines.slice(0, -1)) {
          if (!line.text.endsWith('_')) {
            faults.push(`${word} breaks after "${line.text.slice(-8)}", which is not after an underscore`);
          }
        }
      }

      const root = document.documentElement;
      return {
        pageOverflow: root.scrollWidth - root.clientWidth,
        text: text.replace(/\s+/g, ' ').trim(),
        faults,
      };
    }, start);
  } catch (error) {
    // The dev server reloads open pages on its own (see kling-o3-named-subjects.spec.ts),
    // which tears the page down mid-read. Answer "not shown" and let the caller ask again.
    if (error instanceof Error && /Execution context was destroyed|frame was detached/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

/**
 * Measures `sentence` at each width. A dev server reload empties the form, so
 * `show` brings the sentence back whenever the page no longer prints it.
 */
async function expectSentenceInItsBox(page: Page, sentence: string, show: () => Promise<void>) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect(async () => {
      if ((await readSentence(page, sentence))?.text !== sentence) {
        await show();
      }
      expect(await readSentence(page, sentence), `"${sentence}" at ${viewport.width}px wide`).toEqual({
        pageOverflow: 0,
        text: sentence,
        faults: [],
      });
    }).toPass({ timeout: 30_000 });
  }
}

/**
 * Offline the price quote fails, and Generate stays disabled until there is a
 * price. The page checks the prompt before it uploads or sends anything, so
 * the quote is the only answer these tests need.
 */
async function answerQuote(page: Page) {
  await page.route('**/api/generation-models/quote', async (route) => {
    const request = (route.request().postDataJSON() ?? {}) as { modelId?: string; catalogRevision?: string };
    await route.fulfill({
      json: {
        modelId: request.modelId ?? 'unknown',
        catalogRevision: request.catalogRevision ?? 'unknown',
        normalizedSettings: {},
        costCredits: 10,
      },
    });
  });
}

function unknownMention(handles: string[]) {
  return `Unknown element mention${handles.length > 1 ? 's' : ''}: ${handles.join(', ')}`;
}

test.describe('sentences that name a handle', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
  });

  test('the run panel keeps an unknown handle inside its box when Generate refuses the prompt', async ({ page }) => {
    await answerQuote(page);
    await page.goto('/create-video?model=seedance-2');
    const prompt = page.getByPlaceholder(/^Describe the .* scene/);
    await expect(prompt).toBeVisible();
    const generate = page.getByRole('button', { name: 'Generate Video' });

    for (const handles of [
      // A handle that fits beside its label. Nothing about this may change.
      [SHORT],
      // The measured handle: whole on a phone, broken where a line is too short for it.
      [LONG_WORDS],
      // One no line of the panel can hold.
      [VERY_LONG],
      // Two at once, which puts a comma against the first.
      [LONG_WORDS, VERY_LONG],
    ]) {
      await expectSentenceInItsBox(page, unknownMention(handles), async () => {
        await prompt.fill(`A harbour at dusk where ${handles.join(' and ')} walk home`);
        await expect(generate).toBeEnabled();
        await generate.click();
      });
    }
  });

  test('the run panel keeps an unknown handle from a Kling shot prompt inside its box', async ({ page }) => {
    await answerQuote(page);
    await page.goto('/create-video?model=kling-3.0-video');
    const generate = page.getByRole('button', { name: 'Generate Video' });
    await expect(generate).toBeVisible();
    const shots = page.getByPlaceholder(/^Describe shot \d+\.\.\.$/);
    const handles = [LONG_WORDS, VERY_LONG];

    await expectSentenceInItsBox(page, unknownMention(handles), async () => {
      if ((await shots.count()) === 0) {
        await page.getByRole('button', { name: 'Multi-Shot', exact: true }).click();
      }
      await expect(shots.first()).toBeVisible();
      for (let index = 0; index < (await shots.count()); index += 1) {
        // Every shot needs a prompt before the page looks at their handles.
        await shots.nth(index).fill(index === 0 ? `A harbour at dusk where ${handles.join(' and ')} walk home` : 'The camera holds on the water');
      }
      await expect(generate).toBeEnabled();
      await generate.click();
    });
  });

  test('the run panel breaks a subject name that no line can hold', async ({ page }) => {
    await answerQuote(page);
    await page.goto('/create-video?model=kling-o3');
    await expect(page.getByRole('heading', { name: 'Named subjects' })).toBeVisible();
    const prompt = page.getByPlaceholder(/^Describe the .* scene/);
    const generate = page.getByRole('button', { name: 'Generate Video' });
    const names = page.getByPlaceholder('Subject name');

    for (const name of [
      // A name as most are. Nothing about this may change.
      'Hero creator',
      // A name written the way a file is, with no space to break at.
      'protagonist_in_the_crimson_raincoat_final_v2',
      // One word that is longer than the panel's line on a desktop too.
      'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz',
    ]) {
      // A subject with no images cannot run, and the page says so by name.
      await expectSentenceInItsBox(page, `${name} needs 2–4 images of the same subject.`, async () => {
        if ((await names.count()) === 0) {
          await page.getByRole('button', { name: 'Add subject' }).click();
        }
        await names.first().fill(name);
        await prompt.fill('A harbour at dusk');
        await expect(generate).toBeEnabled();
        await generate.click();
      });
    }
  });
});
