import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  scrollOffsetBackWithinContent,
  useScrollWithinContent,
  type ScrollWithinContentList,
} from '@/lib/use-scroll-within-content';

const { platform } = vi.hoisted(() => ({ platform: { OS: 'android' as string } }));

vi.mock('react-native', () => ({ Platform: platform }));

describe('scrollOffsetBackWithinContent', () => {
  it('leaves an offset that is still within the content', () => {
    expect(scrollOffsetBackWithinContent(0, 2000, 900)).toBeNull();
    expect(scrollOffsetBackWithinContent(1100, 2000, 900)).toBeNull();
  });

  it('allows a pixel of rounding past the end', () => {
    expect(scrollOffsetBackWithinContent(1100.6, 2000, 900)).toBeNull();
  });

  it('brings an offset left past a shrunk content back to its new end', () => {
    // The emulator's Profile: scrolled to 1519 through two pages, cut to one.
    expect(scrollOffsetBackWithinContent(1519, 1935.4, 923.4)).toBeCloseTo(1012, 0);
  });

  it('brings an offset past all the content back to the top when what is left fits the window', () => {
    // The S24's Profile: every tile above the window, and a library that now fits on screen.
    expect(scrollOffsetBackWithinContent(2400, 700, 832)).toBe(0);
  });

  it('does nothing before the window has a size or with unknown numbers', () => {
    expect(scrollOffsetBackWithinContent(1519, 1000, 0)).toBeNull();
    expect(scrollOffsetBackWithinContent(Number.NaN, 1000, 900)).toBeNull();
    expect(scrollOffsetBackWithinContent(1519, Number.POSITIVE_INFINITY, 900)).toBeNull();
  });
});

function fakeList(offset: number, windowHeight = 900) {
  const list: ScrollWithinContentList & { offset: number } = {
    offset,
    getAbsoluteLastScrollOffset: () => list.offset,
    getWindowSize: () => ({ height: windowHeight }),
    scrollToOffset: vi.fn(({ offset: next }: { offset: number }) => {
      list.offset = next;
    }),
  };
  return list;
}

type SizeChange = (width: number, height: number) => void;

function mount(list: ScrollWithinContentList, isFocused: boolean) {
  const listRef = { current: list };
  const handler: { current: SizeChange | null } = { current: null };
  function Host({ focused }: { focused: boolean }) {
    handler.current = useScrollWithinContent(listRef, focused);
    return null;
  }
  let tree: renderer.ReactTestRenderer | null = null;
  act(() => {
    tree = renderer.create(React.createElement(Host, { focused: isFocused }));
  });
  return {
    sizeChange: (height: number) => act(() => handler.current!(375, height)),
    focus: (focused: boolean) => act(() => {
      tree!.update(React.createElement(Host, { focused }));
    }),
  };
}

describe('useScrollWithinContent', () => {
  beforeEach(() => {
    platform.OS = 'android';
  });

  it('brings a covered list back within content that shrank under it', () => {
    const list = fakeList(1519);
    const { sizeChange } = mount(list, false);

    sizeChange(3000);
    expect(list.scrollToOffset).not.toHaveBeenCalled();

    // The composer collapsed the library to its first page while the list was covered.
    sizeChange(1000);
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(list.scrollToOffset).toHaveBeenLastCalledWith({ offset: 100, animated: false });
  });

  it('leaves a list on screen to the scroll view, which does this itself there', () => {
    const list = fakeList(1519);
    const { sizeChange } = mount(list, true);

    sizeChange(1000);
    expect(list.scrollToOffset).not.toHaveBeenCalled();
  });

  it('checks again as the screen is focused', () => {
    const list = fakeList(400);
    const { sizeChange, focus } = mount(list, true);
    sizeChange(2400);

    // A shrink seen while focused, with the offset left past the end without a scroll event.
    sizeChange(1000);
    list.offset = 1519;
    focus(false);
    expect(list.scrollToOffset).not.toHaveBeenCalled();

    focus(true);
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(list.scrollToOffset).toHaveBeenLastCalledWith({ offset: 100, animated: false });
  });

  it('does not move a covered list that is still within its content', () => {
    const list = fakeList(300);
    const { sizeChange } = mount(list, false);

    // Shrunk, but its new end (600) is still past where the reader is.
    sizeChange(1500);
    expect(list.scrollToOffset).not.toHaveBeenCalled();
  });

  it('does nothing on iOS', () => {
    platform.OS = 'ios';
    const list = fakeList(1519);
    const { sizeChange, focus } = mount(list, false);

    sizeChange(1000);
    focus(true);
    expect(list.scrollToOffset).not.toHaveBeenCalled();
  });
});
