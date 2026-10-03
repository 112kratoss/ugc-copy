import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StudioElementHandleText } from '@/components/CreatorStudio';

function boxes(container: HTMLElement) {
  return Array.from(container.querySelectorAll('span'));
}

describe('creator studio element handle text', () => {
  it('reads as the sentence it was given', () => {
    const sentence = 'Unknown element mentions: @red_jacket, @blue_hat';
    const { container } = render(<p><StudioElementHandleText text={sentence} /></p>);

    // The same text as the string, so a screen reader reads it as before and a
    // handle copied off the page still matches.
    expect(container.textContent).toBe(sentence);
  });

  it('gives each handle a box of its own, with its comma inside', () => {
    const { container } = render(
      <p><StudioElementHandleText text="Unknown element mentions: @red_jacket, @blue_hat" /></p>,
    );

    // The boxes StudioElementHandleList draws: a browser will start a line with a
    // comma that follows an inline box, so the comma stays with its handle.
    // Whether a long handle then stays inside its sentence is a layout question,
    // and tests/e2e/handle-sentences.spec.ts answers it in a browser.
    expect(boxes(container).map((box) => box.innerHTML)).toEqual(['@red_<wbr>jacket,', '@blue_<wbr>hat']);
    for (const box of boxes(container)) {
      expect(box).toHaveClass('inline-block', 'max-w-full');
    }
    expect(container.querySelector('p')?.innerHTML).toBe(
      `Unknown element mentions: ${boxes(container)[0].outerHTML} ${boxes(container)[1].outerHTML}`,
    );
  });

  it('keeps the full stop that ends a sentence in the box of the last handle', () => {
    const { container } = render(
      <p><StudioElementHandleText text="Switch to Reusable references to use @red_jacket, @blue_hat." /></p>,
    );

    expect(boxes(container).map((box) => box.innerHTML)).toEqual(['@red_<wbr>jacket,', '@blue_<wbr>hat.']);
  });

  it('finds a handle in the middle of a sentence, and one in brackets', () => {
    const sentence = 'The mention @red_jacket (see @Blue_Hat) is not a reference here.';
    const { container } = render(<p><StudioElementHandleText text={sentence} /></p>);

    // A bracket written against a handle is part of its word, as a comma is.
    expect(boxes(container).map((box) => box.textContent)).toEqual(['@red_jacket', '@Blue_Hat)']);
    expect(container.textContent).toBe(sentence);
  });

  it('leaves a sentence that names no handle as the one text it was', () => {
    const sentence = 'Kling O3 supports up to 3 named subjects per run.';
    const { container } = render(<p><StudioElementHandleText text={sentence} /></p>);

    expect(boxes(container)).toHaveLength(0);
    expect(container.querySelector('p')?.childNodes).toHaveLength(1);
    expect(container.querySelector('p')?.innerHTML).toBe(sentence);
  });

  it('does not take an email address, or an @ that stands alone, for a handle', () => {
    const { container } = render(
      <p><StudioElementHandleText text="Write to help@example.com @ any time." /></p>,
    );

    expect(boxes(container)).toHaveLength(0);
  });
});
