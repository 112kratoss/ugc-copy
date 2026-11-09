import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import BrandWordmark from '@/components/BrandWordmark';

describe('BrandWordmark', () => {
  it('is the app’s lockup: a coral sparkle, then the name in the text colour, in the display face', () => {
    const { container } = render(<h1><BrandWordmark className="text-[40px]" /></h1>);

    expect(screen.getByRole('heading')).toHaveTextContent(/^Magic Booklet$/);
    const lockup = container.querySelector('h1 > span')!;
    // `font-bricolage-grotesque` is the test stand-in's class for the display face (mocks/next-font-google.ts).
    expect(lockup).toHaveClass('font-bricolage-grotesque', 'font-extrabold', 'text-[40px]');
    // One colour: the name takes the text colour around it, as the app's lockup does.
    const name = screen.getByText('Magic Booklet');
    expect(name.className).toBe('');
    expect(container.innerHTML).not.toMatch(/accent-motion/);

    const sparkle = container.querySelector('[data-brand-sparkle]');
    expect(sparkle).toHaveAttribute('aria-hidden', 'true');
    expect(sparkle).toHaveClass('text-[var(--ui-primary)]');
    expect(sparkle?.compareDocumentPosition(name) ?? 0 & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
