import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const taken = vi.hoisted(() => new Map<object, number>());
vi.mock('@/lib/keyed-masonry-layouts', () => ({
  takeKeyedMasonryShift: (data: object) => {
    const shift = taken.get(data) ?? 0;
    taken.delete(data);
    return shift;
  },
}));

import {
  KEYED_MASONRY_PLACE_OWED_MS,
  KEYED_MASONRY_PLACE_RETRY_MS,
  useKeyedMasonryPlace,
  type KeyedMasonryList,
} from '@/lib/use-keyed-masonry-place';

let place!: ReturnType<typeof useKeyedMasonryPlace>;

function Screen({ list, data }: { list: KeyedMasonryList; data: readonly unknown[] }) {
  place = useKeyedMasonryPlace({ current: list }, data);
  return null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useKeyedMasonryPlace', () => {
  it('scrolls the native list to the offset the masonry moved to, once per change', () => {
    const list = { getAbsoluteLastScrollOffset: vi.fn(() => 4662), scrollToOffset: vi.fn() };
    const first = ['a', 'b', 'c'];
    let view!: renderer.ReactTestRenderer;
    act(() => {
      view = renderer.create(<Screen list={list} data={first} />);
    });
    expect(list.scrollToOffset).not.toHaveBeenCalled();

    const second = ['a', 'c'];
    taken.set(second, -538);
    act(() => view.update(<Screen list={list} data={second} />));
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 4662, animated: false });

    act(() => view.update(<Screen list={list} data={second} />));
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
  });

  it('leaves the list alone when the masonry kept its offset', () => {
    const list = { getAbsoluteLastScrollOffset: vi.fn(() => 0), scrollToOffset: vi.fn() };
    let view!: renderer.ReactTestRenderer;
    act(() => {
      view = renderer.create(<Screen list={list} data={['a']} />);
    });
    act(() => view.update(<Screen list={list} data={['a', 'b']} />));
    expect(list.scrollToOffset).not.toHaveBeenCalled();
  });

  function undo() {
    vi.useFakeTimers();
    const list = { getAbsoluteLastScrollOffset: vi.fn(() => 7786), scrollToOffset: vi.fn() };
    let view!: renderer.ReactTestRenderer;
    act(() => {
      view = renderer.create(<Screen list={list} data={['a', 'c']} />);
    });
    const back = ['a', 'b', 'c'];
    taken.set(back, 1264);
    act(() => view.update(<Screen list={list} data={back} />));
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
    return { list, view };
  }

  it('makes the scroll again until a scroll event says the list is there, when posts coming back sent it further down', () => {
    const { list } = undo();
    // The scroll view stopped the first one at the old end, and says so.
    place.onScroll(6522);
    expect(list.scrollToOffset).toHaveBeenCalledTimes(2);
    place.onContentSizeChange();
    expect(list.scrollToOffset).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(KEYED_MASONRY_PLACE_RETRY_MS[0]);
    expect(list.scrollToOffset).toHaveBeenCalledTimes(4);
    expect(list.scrollToOffset).toHaveBeenLastCalledWith({ offset: 7786, animated: false });

    // There: nothing more is owed, on any signal.
    place.onScroll(7786);
    place.onContentSizeChange();
    place.onScroll(7000);
    vi.advanceTimersByTime(KEYED_MASONRY_PLACE_OWED_MS);
    expect(list.scrollToOffset).toHaveBeenCalledTimes(4);
  });

  it('leaves the list where a scroll of the app\u2019s own took it, and owes nothing to other data', () => {
    const top = undo();
    // To the top: nowhere the cut-short scroll could have left the list.
    place.onScroll(0);
    place.onScroll(6522);
    vi.advanceTimersByTime(KEYED_MASONRY_PLACE_OWED_MS);
    expect(top.list.scrollToOffset).toHaveBeenCalledTimes(1);

    const next = undo();
    act(() => next.view.update(<Screen list={next.list} data={['a', 'b', 'c', 'd']} />));
    place.onScroll(6522);
    vi.advanceTimersByTime(KEYED_MASONRY_PLACE_OWED_MS);
    expect(next.list.scrollToOffset).toHaveBeenCalledTimes(1);
  });

  it('owes nothing once the reader takes hold of the list', () => {
    const { list } = undo();
    place.onScrollBeginDrag();
    place.onScroll(6522);
    place.onContentSizeChange();
    vi.advanceTimersByTime(KEYED_MASONRY_PLACE_OWED_MS);
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
  });

  it('stops trying when the time is up, when posts leave, and when the screen goes', () => {
    const first = undo();
    vi.advanceTimersByTime(KEYED_MASONRY_PLACE_OWED_MS + 1);
    const tries = first.list.scrollToOffset.mock.calls.length;
    expect(tries).toBe(1 + KEYED_MASONRY_PLACE_RETRY_MS.length);
    first.list.scrollToOffset.mockClear();
    place.onScroll(6522);
    expect(first.list.scrollToOffset).not.toHaveBeenCalled();

    const second = undo();
    const fewer = ['a', 'c'];
    taken.set(fewer, -1264);
    act(() => second.view.update(<Screen list={second.list} data={fewer} />));
    expect(second.list.scrollToOffset).toHaveBeenCalledTimes(2);
    place.onScroll(6522);
    vi.advanceTimersByTime(KEYED_MASONRY_PLACE_OWED_MS);
    expect(second.list.scrollToOffset).toHaveBeenCalledTimes(2);

    const third = undo();
    act(() => third.view.unmount());
    vi.advanceTimersByTime(KEYED_MASONRY_PLACE_OWED_MS);
    expect(third.list.scrollToOffset).toHaveBeenCalledTimes(1);
  });
});
