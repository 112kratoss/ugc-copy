import React from 'react';
import renderer from 'react-test-renderer';
import { Pressable, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement(
    'pressable',
    props,
    typeof children === 'function' ? (children as (state: unknown) => React.ReactNode)({ pressed: false }) : children
  ),
}));

import { PostReadMore, PostTextBlock } from '@/components/post-text-block';

function render(props: Partial<React.ComponentProps<typeof PostTextBlock>> = {}) {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(
      <PostTextBlock
        text="Open with tension."
        clampLines={6}
        {...props}
      />
    );
  });
  return tree!.root;
}

describe('PostTextBlock', () => {
  it('renders the body plainly, with no framed panel or accent rail', () => {
    const root = render();
    const texts = root.findAllByType('text' as never);

    // One Text: the body. A rail would add a second, bare View sibling.
    expect(texts).toHaveLength(1);
    expect(texts[0].props.children).toBe('Open with tension.');
    expect(root.findAllByType('pressable' as never)).toHaveLength(0);
  });

  it('clamps the feed preview', () => {
    const body = render().findAllByType('text' as never)[0];

    expect(body.props.numberOfLines).toBe(6);
  });

  it('keeps Read more separate from the preview’s ordinary post-open target', () => {
    const onOpen = vi.fn();
    const onReadMore = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <View>
          <Pressable onPress={onOpen}><PostTextBlock text="A long story" clampLines={2} /></Pressable>
          <PostReadMore onPress={onReadMore} />
        </View>
      );
    });
    const targets = tree.root.findAllByType('pressable' as never);
    expect(targets).toHaveLength(2);
    renderer.act(() => targets[0].props.onPress());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onReadMore).not.toHaveBeenCalled();
    renderer.act(() => targets[1].props.onPress());
    expect(onReadMore).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(targets[1].props.accessibilityLabel).toBe('Read more');
  });

  it('renders nothing without text', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <PostTextBlock text="" clampLines={6} />
      );
    });

    expect(tree!.toJSON()).toBeNull();
  });
});
