import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A long handle typed after "@" stays inside a creator's prompt card and its "@" menu.
 *
 * Typing "@" in a prompt opens a menu of references to insert. Until the handle
 * is complete it is also an unknown one, so the line under the prompt reads
 * "Unknown element mention: @...". Each printed the handle as one run that could
 * neither break nor shrink: the panel the menu replaced echoed it in a pill that
 * stood 63px past its header on a 390px phone, the "Unknown element mention" line
 * ran 181px past its row, and the image creator's "Resolve the unknown element
 * mention before generating: @..." made the page 83px wider than a 1280px window
 * (2026-10-03).
 *
 * Since 2026-11-04 the menu says what matches nothing in a sentence, "No
 * references match “@...”.", in place of the pill. All three sentences follow the
 * rule of the reference cards: a handle stays on one line while a line can hold
 * it, and where no line can, it breaks after an underscore. The menu itself stays
 * inside the window.
 *
 * Vitest cannot reach this. The handle was always in the document, and only the
 * layout pushed it out of its card.
 */

const PROMPT_START = 'A harbour at dusk with @';

const QUERIES = [
  // A few letters, as while picking from the panel. Nothing about this may change.
  'pro',
  // The measured handle, typed out in full.
  'protagonist_in_the_crimson_raincoat',
  // One that on a desktop still fits beside a title squeezed to its longest word,
  // which is where the title's share of the header decides.
  'the_quick_brown_fox_jumps_over_the_lazy_dog_by_the',
  // One wider than a phone's line by itself, so it has to break.
  'the_quick_brown_fox_jumps_over_the_lazy_dog_by_the_old_harbour_wall',
];

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
];

type MentionLines = {
  /** How far the document is wider than its window, in pixels. */
  pageOverflow: number;
  /** The menu's sentence for what was typed: "No references match “@...”." */
  empty: string;
  /** The line under the prompt, or null where the prompt has none. */
  unknown: string | null;
  /** The run panel's line about the same handle, or null where the creator has none. */
  resolve: string | null;
  /** One line for each thing the layout gets wrong. */
  faults: string[];
};

/** Measures the "@" menu of `prompt` and the sentences that name the handle, or answers null while the menu is shut. */
async function readMentionLines(prompt: Locator): Promise<MentionLines | null> {
  try {
    // A reload can take a shot prompt off the page: the caller shows it again.
    if (await prompt.count() === 0) return null;
    return await prompt.evaluate((field) => {
      // The menu is drawn in the prompt's own card, over the page.
      const menu = field.parentElement?.querySelector<HTMLElement>(':scope > [data-mention-menu]') ?? null;
      if (!menu || getComputedStyle(menu).visibility !== 'visible') return null;
      const sentence = Array.from(menu.querySelectorAll<HTMLElement>('p'))
        .find((candidate) => /^No .* match/.test((candidate.textContent ?? '').trim()));
      if (!sentence) return null;

      const faults: string[] = [];
      const px = (value: number) => `${Math.round(value)}px`;
      // Content that runs out of its box where it shows.
      const reportOverflow = (within: HTMLElement) => {
        for (const element of [within, ...Array.from(within.querySelectorAll<HTMLElement>('*'))]) {
          if (
            element.clientWidth > 0
            && getComputedStyle(element).overflowX === 'visible'
            && element.scrollWidth > element.clientWidth + 1
          ) {
            faults.push(`a ${element.clientWidth}px box holds ${element.scrollWidth}px of content: ${(element.textContent ?? '').slice(0, 40)}`);
          }
        }
      };
      // The text under `within` from its first "@" on, as the runs it is drawn in.
      const handleRuns = (within: HTMLElement) => {
        const runs: DOMRect[] = [];
        const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT);
        let started = false;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const from = started ? 0 : (node.textContent ?? '').indexOf('@');
          if (from < 0) continue;
          started = true;
          const range = document.createRange();
          range.setStart(node, from);
          range.setEnd(node, (node.textContent ?? '').length);
          runs.push(...Array.from(range.getClientRects()).filter((run) => run.width > 0));
        }
        return {
          lines: new Set(runs.map((run) => Math.round(run.top))).size,
          width: runs.reduce((sum, run) => sum + run.width, 0),
        };
      };

      // The menu stays inside the window, however long what was typed.
      const menuBox = menu.getBoundingClientRect();
      if (menuBox.left < -1 || menuBox.right > window.innerWidth + 1) {
        faults.push(`the menu runs from ${px(menuBox.left)} to ${px(menuBox.right)}, outside the ${px(window.innerWidth)} window`);
      }

      // A sentence that ends in the handle stays inside `within`, and breaks the
      // handle only when no line can hold it.
      const reportSentence = (line: HTMLElement, within: HTMLElement) => {
        const name = `"${(line.textContent ?? '').trim().slice(0, 24)}..."`;
        reportOverflow(within);
        const frame = within.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(line);
        const outside = Array.from(text.getClientRects())
          .find((run) => run.width > 0 && (run.left < frame.left - 1 || run.right > frame.right + 1));
        if (outside) {
          faults.push(`${name} runs from ${px(outside.left)} to ${px(outside.right)}, outside its box at ${px(frame.left)} to ${px(frame.right)}`);
        }
        // A line's room is the box's inside less its padding: the menu's sentence has some.
        const lineStyle = getComputedStyle(line);
        const room = line.clientWidth - (parseFloat(lineStyle.paddingLeft) || 0) - (parseFloat(lineStyle.paddingRight) || 0);
        const handle = handleRuns(line);
        if (handle.lines > 1 && handle.width <= room + 1) {
          faults.push(`the handle in ${name} wraps onto ${handle.lines} lines, though its ${px(handle.width)} fit one line of ${px(room)}`);
        }
        return (line.textContent ?? '').replace(/\s+/g, ' ').trim();
      };

      // The line under the prompt: the character count, then the message. The count reads
      // "12 / 10,000" (PromptLengthCounter: digits grouped in threes, a space either side
      // of the slash), with " characters" after it on the image creator.
      const unknown = Array.from(document.querySelectorAll<HTMLElement>('p, span')).find((candidate) => (
        /^Unknown element mention/.test((candidate.textContent ?? '').trim())
        && /^\d{1,3}(?:,\d{3})* \/ \d{1,3}(?:,\d{3})*/.test((candidate.previousElementSibling?.textContent ?? '').trim())
      ));
      // The run panel's line, which is a paragraph of its own.
      const resolve = Array.from(document.querySelectorAll<HTMLElement>('p'))
        .find((candidate) => /^Resolve the unknown element mention/.test((candidate.textContent ?? '').trim()));

      const root = document.documentElement;
      return {
        pageOverflow: root.scrollWidth - root.clientWidth,
        empty: reportSentence(sentence, menu),
        unknown: unknown?.parentElement ? reportSentence(unknown, unknown.parentElement) : null,
        resolve: resolve ? reportSentence(resolve, resolve) : null,
        faults,
      };
    }, undefined, { timeout: 5_000 });
  } catch (error) {
    // The dev server reloads open pages on its own (see kling-o3-named-subjects.spec.ts),
    // which tears the page down mid-read. Answer "unknown" and let the caller ask again.
    if (error instanceof Error && /Execution context was destroyed|frame was detached/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

/**
 * Switches to shot prompts. A dev server reload puts the page back on its single
 * prompt. On a page that has only just loaded, the shot mode is drawn before it
 * answers, and a click that comes too early does nothing: the short wait ends
 * the attempt there, so the next one can click again.
 */
async function showShotPrompts(page: Page) {
  const shot = page.getByPlaceholder('Describe shot 1...');
  if (await shot.count() === 0) {
    await page.getByRole('radio', { name: 'Multi-shot', exact: true }).click({ timeout: 5_000 });
    await expect(shot).toBeVisible({ timeout: 1_000 });
  }
}

/**
 * Types each handle into `prompt` and measures at each width. A dev server reload
 * empties the prompt and shuts the panel, so the handle is typed again until the
 * lines have been measured. The reload can also take the prompt itself off the
 * page, as it does with a shot prompt, so `show` brings the prompt back before
 * each typing. All typing happens inside the retried steps, and each of them gives
 * up after 5 seconds: one that waits for as long as it takes would wait for a
 * prompt that is gone until the 30 seconds were over, and nothing would be tried
 * again.
 */
async function expectTypedHandlesInTheirCard(
  page: Page,
  prompt: Locator,
  rows: string,
  sentences: { unknown: boolean; resolve: boolean },
  show: () => Promise<void> = async () => {},
) {
  for (const query of QUERIES) {
    const empty = `No ${rows} match “@${query}”.`;
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await expect(async () => {
        if ((await readMentionLines(prompt))?.empty !== empty) {
          await show();
          await prompt.fill(`${PROMPT_START}${query}`, { timeout: 5_000 });
        }
        expect(await readMentionLines(prompt), `"@${query}" at ${viewport.width}px wide`).toEqual({
          pageOverflow: 0,
          empty,
          unknown: sentences.unknown ? `Unknown element mention: @${query}` : null,
          resolve: sentences.resolve ? `Resolve the unknown element mention before generating: @${query}` : null,
          faults: [],
        });
      }).toPass({ timeout: 30_000 });
    }
  }
}

test.describe('handles typed after "@"', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
  });

  test('the video creator keeps a typed handle inside its prompt card', async ({ page }) => {
    await page.goto('/create-video?model=seedance-2');
    const prompt = page.getByPlaceholder(/^Describe the .* scene/);
    await expect(prompt).toBeVisible();
    // "@" is offered while the inputs show their references (the artboard Inputs, PR 4).
    await page.getByRole('group', { name: 'Inputs' }).getByText('References', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'References' })).toBeChecked();

    await expectTypedHandlesInTheirCard(page, prompt, 'references', { unknown: true, resolve: false });
  });

  test('a Kling shot prompt keeps a typed handle inside its menu', async ({ page }) => {
    await page.goto('/create-video?model=kling-3.0-video');
    const shot = page.getByPlaceholder('Describe shot 1...');

    // A shot prompt has the menu, and no sentence about unknown mentions.
    await expectTypedHandlesInTheirCard(page, shot, 'video elements', { unknown: false, resolve: false }, () => (
      showShotPrompts(page)
    ));
  });

  test('a Kling O3 shot prompt keeps a typed handle inside its menu', async ({ page }) => {
    await page.goto('/create-video?model=kling-o3');
    const shot = page.getByPlaceholder('Describe shot 1...');

    // The same menu on Kling O3, where it offers the named subjects.
    await expectTypedHandlesInTheirCard(page, shot, 'subjects', { unknown: false, resolve: false }, () => (
      showShotPrompts(page)
    ));
  });

  test('the image creator keeps a typed handle inside its prompt card', async ({ page }) => {
    await page.goto('/create-image?model=nano-banana-2');
    const prompt = page.getByPlaceholder('Describe the image you want to create...');
    await expect(prompt).toBeVisible();

    await expectTypedHandlesInTheirCard(page, prompt, 'references', { unknown: true, resolve: true });
  });
});
