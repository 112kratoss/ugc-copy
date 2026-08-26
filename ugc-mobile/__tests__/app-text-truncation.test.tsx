import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('react-native', () => ({
  Animated: { View: ({ children, ...props }: MockProps) => React.createElement('view', props, children) },
  Image: (props: MockProps) => React.createElement('image', props),
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scrollview', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: (props: MockProps) => React.createElement('textinput', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('expo-router', () => ({
  Link: ({ children, ...props }: MockProps) => React.createElement('link', props, children),
}));

import { AppText } from '../components/ui';

function findText(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text')[0];
}

describe('AppText truncation', () => {
  it('stops being selectable once the text is capped to a line count', () => {
    // Android abandons `numberOfLines` truncation on selectable text — it draws
    // every line past the box it measured, so a long title overlapped the row
    // beneath it on the seller dashboard and the home resume card.
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AppText numberOfLines={1}>A very long listing title</AppText>);
    });

    const text = findText(tree!);
    expect(text.props.numberOfLines).toBe(1);
    expect(text.props.selectable).toBe(false);
  });

  it('stays selectable when the text is free to wrap', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AppText>Body copy people may want to copy</AppText>);
    });

    expect(findText(tree!).props.selectable).toBe(true);
  });

  it('lets a caller override the choice explicitly', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AppText selectable={false}>Button label</AppText>);
    });

    expect(findText(tree!).props.selectable).toBe(false);
  });
});
