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

  it("keeps the call site's own answer for a tap while the keyboard is up", () => {
    platform.OS = 'android';
    const tree = draw(<PagerRowScrollView keyboardShouldPersistTaps="never" />);
    expect(tree.root.findByType('gesture-scroll-view' as never).props.keyboardShouldPersistTaps).toBe('never');
  });
});
