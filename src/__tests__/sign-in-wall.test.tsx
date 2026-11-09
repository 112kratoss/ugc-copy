import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SignInWall from '@/app/login/SignInWall';
import { signInWallColumnOrder } from '@/lib/sign-in-page';

const pictureOf = (img: Element) => img.getAttribute('src')?.match(/wall-(\d\d)/)?.[1];

describe('the sign-in page’s wall', () => {
  it('is decoration: hidden from assistive tech, its pictures without words', () => {
    const { container } = render(<SignInWall start={0.25} />);
    const wall = container.firstElementChild as HTMLElement;
    expect(wall).toHaveClass('sign-in-wall');
    expect(wall).toHaveAttribute('aria-hidden', 'true');
    expect([...wall.querySelectorAll('img')].every((img) => img.getAttribute('alt') === '')).toBe(true);
  });

  it('starts every column at the visit’s point along its loop', () => {
    const { container } = render(<SignInWall start={0.123456} />);
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--sign-in-wall-start')).toBe('0.1235');
  });

  it('draws eleven columns, each its six pictures twice over in the app’s order, for a loop with no seam', () => {
    const { container } = render(<SignInWall start={0} />);
    const columns = [...container.querySelectorAll('.sign-in-wall-column')];
    expect(columns).toHaveLength(11);
    columns.forEach((column, index) => {
      const pictures = [...column.querySelectorAll('.sign-in-wall-tile img')].map(pictureOf);
      const set = signInWallColumnOrder(index).map((picture) => String(picture + 1).padStart(2, '0'));
      expect(pictures).toEqual([...set, ...set]);
    });
  });

  it('loads its pictures with the page but behind what the page needs first', () => {
    const { container } = render(<SignInWall start={0} />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('loading', 'eager');
    expect(img).toHaveAttribute('fetchpriority', 'low');
  });

  // Review of #744: plain images (no client component per tile), and a phone, which hides every
  // column after the fifth, fetches none of theirs.
  it('lets the columns a phone hides wait, so a phone fetches only what it draws', () => {
    const { container } = render(<SignInWall start={0} />);
    const columns = [...container.querySelectorAll('.sign-in-wall-column')];
    columns.forEach((column, index) => {
      const loading = [...column.querySelectorAll('img')].map((img) => img.getAttribute('loading'));
      expect(new Set(loading)).toEqual(new Set([index < 5 ? 'eager' : 'lazy']));
    });
  });
});
