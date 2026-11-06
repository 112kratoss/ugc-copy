import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SCROLL_WITHIN_CONTENT_RETURN_MS,
  SCROLL_WITHIN_CONTENT_SETTLE_MS,
  scrollOffsetBackWithinContent,
  scrollOffsetWithinContent,
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

describe('scrollOffsetWithinContent', () => {
  it('keeps an offset inside the content as it is', () => {
    expect(scrollOffsetWithinContent(400, 2000, 900)).toBe(400);
  });

  it('puts an offset past the end at the end, and one above the top at the top', () => {
    expect(scrollOffsetWithinContent(1519, 1935, 923)).toBe(1012);
    expect(scrollOffsetWithinContent(-40, 2000, 900)).toBe(0);
    expect(scrollOffsetWithinContent(300, 700, 900)).toBe(0);
  });

  it('does nothing before the window has a size or with unknown numbers', () => {
    expect(scrollOffsetWithinContent(400, 2000, 0)).toBeNull();
    expect(scrollOffsetWithinContent(Number.NaN, 2000, 900)).toBeNull();
  });
});

/**
 * FlashList as the hook sees it: the offset FlashList believes in and its
 * window. `native` is where the scroll view really is, which only a scroll
 * moves; FlashList's own corrections move `offset` alone, as Android leaves the
 * native offset where it was while the view is detached.
 */
function fakeList(offset: number, windowHeight = 900) {
  const list: ScrollWithinContentList & { offset: number; native: number } = {
    offset,
    native: offset,
    getAbsoluteLastScrollOffset: () => list.offset,
    getWindowSize: () => ({ height: windowHeight }),
    scrollToOffset: vi.fn(({ offset: next }: { offset: number }) => {
      list.native = next;
      list.offset = next;
    }),
  };
  return list;
}

function mount(list: ScrollWithinContentList, isFocused: boolean) {
  const listRef = { current: list };
  const handler: { current: ((width: number, height: number) => void) | null } = { current: null };
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
    settle: (ms = SCROLL_WITHIN_CONTENT_SETTLE_MS) => act(() => {
      vi.advanceTimersByTime(ms);
    }),
    unmount: () => act(() => tree!.unmount()),
  };
}

describe('useScrollWithinContent', () => {
  beforeEach(() => {
    platform.OS = 'android';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('brings a covered list cut back under it to its new end once the change has settled', () => {
    const list = fakeList(1519);
    const { sizeChange, settle } = mount(list, false);
    // The composer collapsed the library to its first page while the list was covered.
    sizeChange(1935);
    // Not inside FlashList's 100 ms of dropped scroll events, which would leave its cells past the end.
    settle(100);
    expect(list.scrollToOffset).not.toHaveBeenCalled();
    settle(50);
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(list.native).toBe(1035);
  });

  it('puts the native offset where FlashList moved its own while covered (rows taken out above the reader)', () => {
    const list = fakeList(1519);
    const { sizeChange, settle } = mount(list, false);
    // Six tiles above the reader go: FlashList's keep-your-place correction moves its offset up a row pair,
    // which Android does not apply to the detached view (the emulator's Profile, 2026-11-06).
    list.offset = 1181;
    sizeChange(2104);
    settle();
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(list.scrollToOffset).toHaveBeenLastCalledWith({ offset: 1181, animated: false });
    expect(list.native).toBe(1181);
  });

  it('waits for the last of several changes in a row', () => {
    const list = fakeList(1519);
    const { sizeChange, settle } = mount(list, false);
    sizeChange(2400);
    settle(80);
    sizeChange(1935);
    settle(80);
    expect(list.scrollToOffset).not.toHaveBeenCalled();
    settle(70);
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(list.native).toBe(1035);
  });

  it('runs again, at once, as the screen comes back after a covered change', () => {
    const list = fakeList(1519);
    const { sizeChange, focus } = mount(list, true);
    sizeChange(2443);
    focus(false);
    sizeChange(1935);
    // Back before the change settled: the pending move is replaced by the one on focus.
    focus(true);
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(list.native).toBe(1035);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
  });

  it('leaves a list alone on its way back when nothing changed while it was covered', () => {
    const list = fakeList(400);
    const { sizeChange, focus } = mount(list, true);
    sizeChange(2443);
    focus(false);
    focus(true);
    expect(list.scrollToOffset).not.toHaveBeenCalled();
  });

  it('leaves a list on screen to the scroll view, which does this itself there', () => {
    const list = fakeList(1519);
    const { sizeChange, settle } = mount(list, true);
    sizeChange(1000);
    settle(SCROLL_WITHIN_CONTENT_RETURN_MS * 2);
    expect(list.scrollToOffset).not.toHaveBeenCalled();
  });

  it('just after the screen comes back, still brings back a list FlashList sees past its end', () => {
    const list = fakeList(400);
    const { sizeChange, focus, settle } = mount(list, true);
    sizeChange(2443);
    focus(false);
    focus(true);
    // The shrink lands as the screen returns, before Android has the view shown again to clamp it.
    list.offset = 1519;
    sizeChange(1935);
    settle();
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(list.native).toBe(1035);
  });

  it('just after the screen comes back, leaves a list FlashList sees within its content', () => {
    const list = fakeList(400);
    const { sizeChange, focus, settle } = mount(list, true);
    sizeChange(2443);
    focus(false);
    focus(true);
    sizeChange(1935);
    settle();
    expect(list.scrollToOffset).not.toHaveBeenCalled();
  });

  it('stops checking a moment after the screen came back', () => {
    const list = fakeList(400);
    const { sizeChange, focus, settle } = mount(list, true);
    sizeChange(2443);
    focus(false);
    focus(true);
    settle(SCROLL_WITHIN_CONTENT_RETURN_MS);
    list.offset = 1519;
    sizeChange(1935);
    settle();
    expect(list.scrollToOffset).not.toHaveBeenCalled();
  });

  it('does nothing before the content has a size', () => {
    const list = fakeList(1519);
    const { focus } = mount(list, false);
    focus(true);
    expect(list.scrollToOffset).not.toHaveBeenCalled();
  });

  it('drops a pending move when the list goes away', () => {
    const list = fakeList(1519);
    const { sizeChange, settle, unmount } = mount(list, false);
    sizeChange(1935);
    unmount();
    settle();
    expect(list.scrollToOffset).not.toHaveBeenCalled();
  });

  it('does nothing on iOS', () => {
    platform.OS = 'ios';
    const list = fakeList(1519);
    const { sizeChange, focus, settle } = mount(list, false);
    sizeChange(1000);
    settle();
    focus(true);
    expect(list.scrollToOffset).not.toHaveBeenCalled();
  });
});
