import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const platform = vi.hoisted(() => ({ OS: 'android' }));

vi.mock('react-native', () => ({
  Platform: platform,
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
}));

vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('gesture-scroll-view', props, children),
}));

import { PagerRowScrollView } from '../components/pager-row-scroll-view';

function draw(element: React.ReactElement) {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree!;
}

/** Lays the row out `rowWidth` wide around tiles `contentWidth` wide, as the native view reports them. */
function measure(row: renderer.ReactTestInstance, rowWidth: number, contentWidth: number) {
  renderer.act(() => {
    row.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: rowWidth, height: 222 } } });
    row.props.onContentSizeChange(contentWidth, 222);
  });
}

describe('PagerRowScrollView', () => {
  // Android's pager took the drag from React Native's; iOS gives it to the row
  // already, and gesture handler's would hold back the touch on its tiles there.
  it.each([
    ['android', 'gesture-scroll-view'],
    ['ios', 'scroll-view'],
  ])('on %s draws a sideways %s that keeps a tap on its tiles', (os, host) => {
    platform.OS = os;
    const tree = draw(<PagerRowScrollView contentContainerStyle={{ gap: 10 }}>{'tiles'}</PagerRowScrollView>);
    const row = tree.root.findByType(host as never);
    expect(row.props).toMatchObject({ horizontal: true, keyboardShouldPersistTaps: 'handled', contentContainerStyle: { gap: 10 } });
    expect(row.props.children).toBe('tiles');
  });

  it.each([
    ['android', 'gesture-scroll-view'],
    ['ios', 'scroll-view'],
  ])("on %s keeps the call site's own answer for a tap while the keyboard is up", (os, host) => {
    platform.OS = os;
    const tree = draw(<PagerRowScrollView keyboardShouldPersistTaps="never" />);
    expect(tree.root.findByType(host as never).props.keyboardShouldPersistTaps).toBe('never');
  });

  it('on Android leaves the drag to the pager until its tiles are wider than the row', () => {
    platform.OS = 'android';
    const onLayout = vi.fn();
    const onContentSizeChange = vi.fn();
    const tree = draw(<PagerRowScrollView onLayout={onLayout} onContentSizeChange={onContentSizeChange} />);
    const row = () => tree.root.findByType('gesture-scroll-view' as never);
    // Not laid out yet: nothing to scroll.
    expect(row().props.scrollEnabled).toBe(false);
    // Two 142-point tiles and their gap in a 333-point card: they fit.
    measure(row(), 333, 294);
    expect(row().props.scrollEnabled).toBe(false);
    // Within a point of the row's width is rounding, not something to scroll.
    measure(row(), 333, 333.6);
    expect(row().props.scrollEnabled).toBe(false);
    // Four tiles: the row scrolls.
    measure(row(), 333, 606);
    expect(row().props.scrollEnabled).toBe(true);
    // The call site still hears both.
    expect(onLayout).toHaveBeenCalledTimes(3);
    expect(onContentSizeChange).toHaveBeenLastCalledWith(606, 222);
  });

  it("keeps a call site's own scrollEnabled={false}", () => {
    platform.OS = 'android';
    const tree = draw(<PagerRowScrollView scrollEnabled={false} />);
    measure(tree.root.findByType('gesture-scroll-view' as never), 333, 606);
    expect(tree.root.findByType('gesture-scroll-view' as never).props.scrollEnabled).toBe(false);
  });

  it('on iOS leaves scrolling to React Native, fitting or not', () => {
    platform.OS = 'ios';
    const tree = draw(<PagerRowScrollView />);
    expect(tree.root.findByType('scroll-view' as never).props.scrollEnabled).toBe(true);
    measure(tree.root.findByType('scroll-view' as never), 333, 294);
    expect(tree.root.findByType('scroll-view' as never).props.scrollEnabled).toBe(true);
  });
});
