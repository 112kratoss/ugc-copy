import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useReaderScrolled } from '@/app/marketplace/useReaderScrolled';

// Marketplace asks for its next page by itself only once the reader has scrolled the listing
// (MarketplaceBootstrap, MarketplaceBrowser). Review of #888: the first rule read the window's place,
// and on Back React draws the listing and runs its effects inside the browser's popstate, before the
// browser puts the reader back where they were; that jump was taken for the reader's scroll and asked
// for a page nobody scrolled to. Only a gesture of the reader's counts now.

function Probe({ listingKey, scrolledAtStart = false }: { listingKey: string; scrolledAtStart?: boolean }) {
  const scrolled = useReaderScrolled(listingKey, scrolledAtStart);
  return (
    <>
      <output aria-label="Reader scrolled">{scrolled ? 'yes' : 'no'}</output>
      <input aria-label="Search recipes" />
      <div role="textbox" aria-label="Notes" contentEditable suppressContentEditableWarning>
        <p>Typed here</p>
      </div>
      <button type="button">
        <svg data-testid="button-icon" aria-hidden="true" />
        Load more recipes
      </button>
    </>
  );
}

const readerScrolled = () => screen.getByLabelText('Reader scrolled').textContent;

function pressAt(target: EventTarget, clientX: number, clientY: number, pointerType?: string) {
  act(() => {
    const event = new MouseEvent('pointerdown', { bubbles: true, clientX, clientY });
    if (pointerType) Object.defineProperty(event, 'pointerType', { value: pointerType });
    target.dispatchEvent(event);
  });
}

describe('useReaderScrolled', () => {
  afterEach(() => {
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    Reflect.deleteProperty(document.documentElement, 'clientWidth');
    Reflect.deleteProperty(document.documentElement, 'clientHeight');
  });

  it('never takes the window moving for a scroll of the reader\'s, Back\'s restored place included', () => {
    render(<Probe listingKey="all" />);

    act(() => {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 1_800 });
      window.dispatchEvent(new Event('scroll'));
    });

    expect(readerScrolled()).toBe('no');
  });

  it.each([
    ['a turn of the wheel', () => window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }))],
    ['a finger moving on the page', () => window.dispatchEvent(new Event('touchmove'))],
    ['Page Down', () => fireEvent.keyDown(document.body, { key: 'PageDown' })],
    ['the down arrow', () => fireEvent.keyDown(document.body, { key: 'ArrowDown' })],
    ['End', () => fireEvent.keyDown(document.body, { key: 'End' })],
    ['Space on the page', () => fireEvent.keyDown(document.body, { key: ' ' })],
  ])('counts %s', (_, gesture) => {
    render(<Probe listingKey="all" />);

    act(() => {
      gesture();
    });

    expect(readerScrolled()).toBe('yes');
  });

  it('takes no key typed in a field, no Space on a button it presses, and no other key', () => {
    render(<Probe listingKey="all" />);
    const search = screen.getByRole('textbox', { name: 'Search recipes' });
    const loadMore = screen.getByRole('button', { name: 'Load more recipes' });

    fireEvent.keyDown(search, { key: 'End' });
    fireEvent.keyDown(search, { key: ' ' });
    fireEvent.keyDown(screen.getByText('Typed here'), { key: 'PageDown' });
    fireEvent.keyDown(loadMore, { key: ' ' });
    // On the button's icon, an <svg>: an Element that is no HTMLElement.
    fireEvent.keyDown(screen.getByTestId('button-icon'), { key: ' ' });
    fireEvent.keyDown(loadMore, { key: 'Enter' });
    fireEvent.keyDown(document.body, { key: 'Tab' });

    expect(readerScrolled()).toBe('no');
  });

  // A press of "Load more recipes" asks for one page; a press on the window's scrollbar starts a drag.
  it('counts a press on the window\'s scrollbar, and no press on the page', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1_265 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
    render(<Probe listingKey="all" />);

    pressAt(screen.getByRole('button', { name: 'Load more recipes' }), 640, 400);
    expect(readerScrolled()).toBe('no');

    pressAt(document.documentElement, 1_272, 400);
    expect(readerScrolled()).toBe('yes');
  });

  // A phone's clientHeight can stay at the height with its toolbar shown, so a tap in the strip the
  // toolbar uncovers (a press of Load more at the bottom edge) sits past clientHeight; a finger has no scrollbar.
  it('takes no finger\'s press for a press on the scrollbar', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 412 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 780 });
    render(<Probe listingKey="all" />);

    pressAt(screen.getByRole('button', { name: 'Load more recipes' }), 206, 830, 'touch');
    expect(readerScrolled()).toBe('no');

    pressAt(document.documentElement, 206, 830, 'mouse');
    expect(readerScrolled()).toBe('yes');
  });

  it('starts another listing unscrolled, and takes a listing scrolled before it was drawn as scrolled', () => {
    const view = render(<Probe listingKey="all" scrolledAtStart />);
    expect(readerScrolled()).toBe('yes');

    view.rerender(<Probe listingKey="paid" scrolledAtStart />);
    expect(readerScrolled()).toBe('no');
    act(() => {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 900 });
      window.dispatchEvent(new Event('scroll'));
    });
    expect(readerScrolled()).toBe('no');

    act(() => {
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
    });
    expect(readerScrolled()).toBe('yes');
  });
});
