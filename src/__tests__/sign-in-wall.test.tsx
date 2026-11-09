import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SignInWall from '@/app/login/SignInWall';
import { signInWallColumnOrder } from '@/lib/sign-in-page';

// Next's image draws an <img>; here a plain one with the source it was given.
vi.mock('next/image', () => ({
  default: ({ src, alt, loading, fetchPriority }: { src: string | { src: string }; alt: string; loading?: 'eager' | 'lazy'; fetchPriority?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={typeof src === 'string' ? src : src.src} alt={alt} loading={loading} data-fetch-priority={fetchPriority} />
  ),
}));

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
    expect(img).toHaveAttribute('data-fetch-priority', 'low');
  });
});
