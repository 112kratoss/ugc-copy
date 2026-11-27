import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import WindowedFeedList, {
  FEED_WINDOW_MAX_MOUNTED_CARDS,
} from '@/app/feed/WindowedFeedList';

const items = Array.from({ length: 60 }, (_, index) => `item-${index}`);

function DraftCard({ id }: { id: string }) {
  const [draft, setDraft] = useState('');
  return (
    <label>
      {id}
      <textarea
        aria-label={`Draft ${id}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </label>
  );
}

describe('WindowedFeedList interactions', () => {
  let innerHeightDescriptor: PropertyDescriptor | undefined;
  let scrollYDescriptor: PropertyDescriptor | undefined;
  let frameCallback: FrameRequestCallback | null;

  beforeEach(() => {
    innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    scrollYDescriptor = Object.getOwnPropertyDescriptor(window, 'scrollY');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    frameCallback = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      frameCallback = null;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (innerHeightDescriptor) {
      Object.defineProperty(window, 'innerHeight', innerHeightDescriptor);
    }
    if (scrollYDescriptor) {
      Object.defineProperty(window, 'scrollY', scrollYDescriptor);
    }
  });

  it('keeps an active card and its draft mounted outside the viewport', async () => {
    const { container } = render(
      <WindowedFeedList
        items={items}
        getKey={(item) => item}
        pinnedKeys={new Set(['item-0'])}
        renderItem={(item) => <DraftCard id={item} />}
      />,
    );

    fireEvent.change(screen.getByLabelText('Draft item-0'), {
      target: { value: 'Keep this unsent reply' },
    });
    const list = container.querySelector<HTMLElement>('[data-feed-windowed-list]');
    vi.spyOn(list!, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: -window.scrollY,
      top: -window.scrollY,
      left: 0,
      right: 680,
      bottom: 39_108 - window.scrollY,
      width: 680,
      height: 39_108,
      toJSON: () => ({}),
    }));
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 20_000 });
    fireEvent.scroll(window);
    act(() => frameCallback?.(0));

    await waitFor(() => expect(screen.getByLabelText('Draft item-30')).toBeInTheDocument());
    expect(screen.getByLabelText('Draft item-0')).toHaveValue('Keep this unsent reply');
    // The normal viewport remains bounded; the one explicit active card is the
    // only reason this render may exceed the ordinary cap.
    expect(container.querySelectorAll('[data-feed-window-key]').length)
      .toBeLessThanOrEqual(FEED_WINDOW_MAX_MOUNTED_CARDS + 1);
  });

  it('does not re-render the mounted cards for a scroll that mounts the same ones', () => {
    const renderItem = vi.fn((item: string) => <p>{item}</p>);
    const { container } = render(
      <WindowedFeedList items={items} getKey={(item) => item} renderItem={renderItem} />,
    );
    const list = container.querySelector<HTMLElement>('[data-feed-windowed-list]');
    vi.spyOn(list!, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: -window.scrollY,
      top: -window.scrollY,
      left: 0,
      right: 680,
      bottom: 39_108 - window.scrollY,
      width: 680,
      height: 39_108,
      toJSON: () => ({}),
    }));
    const settledCalls = renderItem.mock.calls.length;

    // A few pixels: the same cards stay mounted, so nothing should re-render.
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 12 });
    fireEvent.scroll(window);
    act(() => frameCallback?.(0));

    expect(renderItem.mock.calls.length).toBe(settledCalls);

    // Far enough to mount other cards: that is a real change.
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 20_000 });
    fireEvent.scroll(window);
    act(() => frameCallback?.(0));

    expect(renderItem.mock.calls.length).toBeGreaterThan(settledCalls);
  });

  // Back to Home: the browser puts the scroll back after the list has mounted
  // the feed's first cards. Taken a frame later, as every other scroll is, the
  // first frame drew those cards far above the window and nothing in it
  // (tests/e2e/home-back-keeps-place.spec.ts).
  it('mounts the cards at the window before its first frame, and from then on at the next frame', () => {
    const { container } = render(
      <WindowedFeedList items={items} getKey={(item) => item} renderItem={(item) => <p>{item}</p>} />,
    );
    const list = container.querySelector<HTMLElement>('[data-feed-windowed-list]');
    vi.spyOn(list!, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: -window.scrollY,
      top: -window.scrollY,
      left: 0,
      right: 680,
      bottom: 39_108 - window.scrollY,
      width: 680,
      height: 39_108,
      toJSON: () => ({}),
    }));
    expect(screen.getByText('item-0')).toBeInTheDocument();
    // The frame the list asked for as it mounted: its first.
    const firstFrame = frameCallback;
    expect(firstFrame).not.toBeNull();

    // The scroll put back before that frame: the cards there are mounted at once.
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 20_000 });
    fireEvent.scroll(window);
    expect(screen.getByText('item-30')).toBeInTheDocument();
    expect(screen.queryByText('item-0')).not.toBeInTheDocument();

    // After the first frame a scroll waits for the next one, as before.
    act(() => firstFrame?.(0));
    frameCallback = null;
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    fireEvent.scroll(window);
    expect(screen.queryByText('item-0')).not.toBeInTheDocument();
    act(() => frameCallback?.(0));
    expect(screen.getByText('item-0')).toBeInTheDocument();
  });

  // A card is placed, and every card after it, by the height it was measured
  // at. Mounted again (it left the window and is back, or the reader came Back
  // to the page), it is told so, and the feed's card lays itself out in full: a
  // card that skips its layout off screen would be measured at its
  // placeholder's height and move the cards after it (owner's report,
  // 2026-11-27: Back to Home landed away from the card that was left).
  it('tells a card whether this document has measured it before this mount', () => {
    let measure: ResizeObserverCallback = () => undefined;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        measure = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const cards = ['drawn-before-card', 'never-drawn-card'];
    const drawnBefore = new Map<string, boolean[]>();
    const renderItem = (item: string, _index: number, before: boolean) => {
      drawnBefore.set(item, [...(drawnBefore.get(item) ?? []), before]);
      return <p>{item}</p>;
    };

    // A first visit: neither card has been measured.
    const first = render(<WindowedFeedList items={cards} getKey={(item) => item} renderItem={renderItem} />);
    const measured = first.container.querySelector<HTMLElement>('[data-feed-window-key="drawn-before-card"]')!;
    vi.spyOn(measured, 'getBoundingClientRect').mockReturnValue({ height: 912 } as DOMRect);
    act(() => measure([{ target: measured } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    // The measure changes nothing for the card while it stays mounted.
    expect(new Set(drawnBefore.get('drawn-before-card'))).toEqual(new Set([false]));
    expect(new Set(drawnBefore.get('never-drawn-card'))).toEqual(new Set([false]));
    first.unmount();
    drawnBefore.clear();

    // The reader comes back: the card that was measured is told so, the other is not.
    render(<WindowedFeedList items={cards} getKey={(item) => item} renderItem={renderItem} />);
    expect(new Set(drawnBefore.get('drawn-before-card'))).toEqual(new Set([true]));
    expect(new Set(drawnBefore.get('never-drawn-card'))).toEqual(new Set([false]));
  });

  it('mounts keyboard runway as focus reaches the edge of the window', async () => {
    const { container } = render(
      <WindowedFeedList
        items={items}
        getKey={(item) => item}
        renderItem={(item) => <button type="button">{`Open ${item}`}</button>}
      />,
    );

    // At this viewport size, the measured window ends at item 3. Focusing that
    // boundary card should mount item 4 before the next Tab key is pressed.
    const boundaryButton = await screen.findByRole('button', { name: 'Open item-3' });
    fireEvent.focus(boundaryButton);
    const nextButton = await screen.findByRole('button', { name: 'Open item-4' });

    fireEvent.focus(nextButton);
    expect(await screen.findByRole('button', { name: 'Open item-5' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-feed-window-key]').length)
      .toBeLessThanOrEqual(FEED_WINDOW_MAX_MOUNTED_CARDS + 2);
  });
});
