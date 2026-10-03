import { fireEvent, render, screen } from '@testing-library/react';
import type { FormEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { StudioElementChip } from '@/components/CreatorStudio';

describe('creator studio element chip', () => {
  it('inserts its handle once when pressed', () => {
    const onInsert = vi.fn();
    render(<StudioElementChip displayName="Red jacket" handle="@red_jacket" onInsert={onInsert} />);

    fireEvent.click(screen.getByRole('button', { name: /^Red jacket\s*@red_jacket$/ }));

    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it('does not submit a form it sits in', () => {
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <StudioElementChip displayName="Red jacket" handle="@red_jacket" onInsert={() => {}} />
      </form>,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the whole name and the whole handle in the page, however little of the name shows', () => {
    // Cutting the name is the stylesheet's doing. The text itself stays, so a
    // screen reader still reads all of it and a copied handle still matches.
    const name = 'Protagonist in the crimson raincoat';
    const handle = '@protagonist_in_the_crimson_raincoat';
    render(<StudioElementChip displayName={name} handle={handle} handleClassName="text-sky-300" onInsert={() => {}} />);

    const [shownName, shownHandle] = Array.from(screen.getByRole('button').children);

    expect(shownName.textContent).toBe(name);
    expect(shownHandle.textContent).toBe(handle);
    // The handle is the shared one, with its line breaks after underscores and
    // the colour its creator gave it. Whether the chip then fits its row is a
    // layout question, and tests/e2e/reference-chip-overflow.spec.ts answers it
    // in a browser.
    expect(shownHandle.innerHTML).toBe('@protagonist_<wbr>in_<wbr>the_<wbr>crimson_<wbr>raincoat');
    expect(shownHandle).toHaveClass('text-sky-300');
  });
});
