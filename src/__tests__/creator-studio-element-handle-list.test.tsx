import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StudioElementHandleList } from '@/components/CreatorStudio';

describe('creator studio element handle list', () => {
  it('reads as the handles with a comma and a space between them', () => {
    const { container } = render(
      <p>
        Unknown element mentions: <StudioElementHandleList handles={['@red_jacket', '@blue_hat', '@scarf']} />
      </p>,
    );

    // The same text the sentence had when the handles were joined into it, so a
    // screen reader reads it as before and a copied handle still matches.
    expect(container.textContent).toBe('Unknown element mentions: @red_jacket, @blue_hat, @scarf');
  });

  it('gives each handle a box of its own, with its comma inside', () => {
    const { container } = render(
      <p>
        <StudioElementHandleList handles={['@red_jacket', '@blue_hat']} />
      </p>,
    );

    const boxes = Array.from(container.querySelectorAll('span'));

    // A browser will start a line with a comma that follows an inline box, so the
    // comma stays in the box of the handle before it. Each box is the shared
    // handle, with its line breaks after underscores. Whether a long handle then
    // stays inside its sentence is a layout question, and
    // tests/e2e/typed-mention-handles.spec.ts answers it in a browser.
    expect(boxes.map((box) => box.innerHTML)).toEqual(['@red_<wbr>jacket,', '@blue_<wbr>hat']);
    for (const box of boxes) {
      expect(box).toHaveClass('inline-block', 'max-w-full');
    }
  });

  it('adds no comma to a single handle', () => {
    const { container } = render(
      <p>
        <StudioElementHandleList handles={['@red_jacket']} />
      </p>,
    );

    expect(container.textContent).toBe('@red_jacket');
  });
});
