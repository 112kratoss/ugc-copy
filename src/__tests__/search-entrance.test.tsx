import { cleanup, fireEvent, render } from '@testing-library/react';
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

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('next/form', () => ({
  default: ({ action, children, ...props }: { action: string; children: React.ReactNode } & Record<string, unknown>) => (
    <form action={action} {...props}>{children}</form>
  ),
}));
vi.mock('@/lib/use-leave-guard', () => ({ holdForLeaveGuard: () => false }));

import { AppShellSearch, AppShellSearchButton } from '@/components/AppShellSearch';
import { SearchEntrancePart, SearchEntranceStandIn, useSearchScreenCrossFade } from '@/components/search/SearchEntrancePart';
import { SearchEntryLink } from '@/components/search/SearchEntryLink';
import { SearchField } from '@/components/search/SearchField';
import {
  clearSearchEntrance,
  isPlainPress,
  isSearchPageShown,
  markSearchEntrance,
  noteSearchPageShown,
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
  noteSearchPageShown(false);
  vi.unstubAllGlobals();
});

/** A press on a link, its navigation held: jsdom has none. */
function press(link: Element, init: MouseEventInit = {}) {
  link.addEventListener('click', (event) => event.preventDefault(), { once: true });
  fireEvent.click(link, { button: 0, ...init });
}

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

  it('shows the field\'s focus on its skin, which travels, not around the label, which fades (review of #817)', () => {
    // The label named `ui-focus-within-ring`, a class no sheet defines: the
    // field showed no focus but the caret.
    const { container } = render(<SearchField value="" onChange={() => {}} onClear={() => {}} entrance="entry" />);
    const label = container.querySelector('label');
    const skin = container.querySelector('[data-search-field-skin]');
    expect(label?.classList.contains('group')).toBe(true);
    expect(label?.className).not.toMatch(/focus/);
    expect(skin?.classList.contains('group-focus-within:border-[var(--ui-focus)]')).toBe(true);
    expect(boundaries(container)[0].element).toBe(skin);
  });

  it('draws the field at rest, named for nothing, when no control was pressed: still boundaries, so the screen cross-fades', () => {
    const { container } = render(<SearchField value="" onChange={() => {}} onClear={() => {}} />);
    const parts = boundaries(container);
    expect(parts).toHaveLength(3);
    expect(parts.every(({ props }) => props.name === undefined && props.default === 'none')).toBe(true);
  });

  it('draws Explore\'s bar as itself at rest: no part named, no boundary to start a transition (review of #817)', () => {
    // Explore draws the bar in its loading state and again in its page: named
    // at rest, the two copies paired as React revealed the page, and the bar
    // ran the close with nothing to close.
    const { container } = render(<SearchEntryLink />);
    expect(boundaries(container)).toEqual([]);
    const standIn = container.querySelector('[data-search-entrance-stand-in="clear"]');
    expect(standIn).toHaveAttribute('aria-hidden', 'true');
    expect(standIn).toHaveClass('pointer-events-none', 'absolute', 'opacity-0');
    // The link reads as before: its words, and nothing from the stand-in or the skin.
    expect(container.querySelector('a')).toHaveTextContent(/^Search$/);
    expect(container.querySelector('a')).toHaveAccessibleName('Search');
  });

  it('names Explore\'s bar as a control once pressed, before the navigation, and marks the press', () => {
    const { container } = render(<SearchEntryLink />);
    const link = container.querySelector('a') as HTMLAnchorElement;
    press(link, { metaKey: true });
    expect(searchEntrancePending()).toBeNull();
    expect(boundaries(container)).toEqual([]);

    press(link);
    expect(searchEntrancePending()).toBe('entry');
    const parts = boundaries(container);
    expect(parts.map(({ props }) => [props.name, props.share])).toEqual([
      ['search-entry-capsule', 'search-close-capsule'],
      ['search-entry-icon', 'search-close-icon'],
      ['search-entry-text', 'search-close-text'],
      ['search-entry-clear', 'search-close-clear'],
    ]);
    expect(parts[3].element).toHaveAttribute('aria-hidden', 'true');
  });

  it('names Explore\'s bar drawn while the search page is, so the field shrinks back into it', () => {
    noteSearchPageShown(true);
    const { container } = render(<SearchEntryLink />);
    expect(boundaries(container).map(({ props }) => props.name)).toEqual([
      'search-entry-capsule',
      'search-entry-icon',
      'search-entry-text',
      'search-entry-clear',
    ]);
    // One drawn after the search page has gone (the page swapping in for its loading state) is not.
    noteSearchPageShown(false);
    expect(isSearchPageShown()).toBe(false);
    const later = render(<SearchEntryLink />);
    expect(boundaries(later.container)).toEqual([]);
  });

  it('names the top bar\'s field as a control, with a stand-in for its clear button while it holds no text', () => {
    const { container, getByRole } = render(<AppShellSearch />);
    expect(boundaries(container).map(({ props }) => [props.name, props.share])).toEqual([
      ['search-bar-capsule', 'search-close-capsule'],
      ['search-bar-icon', 'search-close-icon'],
      ['search-bar-text', 'search-close-text'],
      ['search-bar-clear', 'search-close-clear'],
    ]);
    const [skin, , text, clear] = boundaries(container).map(({ element }) => element);
    expect(skin).toHaveAttribute('aria-hidden', 'true');
    expect(text.tagName).toBe('INPUT');
    expect(clear).toHaveAttribute('data-search-entrance-stand-in', 'clear');

    // With text, the real clear button takes the name, and the stand-in goes.
    fireEvent.change(getByRole('combobox'), { target: { value: 'neon' } });
    const named = boundaries(container);
    expect(named.map(({ props }) => props.name)).toEqual(['search-bar-capsule', 'search-bar-icon', 'search-bar-text', 'search-bar-clear']);
    expect(named[3].element).toHaveAccessibleName('Clear search');
    expect(container.querySelector('[data-search-entrance-stand-in]')).toBeNull();
  });

  it('marks a search from the top bar\'s field on Enter', () => {
    const { getByRole } = render(<AppShellSearch />);
    const box = getByRole('combobox');
    fireEvent.change(box, { target: { value: 'neon city' } });
    const form = box.closest('form') as HTMLFormElement;
    form.addEventListener('submit', (event) => event.preventDefault(), { once: true });
    fireEvent.submit(form);
    expect(searchEntrancePending()).toBe('bar');
  });

  it('names the top bar\'s round magnifier as a control, with stand-ins for the words and clear button it has none of', () => {
    const { container } = render(<AppShellSearchButton />);
    const parts = boundaries(container);
    expect(parts.map(({ props }) => [props.name, props.share])).toEqual([
      ['search-button-capsule', 'search-close-capsule'],
      ['search-button-icon', 'search-close-icon'],
      ['search-button-text', 'search-close-text'],
      ['search-button-clear', 'search-close-clear'],
    ]);
    expect(parts[2].element).toHaveAttribute('data-search-entrance-stand-in', 'text');
    expect(parts[3].element).toHaveAttribute('data-search-entrance-stand-in', 'clear');
    for (const { element } of parts.slice(2)) {
      expect(element).toHaveAttribute('aria-hidden', 'true');
      expect(element).toHaveClass('pointer-events-none', 'opacity-0', 'left-9');
    }
    const link = container.querySelector('a') as HTMLAnchorElement;
    expect(link).toHaveAttribute('href', '/search');
    expect(link).toHaveAccessibleName('Search creators, posts, and recipes');
    expect(link).toHaveTextContent('');
  });

  it('marks only a plain press on the top bar\'s round magnifier', () => {
    const { container } = render(<AppShellSearchButton />);
    const link = container.querySelector('a') as HTMLAnchorElement;
    press(link, { ctrlKey: true });
    expect(searchEntrancePending()).toBeNull();
    press(link);
    expect(searchEntrancePending()).toBe('button');
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

describe('the screen\'s cross-fade', () => {
  function CrossFade() {
    useSearchScreenCrossFade();
    return null;
  }

  afterEach(() => {
    document.documentElement.style.viewTransitionName = '';
  });

  it('keeps the document root in the transition while the search page is drawn, and clears only the name it wrote', () => {
    const page = render(<CrossFade />);
    expect(document.documentElement.style.viewTransitionName).toBe('root');
    page.unmount();
    expect(document.documentElement.style.viewTransitionName).toBe('');
  });

  it('leaves a root name another page set first (review of #817)', () => {
    document.documentElement.style.viewTransitionName = 'root';
    const page = render(<CrossFade />);
    page.unmount();
    expect(document.documentElement.style.viewTransitionName).toBe('root');
  });
});
