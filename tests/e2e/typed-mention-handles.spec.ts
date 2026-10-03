import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A long handle typed after "@" stays inside a creator's prompt card.
 *
 * Typing "@" in a prompt opens a panel of references to insert, and the panel's
 * header echoes what has been typed in a pill. Until the handle is complete it
 * is also an unknown one, so the line under the prompt reads "Unknown element
 * mention: @...". Both printed the handle as one run that could neither break
 * nor shrink. With a handle of 36 characters typed in full on a 390px phone the
 * pill stood 63px past its header in the video creator, after squeezing the
 * panel's title onto six lines, and from 360px down the page scrolled sideways.
 * A handle of 68 characters did that at 768px, and its "Unknown element mention"
 * line ran 181px past its row at 390px. The image creator says it once more in
 * its run panel, "Resolve the unknown element mention before generating: @...",
 * and that line made the page 83px wider than a 1280px window (2026-10-03).
 *
 * All three follow the rule of the reference cards now. The echoed handle stays
 * beside the panel's title while it takes no more than half of the header, and
 * takes the next line, whole, when it is longer. In the two sentences a handle
 * stays on one line while a line can hold it. Where no line can, it breaks after
 * an underscore.
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
  /** The pill in the panel's header: "@" and what was typed after it. */
  echo: string;
  /** The line under the prompt, or null where the prompt has none. */
  unknown: string | null;
  /** The run panel's line about the same handle, or null where the creator has none. */
  resolve: string | null;
  /** One line for each thing the layout gets wrong. */
  faults: string[];
};

/** Measures the header of the panel titled `title` and the sentences that name the handle, or answers null while the panel is shut. */
async function readMentionLines(page: Page, title: string): Promise<MentionLines | null> {
  try {
    return await page.evaluate((panelTitle) => {
      const heading = Array.from(document.querySelectorAll<HTMLElement>('p'))
        .find((candidate) => candidate.textContent?.trim() === panelTitle);
      // The header holds the title with its line of help, then the echoed handle.
      const block = heading?.parentElement ?? null;
      const header = block?.parentElement ?? null;
      if (!block || !header || header.childElementCount < 2) return null;
      const echo = header.lastElementChild as HTMLElement;

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

      reportOverflow(header);
      const headerBox = header.getBoundingClientRect();
      const blockBox = block.getBoundingClientRect();
      const echoBox = echo.getBoundingClientRect();
      for (const [name, box] of [['the title', blockBox], ['the echoed handle', echoBox]] as const) {
        if (box.left < headerBox.left - 1 || box.right > headerBox.right + 1) {
          faults.push(`${name} runs from ${px(box.left)} to ${px(box.right)}, outside its header at ${px(headerBox.left)} to ${px(headerBox.right)}`);
        }
      }

      // The title's share of the header: half of it once the gap is out, or 160px
      // where half is more.
      const gap = parseFloat(getComputedStyle(header).columnGap) || 0;
      const room = header.clientWidth;
      const titleShare = Math.min(room / 2 - gap, 160);
      if (blockBox.width < titleShare - 1) {
        faults.push(`the title is ${px(blockBox.width)} wide, under its share of ${px(titleShare)}`);
      }

      // The echoed handle shows whole. An inline box reports no width, which would pass.
      if (echo.clientWidth === 0) {
        faults.push('the echoed handle has no box of its own to measure');
      } else if (echo.scrollWidth > echo.clientWidth + 1 || echo.scrollHeight > echo.clientHeight + 1) {
        faults.push(`a ${echo.clientWidth}x${echo.clientHeight}px pill holds ${echo.scrollWidth}x${echo.scrollHeight}px of handle`);
      }

      const echoed = handleRuns(echo);
      const echoStyle = getComputedStyle(echo);
      const whole = echoed.width
        + parseFloat(echoStyle.paddingLeft) + parseFloat(echoStyle.paddingRight)
        + parseFloat(echoStyle.borderLeftWidth) + parseFloat(echoStyle.borderRightWidth);
      const beside = echoBox.top < blockBox.bottom - 1 && echoBox.bottom > blockBox.top + 1;
      if (beside) {
        if (echoBox.left < blockBox.right - 1 || Math.abs(echoBox.right - headerBox.right) > 1) {
          faults.push('the echoed handle beside the title is not at the end of the header');
        }
        // Wrapped beside the title, a handle would be a ribbon a few characters wide.
        if (echoed.lines > 1) {
          faults.push(`the echoed handle wraps onto ${echoed.lines} lines beside the title`);
        }
      } else {
        if (echoBox.top < blockBox.bottom - 1 || Math.abs(echoBox.left - headerBox.left) > 1) {
          faults.push('the echoed handle is on a line of its own, but not under the start of the title');
        }
        // It leaves the title's line only when it has to.
        if (titleShare + gap + whole <= room + 1) {
          faults.push(`the echoed handle is on a line of its own, though its ${px(whole)} fit beside a ${px(titleShare)} title in ${px(room)}`);
        }
        // And it wraps only when the line it then has is too short for it.
        if (echoed.lines > 1 && echoBox.width < room - 1) {
          faults.push(`the echoed handle wraps onto ${echoed.lines} lines in ${px(echoBox.width)} of the ${px(room)} its line has`);
        }
      }

      // A sentence that ends in the handle stays inside `within`, and breaks the
      // handle only when no line can hold it.
      const reportSentence = (sentence: HTMLElement, within: HTMLElement) => {
        const name = `"${(sentence.textContent ?? '').trim().slice(0, 24)}..."`;
        reportOverflow(within);
        const frame = within.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(sentence);
        const outside = Array.from(text.getClientRects())
          .find((run) => run.width > 0 && (run.left < frame.left - 1 || run.right > frame.right + 1));
        if (outside) {
          faults.push(`${name} runs from ${px(outside.left)} to ${px(outside.right)}, outside its box at ${px(frame.left)} to ${px(frame.right)}`);
        }
        const handle = handleRuns(sentence);
        if (handle.lines > 1 && handle.width <= sentence.clientWidth + 1) {
          faults.push(`the handle in ${name} wraps onto ${handle.lines} lines, though its ${px(handle.width)} fit one line of ${px(sentence.clientWidth)}`);
        }
        return (sentence.textContent ?? '').replace(/\s+/g, ' ').trim();
      };

      // The line under the prompt: the character count, then the message.
      const unknown = Array.from(document.querySelectorAll<HTMLElement>('p, span')).find((candidate) => (
        /^Unknown element mention/.test((candidate.textContent ?? '').trim())
        && /^\d+\/\d+/.test((candidate.previousElementSibling?.textContent ?? '').trim())
      ));
      // The run panel's line, which is a paragraph of its own.
      const resolve = Array.from(document.querySelectorAll<HTMLElement>('p'))
        .find((candidate) => /^Resolve the unknown element mention/.test((candidate.textContent ?? '').trim()));

      const root = document.documentElement;
      return {
        pageOverflow: root.scrollWidth - root.clientWidth,
        echo: echo.textContent ?? '',
        unknown: unknown?.parentElement ? reportSentence(unknown, unknown.parentElement) : null,
        resolve: resolve ? reportSentence(resolve, resolve) : null,
        faults,
      };
    }, title);
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
 * Types each handle into `prompt` and measures at each width. A dev server reload
 * empties the prompt and shuts the panel, so the handle is typed again until the
 * lines have been measured.
 */
async function expectTypedHandlesInTheirCard(
  page: Page,
  prompt: Locator,
  title: string,
  sentences: { unknown: boolean; resolve: boolean },
) {
  for (const query of QUERIES) {
    await prompt.fill(`${PROMPT_START}${query}`);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await expect(async () => {
        if ((await readMentionLines(page, title))?.echo !== `@${query}`) {
          await prompt.fill(`${PROMPT_START}${query}`);
        }
        expect(await readMentionLines(page, title), `"@${query}" at ${viewport.width}px wide`).toEqual({
          pageOverflow: 0,
          echo: `@${query}`,
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

    await expectTypedHandlesInTheirCard(page, prompt, 'Insert reference', { unknown: true, resolve: false });
  });

  test('a Kling shot prompt keeps a typed handle inside its panel', async ({ page }) => {
    await page.goto('/create-video?model=kling-3.0-video');
    await page.getByRole('button', { name: 'Multi-Shot', exact: true }).click();
    const shot = page.getByPlaceholder('Describe shot 1...');
    await expect(shot).toBeVisible();

    // A shot prompt has the panel, and no sentence about unknown mentions.
    await expectTypedHandlesInTheirCard(page, shot, 'Insert video element', { unknown: false, resolve: false });
  });

  test('a Kling O3 shot prompt keeps a typed handle inside its panel', async ({ page }) => {
    await page.goto('/create-video?model=kling-o3');
    await page.getByRole('button', { name: 'Multi-Shot', exact: true }).click();
    const shot = page.getByPlaceholder('Describe shot 1...');
    await expect(shot).toBeVisible();

    // The same panel under the title it has on Kling O3, where it offers the named subjects.
    await expectTypedHandlesInTheirCard(page, shot, 'Insert subject', { unknown: false, resolve: false });
  });

  test('the image creator keeps a typed handle inside its prompt card', async ({ page }) => {
    await page.goto('/create-image?model=nano-banana-2');
    const prompt = page.getByPlaceholder('Describe the image you want to create...');
    await expect(prompt).toBeVisible();

    await expectTypedHandlesInTheirCard(page, prompt, 'Insert element', { unknown: true, resolve: true });
  });
});
