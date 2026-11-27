import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const taken = vi.hoisted(() => new Map<object, number>());
vi.mock('@/lib/keyed-masonry-layouts', () => ({
  takeKeyedMasonryShift: (data: object) => {
    const shift = taken.get(data) ?? 0;
    taken.delete(data);
    return shift;
  },
}));

import { useKeyedMasonryPlace, type KeyedMasonryList } from '@/lib/use-keyed-masonry-place';

function Screen({ list, data }: { list: KeyedMasonryList; data: readonly unknown[] }) {
  useKeyedMasonryPlace({ current: list }, data);
  return null;
}

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
});
