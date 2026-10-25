import { act, render, screen, within } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HomeShelf, { formatHomeShelfPrice, homeShelfActionCopy } from '@/components/HomeShelf';
import type { HomeShelfCreation, HomeShelfItem } from '@/lib/home-shelf';

vi.mock('next/link', () => ({
  default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
    <a {...props} data-prefetch={prefetch === undefined ? undefined : String(prefetch)} />
  ),
}));

// next/image needs the Next runtime; the poster's own markup is not under test.
vi.mock('@/components/OptimizedPreviewImage', () => ({
  OptimizedPreviewImage: ({ previewSrc }: { previewSrc: string }) => <span data-testid="poster" data-src={previewSrc} />,
}));

function creation(id: string, overrides: Partial<HomeShelfCreation> = {}): HomeShelfCreation {
  return {
    kind: 'creation',
    id,
    title: `Creation ${id}`,
    tool: 'video',
    posterUrl: `https://cdn.example.test/${id}/poster.webp`,
    posterThumbhash: null,
    clipUrl: `https://cdn.example.test/${id}/stream.mp4`,
    modelName: 'Grok Imagine',
    price: { kind: 'credits', credits: 15 },
    fitsWelcomeCredits: true,
    badge: null,
    creator: { username: 'magicbooklet', name: 'Magicbooklet Team', avatar: null },
    makeHref: `/create-video?remix=generation-${id}&remixPost=${id}`,
    ...overrides,
  };
}

const SHELF: HomeShelfItem[] = [creation('a'), creation('b'), creation('c')];

type ObserverCallback = (entries: Array<{ target: Element; intersectionRatio: number }>) => void;

let observerCallback: ObserverCallback | null = null;
let observed: Element[] = [];

function stubMatchMedia(reduceMotion: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduceMotion && query.includes('prefers-reduced-motion'),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  observerCallback = null;
  observed = [];
  stubMatchMedia(false);
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: ObserverCallback) {
      observerCallback = callback;
    }
    observe(element: Element) {
      observed.push(element);
    }
    disconnect() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function reportVisible(ratios: Record<string, number>) {
  act(() => {
    observerCallback?.(observed.map((target) => ({
      target,
      intersectionRatio: ratios[(target as HTMLElement).dataset.clipId ?? ''] ?? 0,
    })));
  });
}

describe('HomeShelf', () => {
  it('draws nothing for an empty shelf', () => {
    const { container } = render(<HomeShelf items={[]} offerFreeToTry />);

    expect(container).toBeEmptyDOMElement();
  });

  it('links each creation to its remix and ends on the tools', () => {
    render(<HomeShelf items={SHELF} offerFreeToTry={false} />);

    const shelf = screen.getByRole('region', { name: 'Make this' });
    const links = within(shelf).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/showcase',
      '/create-video?remix=generation-a&remixPost=a',
      '/create-video?remix=generation-b&remixPost=b',
      '/create-video?remix=generation-c&remixPost=c',
      '/create-image',
      '/create-video',
      '/create-motion',
    ]);
    expect(links.every((link) => link.getAttribute('data-prefetch') === 'false')).toBe(true);
  });

  it('shows one badge: a launch over "Free to try", and "Free to try" only when offered', () => {
    const { rerender } = render(
      <HomeShelf items={[creation('a', { badge: 'new-model' }), creation('b'), creation('c', { fitsWelcomeCredits: false })]} offerFreeToTry />,
    );
    const cards = () => screen.getAllByRole('link').filter((link) => link.getAttribute('href')?.startsWith('/create-video?'));

    expect(cards()[0]).toHaveTextContent('New model');
    expect(cards()[0]).not.toHaveTextContent('Free to try');
    expect(cards()[1]).toHaveTextContent('Free to try');
    expect(cards()[2]).not.toHaveTextContent('Free to try');

    rerender(<HomeShelf items={SHELF} offerFreeToTry={false} />);
    expect(screen.queryByText('Free to try')).toBeNull();
  });

  it('plays the clip of the first card in view only, and hands it on', () => {
    const { container } = render(<HomeShelf items={SHELF} offerFreeToTry={false} />);
    expect(container.querySelectorAll('video')).toHaveLength(0);

    reportVisible({ a: 1, b: 1, c: 0.2 });
    expect(container.querySelectorAll('video')).toHaveLength(1);
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://cdn.example.test/a/stream.mp4');

    reportVisible({ a: 0.1, b: 1, c: 1 });
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://cdn.example.test/b/stream.mp4');
  });

  it('plays nothing under Reduce Motion', () => {
    stubMatchMedia(true);
    const { container } = render(<HomeShelf items={SHELF} offerFreeToTry={false} />);

    reportVisible({ a: 1, b: 1, c: 1 });

    expect(container.querySelectorAll('video')).toHaveLength(0);
  });

  it('draws the offers it is given in their place', () => {
    render(<HomeShelf
      items={[
        creation('a'),
        creation('b'),
        { kind: 'action', id: 'post' },
        creation('c'),
        { kind: 'action', id: 'invite', inviterPercent: 5, inviteePercent: 5 },
      ]}
      offerFreeToTry={false}
    />);

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs.indexOf('/post/new')).toBe(hrefs.indexOf('/create-video?remix=generation-b&remixPost=b') + 1);
    expect(hrefs.indexOf('/invite')).toBe(hrefs.indexOf('/create-image') - 1);
  });
});

describe('formatHomeShelfPrice', () => {
  it('names credits, motion pricing, or nothing', () => {
    expect(formatHomeShelfPrice({ kind: 'credits', credits: 15 })).toBe('15 credits');
    expect(formatHomeShelfPrice({ kind: 'credits', credits: 1 })).toBe('1 credit');
    expect(formatHomeShelfPrice({ kind: 'clip-length' })).toBe('Priced by clip length');
    expect(formatHomeShelfPrice(null)).toBeNull();
  });
});

describe('homeShelfActionCopy', () => {
  it('states the live referral terms, leaving out a side that earns nothing', () => {
    expect(homeShelfActionCopy({ kind: 'action', id: 'invite', inviterPercent: 5, inviteePercent: 5 }).body)
      .toBe('You get 5% of their top-ups in credits. They get 5% extra on their first.');
    expect(homeShelfActionCopy({ kind: 'action', id: 'invite', inviterPercent: 2.5, inviteePercent: 0 }).body)
      .toBe('You get 2.5% of their top-ups in credits.');
  });

  it('states the creator share the sell page promises', () => {
    expect(homeShelfActionCopy({ kind: 'action', id: 'earn', creatorSharePercent: 85 })).toMatchObject({
      title: 'Earn from your prompts',
      body: 'Add a recipe to a post, set a price, and keep 85% of each sale.',
      href: '/marketplace/sell',
    });
  });
});
