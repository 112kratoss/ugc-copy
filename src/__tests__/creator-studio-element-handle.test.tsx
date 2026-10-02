import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StudioElementHandle } from '@/components/CreatorStudio';

function renderHandle(handle: string) {
  const view = render(<StudioElementHandle handle={handle} className="text-xs" />);
  return view.container.firstElementChild as HTMLElement;
}

describe('creator studio element handle', () => {
  it('offers a line break after each underscore', () => {
    expect(renderHandle('@image_reference_1').innerHTML).toBe('@image_<wbr>reference_<wbr>1');
    // Nothing to break at: the stylesheet's last resort takes over.
    expect(renderHandle('@img20261002173045').innerHTML).toBe('@img20261002173045');
  });

  it('adds no character to the handle, so one copied off the page still matches', () => {
    // A restored handle can carry doubled or trailing underscores.
    for (const handle of ['@element_1', '@protagonist_in_the_crimson_raincoat', '@a__b', '@trailing_', '@plain']) {
      expect(renderHandle(handle).textContent).toBe(handle);
    }
  });

  it('keeps the classes its card gives it', () => {
    // Whether the handle then fits its card is a layout question, and
    // tests/e2e/reference-card-handles.spec.ts answers it in a browser.
    expect(renderHandle('@element_1')).toHaveClass('text-xs');
  });
});
