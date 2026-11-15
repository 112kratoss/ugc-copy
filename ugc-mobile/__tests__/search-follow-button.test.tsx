(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = Record<string, unknown> & { children?: React.ReactNode };

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));
vi.mock('@/components/ui', () => ({
  ToggleButton: (props: MockProps) => React.createElement('toggle-button', props),
}));
vi.mock('@/lib/theme-context', () => ({ useAppTheme: () => ({ colors: { danger: '#f00' } }) }));

import { SearchFollowButton } from '../components/search-follow-button';

// Follow on a creator row of search (review of #828, S9): the column beside it
// never moves while a follow is out.
const luna = { displayName: 'Luna Studio', username: 'luna' };

describe('SearchFollowButton', () => {
  it('keeps its width while a follow is out: a spinner in the words\' place, as wide as it stood', async () => {
    let tree: renderer.ReactTestRenderer | null = null;
    const draw = (following: boolean, pending: boolean) => (
      <SearchFollowButton creator={luna} following={following} pending={pending} onPress={() => {}} />
    );
    await act(async () => { tree = renderer.create(draw(true, false)); });
    const button = () => tree!.root.find((node) => String(node.type) === 'toggle-button');
    const slot = () => tree!.root.find((node) => String(node.type) === 'view' && typeof node.props.onLayout === 'function');
    expect(button().props).toMatchObject({ label: 'Following', loading: false, style: { minWidth: 112 } });

    // "Following" at a larger text size stands wider than the floor.
    await act(async () => { slot().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 127, height: 48 } } }); });
    await act(async () => { tree!.update(draw(false, true)); });
    // The words would grow the button beside the spinner: the spinner alone, as wide as before the press.
    expect(button().props).toMatchObject({ loading: true, loadingLabel: '', style: { minWidth: 127 } });
    // What it measures while out is not how wide it stands.
    await act(async () => { slot().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 140, height: 48 } } }); });
    expect(button().props.style).toMatchObject({ minWidth: 127 });

    // Answered: its words, at the floor again.
    await act(async () => { tree!.update(draw(false, false)); });
    expect(button().props).toMatchObject({ label: 'Follow', loading: false, style: { minWidth: 112 } });
    await act(async () => tree!.unmount());
  });
});
