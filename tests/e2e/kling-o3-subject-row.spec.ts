import { expect, test, type Page } from '@playwright/test';

/**
 * A long subject name keeps its own field on a Kling O3 subject card.
 *
 * Each named subject has a card that starts with one line: the name field, the
 * subject's @handle in a pill, and the button that removes the subject. The
 * handle is made from the name, so it grows as the name is typed, and the pill
 * could not shrink, so the name field gave up all the room instead. With a name
 * of 35 characters on a 390px phone the field was 26px wide, which is its own
 * padding and border, so nothing typed showed; the remove button stood 26px
 * outside its line; and from 360px down the whole page scrolled sideways
 * (2026-10-03). A name of 67 characters did the same on a desktop.
 *
 * The handle now stays beside the name field only while it takes no more than
 * half of the room the two share, and leaves the field 160px where the line is
 * wide enough. A longer handle takes the next line, whole, and breaks after an
 * underscore when that line is too short for it too. The remove button stays at
 * the end of the name field's line either way.
 *
 * Vitest cannot reach this. Every part was in the document, and only the layout
 * was wrong.
 */

// The measured name. Its handle fits beside a name field on a desktop and not on a phone.
const LONG_NAME = 'Protagonist in the crimson raincoat';
// A name whose handle is wider than a desktop's line by itself, so it has to break.
const VERY_LONG_NAME = 'The quick brown fox jumps over the lazy dog by the old harbour wall';

/** A subject's handle is its name in lower case, with underscores for everything but letters and digits. */
function handleOf(name: string) {
  return `@${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

const PHONE = { width: 390, height: 844 };
// A large phone. Here the long handle still fits beside a name field 40px wide,
// which is what it was given before, so this is where the field's share decides.
const LARGE_PHONE = { width: 430, height: 932 };
// The form column at its widest: 447px for the name field and the handle to share.
const DESKTOP = { width: 1280, height: 720 };
// The narrowest phone in common use. A default subject still fits on one line here,
// and the long handle's own line is too short for it, so it has to break.
const SMALL_PHONE = { width: 360, height: 780 };

type SubjectLine = {
  /** How far the document is wider than its window, in pixels. */
  pageOverflow: number;
  /** The handle in the pill, as the page's own text has it. */
  handle: string;
  /** One line for each thing the layout gets wrong. */
  faults: string[];
};

function contained(handle: string): SubjectLine {
  return { pageOverflow: 0, handle, faults: [] };
}

/** Measures the first line of the first subject card, or answers null while there is none. */
async function readSubjectLine(page: Page): Promise<SubjectLine | null> {
  try {
    return await page.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>('input[placeholder="Subject name"]');
      // The card is the field's nearest ancestor that also holds the subject's image
      // picker, and the line under test is the first thing in it.
      let card = field?.parentElement ?? null;
      while (card && !card.querySelector('input[type="file"]')) card = card.parentElement;
      const line = (card?.firstElementChild ?? null) as HTMLElement | null;
      const pill = Array.from(line?.querySelectorAll<HTMLElement>('*') ?? []).find((element) => (
        /^@\w+$/.test(element.textContent ?? '')
        && Array.from(element.children).every((child) => child.tagName === 'WBR')
      ));
      const remove = line?.querySelector<HTMLElement>('button[aria-label^="Remove "]');
      if (!field || !line || !pill || !remove) return null;

      const faults: string[] = [];
      const px = (value: number) => `${Math.round(value)}px`;
      const lineBox = line.getBoundingClientRect();
      const fieldBox = field.getBoundingClientRect();
      const pillBox = pill.getBoundingClientRect();
      const removeBox = remove.getBoundingClientRect();

      // Content that runs out of its box where it shows. The field is left out: a
      // text field scrolls what it cannot show.
      for (const element of [line, ...Array.from(line.querySelectorAll<HTMLElement>('*'))]) {
        if (
          element !== field
          && element.clientWidth > 0
          && getComputedStyle(element).overflowX === 'visible'
          && element.scrollWidth > element.clientWidth + 1
        ) {
          faults.push(`a ${element.clientWidth}px box holds ${element.scrollWidth}px of content: ${(element.textContent ?? '').slice(0, 40)}`);
        }
      }
      for (const [name, box] of [['the name field', fieldBox], ['the handle', pillBox], ['the remove button', removeBox]] as const) {
        if (box.left < lineBox.left - 1 || box.right > lineBox.right + 1) {
          faults.push(`${name} runs from ${px(box.left)} to ${px(box.right)}, outside its line at ${px(lineBox.left)} to ${px(lineBox.right)}`);
        }
      }

      // The name field and the handle share the line less the remove button and its
      // gap. The field's share of that room is half of it once the gap beside the
      // handle is out, or 160px where half is more.
      const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
      const room = line.clientWidth - removeBox.width - gap;
      const fieldShare = Math.min(room / 2 - gap, 160);
      if (fieldBox.width < fieldShare - 1) {
        faults.push(`the name field is ${px(fieldBox.width)} wide, under its share of ${px(fieldShare)}`);
      }

      // The remove button ends the name field's line, level with the field.
      const offLevel = Math.abs((removeBox.top + removeBox.bottom) / 2 - (fieldBox.top + fieldBox.bottom) / 2);
      if (offLevel > 1) {
        faults.push(`the remove button's middle is ${px(offLevel)} off the name field's`);
      }
      if (removeBox.right < lineBox.right - 1) {
        faults.push(`the remove button ends at ${px(removeBox.right)}, short of the end of its line at ${px(lineBox.right)}`);
      }

      // The handle shows whole. An inline box reports no width, which would pass.
      if (pill.clientWidth === 0) {
        faults.push('the handle has no box of its own to measure');
      } else if (pill.scrollWidth > pill.clientWidth + 1 || pill.scrollHeight > pill.clientHeight + 1) {
        faults.push(`a ${pill.clientWidth}x${pill.clientHeight}px pill holds ${pill.scrollWidth}x${pill.scrollHeight}px of handle`);
      }

      // The handle's width on one line: its text laid end to end, and its padding and border.
      const text = document.createRange();
      text.selectNodeContents(pill);
      const runs = Array.from(text.getClientRects()).filter((run) => run.width > 0);
      const lines = new Set(runs.map((run) => Math.round(run.top))).size;
      const pillStyle = getComputedStyle(pill);
      const whole = runs.reduce((sum, run) => sum + run.width, 0)
        + parseFloat(pillStyle.paddingLeft) + parseFloat(pillStyle.paddingRight)
        + parseFloat(pillStyle.borderLeftWidth) + parseFloat(pillStyle.borderRightWidth);

      const beside = pillBox.top < fieldBox.bottom - 1 && pillBox.bottom > fieldBox.top + 1;
      if (beside) {
        // Where everything fits, the three fill the line with only their gaps between them.
        if (
          Math.abs(fieldBox.left - lineBox.left) > 1
          || Math.abs(pillBox.left - fieldBox.right - gap) > 1
          || Math.abs(removeBox.left - pillBox.right - gap) > 1
        ) {
          faults.push('the name field, the handle and the remove button do not fill the line with only their gaps between them');
        }
        if (Math.abs((pillBox.top + pillBox.bottom) / 2 - (fieldBox.top + fieldBox.bottom) / 2) > 1) {
          faults.push('the handle beside the name field is not level with it');
        }
        // Wrapped beside the field, a handle would be a ribbon a few characters wide.
        if (lines > 1) {
          faults.push(`the handle wraps onto ${lines} lines beside the name field`);
        }
      } else {
        if (pillBox.top < fieldBox.bottom - 1 || Math.abs(pillBox.left - fieldBox.left) > 1) {
          faults.push('the handle is on a line of its own, but not under the start of the name field');
        }
        // It leaves the name's line only when it has to.
        if (fieldShare + gap + whole <= room + 1) {
          faults.push(`the handle is on a line of its own, though its ${px(whole)} fit beside a ${px(fieldShare)} name field in ${px(room)}`);
        }
        // And it wraps only when the line it then has is too short for it.
        if (lines > 1 && pillBox.width < room - 1) {
          faults.push(`the handle wraps onto ${lines} lines in ${px(pillBox.width)} of the ${px(room)} its line has`);
        }
      }

      const root = document.documentElement;
      return {
        pageOverflow: root.scrollWidth - root.clientWidth,
        handle: pill.textContent ?? '',
        faults,
      };
    });
  } catch (error) {
    // The dev server reloads open pages on its own (see kling-o3-named-subjects.spec.ts),
    // which tears the page down mid-read. Answer "unknown" and let the caller ask again.
    if (error instanceof Error && /Execution context was destroyed|frame was detached/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

async function addSubject(page: Page, name?: string) {
  await page.goto('/create-video?model=kling-o3');
  await expect(page.getByRole('heading', { name: 'Named subjects' })).toBeVisible();
  await page.getByRole('button', { name: 'Add subject' }).click();
  const field = page.getByPlaceholder('Subject name');
  await expect(field).toHaveValue('Subject 1');
  if (name) await field.fill(name);
}

async function expectSubjectLineInItsCard(page: Page, viewports: Array<{ width: number; height: number }>, handle: string) {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() => readSubjectLine(page), { message: `at ${viewport.width}px wide` })
      .toEqual(contained(handle));
  }
}

test.describe('Kling O3 subject card, first line', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
  });

  test('a long subject name keeps its field, and the remove button its place', async ({ page }) => {
    await addSubject(page, LONG_NAME);

    await expectSubjectLineInItsCard(page, [PHONE, SMALL_PHONE, LARGE_PHONE, DESKTOP], handleOf(LONG_NAME));
  });

  test('a handle wider than its own line breaks inside the card', async ({ page }) => {
    await addSubject(page, VERY_LONG_NAME);

    await expectSubjectLineInItsCard(page, [DESKTOP], handleOf(VERY_LONG_NAME));
  });

  test('a subject whose handle fits beside its name keeps the one line', async ({ page }) => {
    await addSubject(page);

    await expectSubjectLineInItsCard(page, [DESKTOP, PHONE, SMALL_PHONE], '@subject_1');
  });
});
