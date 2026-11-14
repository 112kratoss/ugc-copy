import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, render } from '@testing-library/react';
import postcss, { type Rule } from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ReelOpeningCover, { REEL_OPENING_COVER_MAX_MS } from '@/components/ReelOpeningCover';
import {
  isReelOpeningAddress,
  REEL_OPENING_ATTRIBUTE,
  REEL_OPENING_RESTORE,
  releaseReelOpening,
} from '@/lib/reel-opening-restore';

// A refresh on a post's reel address drew the grid, then the grid dimmed under "Opening
// preview", then the post (owner's recording, 2026-11-15). The root layout marks such an address
// before the first paint and the stylesheet covers the page with the reel's stage until the reel
// attaches (the viewer's half is showcase-reel-viewer-pagination's; the page in a browser is
// tests/e2e/reel-address-refresh.spec.ts).

const navigation = vi.hoisted(() => ({ pathname: '/showcase' }));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
}));

const ROOT = process.cwd();
const root = document.documentElement;

function restoreAt(address: string) {
  window.history.replaceState(null, '', address);
  new Function(REEL_OPENING_RESTORE)();
}

afterEach(() => {
  root.removeAttribute(REEL_OPENING_ATTRIBUTE);
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
});

describe('the reel address marked before the page draws', () => {
  it.each([
    ['/showcase?post=post-1', true],
    ['/showcase/?post=post-1', true],
    ['/showcase?category=video&post=post-1&media=2', true],
    ['/profile?tab=saved&post=post-1', true],
    ['/creators/someone?post=post-1#creator-unlocks', true],
    ['/showcase', false],
    ['/showcase?category=video', false],
    // A post page is the post itself: no reel opens over it.
    ['/showcase/post-1?post=post-1', false],
    ['/profile/edit?post=post-1', false],
    ['/creators/someone/extra?post=post-1', false],
    ['/?post=post-1', false],
    ['/search?q=cats&post=post-1', false],
  ])('%s: %s', (address, marked) => {
    restoreAt(address);

    expect(root.hasAttribute(REEL_OPENING_ATTRIBUTE)).toBe(marked);
    const url = new URL(address, 'https://magicbooklet.test');
    expect(isReelOpeningAddress(url.pathname, url.search)).toBe(marked);
  });

  it('is taken off when the reel draws, or is not coming', () => {
    restoreAt('/showcase?post=post-1');

    releaseReelOpening();

    expect(root.hasAttribute(REEL_OPENING_ATTRIBUTE)).toBe(false);
  });
});

describe("the reel's stage in the stylesheet", () => {
  const css = postcss.parse(readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8'));
  const rules = (selector: string) => {
    const found: Rule[] = [];
    css.walkRules((rule) => {
      if (rule.selector === selector) found.push(rule);
    });
    return found;
  };
  const declaration = (rule: Rule, prop: string) => {
    let value: string | null = null;
    rule.walkDecls(prop, (decl) => {
      value = decl.value;
    });
    return value;
  };

  it('draws nothing unless the root element is marked', () => {
    const [hidden] = rules('.reel-opening-cover');
    expect(declaration(hidden, 'display')).toBe('none');
  });

  it("covers the window with the reel's background, just under the reel", () => {
    const [shown] = rules('html[data-reel-opening] .reel-opening-cover');
    expect(declaration(shown, 'display')).toBe('flex');
    expect(declaration(shown, 'position')).toBe('fixed');
    expect(declaration(shown, 'inset')).toBe('0');

    // The reel's dialog is `fixed inset-0 z-[90] bg-[#050506]`: the stage is its colour, and
    // under it, so the reel draws over the stage should it attach before the mark goes.
    const viewer = readFileSync(path.join(ROOT, 'src/app/showcase/ShowcaseReelViewer.tsx'), 'utf8');
    expect(viewer).toContain('fixed inset-0 z-[90] overflow-hidden bg-[#050506]');
    expect(declaration(shown, 'background')).toBe('#050506');
    expect(Number(declaration(shown, 'z-index'))).toBeLessThan(90);
  });
});

describe('ReelOpeningCover', () => {
  beforeEach(() => {
    navigation.pathname = '/showcase';
  });

  it('gives the page back once the reel has had its longest wait', () => {
    vi.useFakeTimers();
    root.setAttribute(REEL_OPENING_ATTRIBUTE, '');
    render(<ReelOpeningCover />);

    act(() => {
      vi.advanceTimersByTime(REEL_OPENING_COVER_MAX_MS - 1);
    });
    expect(root.hasAttribute(REEL_OPENING_ATTRIBUTE)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(root.hasAttribute(REEL_OPENING_ATTRIBUTE)).toBe(false);
  });

  it('gives the page back when the reader is taken to another page first', () => {
    root.setAttribute(REEL_OPENING_ATTRIBUTE, '');
    navigation.pathname = '/profile';
    const { rerender } = render(<ReelOpeningCover />);
    expect(root.hasAttribute(REEL_OPENING_ATTRIBUTE)).toBe(true);

    // A signed-out profile goes to sign-in.
    navigation.pathname = '/login';
    rerender(<ReelOpeningCover />);

    expect(root.hasAttribute(REEL_OPENING_ATTRIBUTE)).toBe(false);
  });

  it('names what it stands for while it shows', () => {
    const { getByRole } = render(<ReelOpeningCover />);

    expect(getByRole('status')).toHaveTextContent('Opening post');
    expect(getByRole('status')).toHaveClass('reel-opening-cover');
  });
});
