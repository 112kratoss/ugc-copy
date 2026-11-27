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
  useKeyedMasonryPlace,
  type KeyedMasonryList,
} from '@/lib/use-keyed-masonry-place';

let onContentSizeChange: () => void = () => {};

function Screen({ list, data }: { list: KeyedMasonryList; data: readonly unknown[] }) {
  onContentSizeChange = useKeyedMasonryPlace({ current: list }, data);
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

  it('scrolls again as the content grows, when posts coming back sent the list further down', () => {
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

    // The scroll view stopped that one at the old end; FlashList has heard of it.
    list.getAbsoluteLastScrollOffset.mockReturnValue(6522);
    onContentSizeChange();
    expect(list.scrollToOffset).toHaveBeenCalledTimes(2);
    expect(list.scrollToOffset).toHaveBeenLastCalledWith({ offset: 7786, animated: false });

    onContentSizeChange();
    expect(list.scrollToOffset).toHaveBeenCalledTimes(2);
  });

  it('owes no second scroll to a later size change, or after posts left', () => {
    vi.useFakeTimers();
    const list = { getAbsoluteLastScrollOffset: vi.fn(() => 7786), scrollToOffset: vi.fn() };
    let view!: renderer.ReactTestRenderer;
    act(() => {
      view = renderer.create(<Screen list={list} data={['a', 'c']} />);
    });
    const back = ['a', 'b', 'c'];
    taken.set(back, 1264);
    act(() => view.update(<Screen list={list} data={back} />));
    vi.advanceTimersByTime(KEYED_MASONRY_PLACE_OWED_MS + 1);
    onContentSizeChange();
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);

    const fewer = ['a', 'c'];
    taken.set(fewer, -1264);
    act(() => view.update(<Screen list={list} data={fewer} />));
    onContentSizeChange();
    expect(list.scrollToOffset).toHaveBeenCalledTimes(2);
  });
});
