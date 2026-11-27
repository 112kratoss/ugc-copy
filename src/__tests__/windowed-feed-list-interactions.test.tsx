import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import WindowedFeedList, {
  FEED_CARD_PLACEHOLDER_ATTRIBUTE,
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

  // A card is placed, and every card after it, by the height it was drawn at.
  // Mounted again (it left the window and is back, or the reader came Back to
  // the page), it is told so, and the feed's card lays itself out in full: a
  // card that skips its layout off screen would be measured at its
  // placeholder's height and move the cards after it (owner's report,
  // 2026-11-27: Back to Home landed away from the card that was left).
  describe('telling a card it was drawn before this mount', () => {
    let measure: ResizeObserverCallback;
    const told = new Map<string, boolean[]>();
    const toldOf = (item: string) => [...new Set(told.get(item))];
    /** What the browser renders of a placeholder's contents, card by card: all of it unless said here. */
    const skipped = new Set<string>();
    /**
     * A card as the feed's is: a placeholder until it has been drawn before,
     * its part answering the browser's `checkVisibility` (jsdom has none).
     */
    const renderItem = (item: string, _index: number, before: boolean) => {
      told.set(item, [...(told.get(item) ?? []), before]);
      return (
        <article {...(before ? {} : { [FEED_CARD_PLACEHOLDER_ATTRIBUTE]: '' })}>
          <p
            ref={(part) => {
              if (part) Object.assign(part, { checkVisibility: () => !skipped.has(item) });
            }}
          >
            {item}
          </p>
        </article>
      );
    };
    /** The list's own measure of a mounted card, as the observer reports it. */
    const measureAt = (item: string, height: number) => {
      const wrapper = screen.getByText(item).closest<HTMLElement>('[data-feed-window-key]')!;
      vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({ height } as DOMRect);
      act(() => measure([{ target: wrapper } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    };
    const mount = (cards: string[]) => {
      told.clear();
      return render(<WindowedFeedList items={cards} getKey={(item) => item} renderItem={renderItem} />);
    };

    beforeEach(() => {
      told.clear();
      skipped.clear();
      measure = () => undefined;
      vi.stubGlobal('ResizeObserver', class {
        constructor(callback: ResizeObserverCallback) {
          measure = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      });
    });

    // A reader who jumps down the feed passes cards that are mounted, and
    // measured, and never drawn: all the list has of one is its placeholder's
    // height. Taken for drawn because it "had been measured", it was laid out
    // in full on the way back, took its own height, and moved every card
    // after it (review of d6700f26a; the spec's short laptop window).
    it('goes by a measure taken while the card was laid out, not by any measure of it', () => {
      const cards = ['laid-out-card', 'skipped-card', 'unmeasured-card'];

      const first = mount(cards);
      // Drawn: measured at its own height while the browser renders what is in it.
      measureAt('laid-out-card', 912);
      // Mounted off screen: measured at the placeholder's height, its contents skipped.
      skipped.add('skipped-card');
      measureAt('skipped-card', 642);
      // Nothing changes for a card while it stays mounted.
      for (const item of cards) expect(toldOf(item)).toEqual([false]);
      first.unmount();

      const second = mount(cards);
      expect(toldOf('laid-out-card')).toEqual([true]);
      expect(toldOf('skipped-card')).toEqual([false]);
      expect(toldOf('unmeasured-card')).toEqual([false]);

      // The skipped card comes near the window and is drawn: its next measure is
      // its own, and from its next mount on it is laid out in full.
      skipped.delete('skipped-card');
      measureAt('skipped-card', 730);
      second.unmount();
      mount(cards);
      expect(toldOf('skipped-card')).toEqual([true]);
    });

    // The page's first cards are drawn before the list's script runs, and the
    // list's first measure of one finds it at the height it already holds for it.
    it('takes a card measured laid out at the height already held as drawn', () => {
      const cards = ['held-height-card'];

      const first = mount(cards);
      skipped.add('held-height-card');
      measureAt('held-height-card', 642);
      first.unmount();

      const second = mount(cards);
      expect(toldOf('held-height-card')).toEqual([false]);
      // Laid out now, at a height that happens to be the one held.
      skipped.delete('held-height-card');
      measureAt('held-height-card', 642);
      second.unmount();

      mount(cards);
      expect(toldOf('held-height-card')).toEqual([true]);
    });

    it('takes a measured card as drawn where it names no placeholder, or the browser cannot say', () => {
      const plain = new Map<string, boolean[]>();
      const cards = ['no-placeholder-card', 'no-answer-card'];
      const renderPlain = (item: string, _index: number, before: boolean) => {
        plain.set(item, [...(plain.get(item) ?? []), before]);
        // The second names a placeholder whose part has no `checkVisibility`, as in a browser without it.
        return item === 'no-answer-card'
          ? <article {...{ [FEED_CARD_PLACEHOLDER_ATTRIBUTE]: '' }}><p>{item}</p></article>
          : <p>{item}</p>;
      };

      const first = render(<WindowedFeedList items={cards} getKey={(item) => item} renderItem={renderPlain} />);
      measureAt('no-placeholder-card', 912);
      measureAt('no-answer-card', 912);
      first.unmount();
      plain.clear();

      render(<WindowedFeedList items={cards} getKey={(item) => item} renderItem={renderPlain} />);
      expect([...new Set(plain.get('no-placeholder-card'))]).toEqual([true]);
      expect([...new Set(plain.get('no-answer-card'))]).toEqual([true]);
    });
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
