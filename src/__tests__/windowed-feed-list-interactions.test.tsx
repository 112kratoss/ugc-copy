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
