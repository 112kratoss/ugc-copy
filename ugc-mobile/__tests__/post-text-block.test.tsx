import React from 'react';
import renderer from 'react-test-renderer';
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

import { PostTextBlock } from '@/components/post-text-block';

function render(props: Partial<React.ComponentProps<typeof PostTextBlock>> = {}) {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(
      <PostTextBlock
        text="Open with tension."
        clampLines={6}
        canExpand={false}
        expanded={false}
        onToggle={() => undefined}
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

  it('clamps to the requested line count while collapsed', () => {
    const body = render().findAllByType('text' as never)[0];

    expect(body.props.numberOfLines).toBe(6);
  });

  it('only unclamps when the toggle is actually on offer', () => {
    // A restored expanded id for a card that no longer offers the toggle must
    // not strand the body open with no way to collapse it.
    const stale = render({ expanded: true, canExpand: false });
    expect(stale.findAllByType('text' as never)[0].props.numberOfLines).toBe(6);

    const expanded = render({ expanded: true, canExpand: true });
    expect(expanded.findAllByType('text' as never)[0].props.numberOfLines).toBeUndefined();
  });

  it('offers Read more only when it can expand', () => {
    const root = render({ canExpand: true });

    expect(root.findAllByType('pressable' as never)).toHaveLength(1);
    expect(root.findAllByType('text' as never).map((node) => node.props.children)).toContain('Read more');
  });

  it('renders nothing without text', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <PostTextBlock text="" clampLines={6} canExpand={false} expanded={false} onToggle={() => undefined} />
      );
    });

    expect(tree!.toJSON()).toBeNull();
  });
});
