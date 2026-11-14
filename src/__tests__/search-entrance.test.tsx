import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The stable React the tests run on has no <ViewTransition> (Next draws the
// App Router with React's canary build, which has it). A stand-in records the
// props each part is drawn with on a wrapper, so the names and classes can be
// read; the fallback case below renders without it.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const ViewTransition = ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) =>
    actual.createElement('vt-boundary', { 'data-props': JSON.stringify(props) }, children);
  return { ...actual, default: actual, ViewTransition };
});

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string } & Record<string, unknown>) => {
    delete props.prefetch;
    return <a href={href} {...props}>{children}</a>;
  },
}));

import { SearchEntrancePart, SearchEntranceStandIn } from '@/components/search/SearchEntrancePart';
import { SearchEntryLink } from '@/components/search/SearchEntryLink';
import { SearchField } from '@/components/search/SearchField';
import {
  clearSearchEntrance,
  isPlainPress,
  markSearchEntrance,
  searchEntranceMoves,
  searchEntrancePending,
  searchEntranceTransition,
} from '@/components/search/search-entrance';

type Boundary = { props: Record<string, unknown>; element: Element };

function boundaries(container: HTMLElement): Boundary[] {
  return [...container.querySelectorAll('vt-boundary')].map((node) => ({
    props: JSON.parse(node.getAttribute('data-props') ?? '{}') as Record<string, unknown>,
    element: node.firstElementChild as Element,
  }));
}

afterEach(() => {
  cleanup();
  clearSearchEntrance();
  vi.unstubAllGlobals();
});

describe('search-entrance names and classes', () => {
  it('names each part for its control, and gives each side the class of the direction it arrives in', () => {
    expect(searchEntranceTransition('bar', 'capsule', 'field')).toEqual({ name: 'search-bar-capsule', share: 'search-open-capsule', default: 'none' });
    expect(searchEntranceTransition('bar', 'capsule', 'control')).toEqual({ name: 'search-bar-capsule', share: 'search-close-capsule', default: 'none' });
    expect(searchEntranceTransition('button', 'text', 'field')).toEqual({ name: 'search-button-text', share: 'search-open-text', default: 'none' });
    expect(searchEntranceTransition('entry', 'clear', 'control')).toEqual({ name: 'search-entry-clear', share: 'search-close-clear', default: 'none' });
  });

  it('keeps the control that was pressed for the page to read, for a few seconds, without taking it', () => {
    markSearchEntrance('entry', 1_000);
    expect(searchEntrancePending(1_000)).toBe('entry');
    expect(searchEntrancePending(11_000)).toBe('entry');
    expect(searchEntrancePending(11_001)).toBeNull();
    clearSearchEntrance();
    expect(searchEntrancePending(1_000)).toBeNull();
  });

  it('marks only a plain press: one that opens a new tab or window leaves this page as it is', () => {
    const press = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPlainPress(press)).toBe(true);
    expect(isPlainPress({ ...press, metaKey: true })).toBe(false);
    expect(isPlainPress({ ...press, ctrlKey: true })).toBe(false);
    expect(isPlainPress({ ...press, shiftKey: true })).toBe(false);
    expect(isPlainPress({ ...press, button: 1 })).toBe(false);
  });

  it('moves only where the browser has view transitions and reduced motion is not asked for', () => {
    expect(searchEntranceMoves()).toBe(false);
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: () => ({}) });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
    expect(searchEntranceMoves()).toBe(true);
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
    expect(searchEntranceMoves()).toBe(false);
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });
});

describe('the parts each end of the motion draws', () => {
  it('names the field\'s skin, magnifier, words and clear button for the control it opened from', () => {
    const { container } = render(<SearchField value="nano" onChange={() => {}} onClear={() => {}} entrance="bar" />);
    const parts = boundaries(container);
    expect(parts.map(({ props }) => [props.name, props.share, props.default])).toEqual([
      ['search-bar-capsule', 'search-open-capsule', 'none'],
      ['search-bar-icon', 'search-open-icon', 'none'],
      ['search-bar-text', 'search-open-text', 'none'],
      ['search-bar-clear', 'search-open-clear', 'none'],
    ]);
    // The skin is an element of its own under the rest, not the field around them: only it is ever stretched.
    const [skin, icon, text, clear] = parts.map(({ element }) => element);
    expect(skin.tagName).toBe('SPAN');
    expect(skin).toHaveAttribute('aria-hidden', 'true');
    expect(skin.contains(text)).toBe(false);
    expect(icon.tagName.toLowerCase()).toBe('svg');
    expect(text.tagName).toBe('INPUT');
    expect(clear).toHaveAccessibleName('Clear search');
  });

  it('draws the field at rest, named for nothing, when no control was pressed: still boundaries, so the screen cross-fades', () => {
    const { container } = render(<SearchField value="" onChange={() => {}} onClear={() => {}} />);
    const parts = boundaries(container);
    expect(parts).toHaveLength(3);
    expect(parts.every(({ props }) => props.name === undefined && props.default === 'none')).toBe(true);
  });

  it('names Explore\'s bar as a control, with an unseen stand-in for the clear button it has no use for', () => {
    const { container } = render(<SearchEntryLink />);
    const parts = boundaries(container);
    expect(parts.map(({ props }) => [props.name, props.share])).toEqual([
      ['search-entry-capsule', 'search-close-capsule'],
      ['search-entry-icon', 'search-close-icon'],
      ['search-entry-text', 'search-close-text'],
      ['search-entry-clear', 'search-close-clear'],
    ]);
    const standIn = parts[3].element;
    expect(standIn).toHaveAttribute('aria-hidden', 'true');
    expect(standIn).toHaveClass('pointer-events-none', 'absolute', 'opacity-0');
    // The link reads as before: its words, and nothing from the stand-in or the skin.
    expect(container.querySelector('a')).toHaveTextContent(/^Search$/);
    expect(container.querySelector('a')).toHaveAccessibleName('Search');
  });

  it('marks a plain press on Explore\'s bar, so the search page\'s field grows out of it', () => {
    const { container } = render(<SearchEntryLink />);
    const link = container.querySelector('a') as HTMLAnchorElement;
    link.addEventListener('click', (event) => event.preventDefault());
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(searchEntrancePending()).toBeNull();
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(searchEntrancePending()).toBe('entry');
  });

  it('draws a stand-in as a control\'s part, placed by its class', () => {
    const { container } = render(
      <div className="relative">
        <SearchEntranceStandIn origin="button" part="text" className="inset-y-0 left-9 right-0" />
        <SearchEntrancePart origin="button" part="icon" side="control"><svg /></SearchEntrancePart>
      </div>,
    );
    const [standIn, icon] = boundaries(container);
    expect(standIn.props).toEqual({ name: 'search-button-text', share: 'search-close-text', default: 'none' });
    expect(standIn.element).toHaveClass('left-9', 'opacity-0');
    expect(icon.props.name).toBe('search-button-icon');
  });
});
