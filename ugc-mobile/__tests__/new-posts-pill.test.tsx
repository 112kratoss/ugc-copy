(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const presence = vi.hoisted(() => ({ leaving: false, visibleSeen: [] as boolean[] }));

vi.mock('react-native', () => ({
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
  }, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
}));

// The presence the pill fades with: `leaving` holds it on screen after `visible`
// goes false, as the fade out does.
vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  useOverlayPresence: (visible: boolean) => {
    presence.visibleSeen.push(visible);
    return { mounted: visible || presence.leaving, animatedStyle: { opacity: visible ? 1 : 0 } };
  },
  usePressMotion: () => ({ animatedStyle: undefined, onPressIn: () => undefined, onPressOut: () => undefined }),
}));

vi.mock('lucide-react-native', () => ({
  ArrowUp: (props: Record<string, unknown>) => React.createElement('arrow-up-icon', props),
}));

import { NewPostsPill } from '../components/new-posts-pill';
import { appTheme } from '../lib/theme';

function render(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree;
}

function button(tree: renderer.ReactTestRenderer) {
  return tree.root.find((node) => String(node.type) === 'pressable');
}

describe('NewPostsPill', () => {
  beforeEach(() => {
    presence.leaving = false;
    presence.visibleSeen = [];
  });

  it('draws nothing until there is something new', () => {
    const tree = render(<NewPostsPill visible={false} onPress={vi.fn()} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('says "New posts" with an up arrow, as one button that runs the screen\'s refresh', () => {
    const onPress = vi.fn();
    const tree = render(<NewPostsPill visible onPress={onPress} />);
    const pill = button(tree);

    expect(pill.props.accessibilityRole).toBe('button');
    expect(pill.props.accessibilityLabel).toBe('New posts');
    expect(pill.props.disabled).toBe(false);
    expect(tree.root.find((node) => String(node.type) === 'text').props.children).toBe('New posts');
    expect(tree.root.find((node) => String(node.type) === 'arrow-up-icon').props.size).toBe(appTheme.icon.sm);
    // A 40pt pill answers to a 44pt reach.
    expect(pill.props.style.minHeight).toBe(40);
    expect(pill.props.hitSlop).toEqual({ top: 2, bottom: 2 });

    renderer.act(() => pill.props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('floats centred under the header and lets every touch beside it reach the list', () => {
    const tree = render(<NewPostsPill visible onPress={vi.fn()} topOffset={112} />);
    const row = tree.root.findAll((node) => String(node.type) === 'view')[0];

    expect(row.props.pointerEvents).toBe('box-none');
    expect(row.props.style).toMatchObject({ position: 'absolute', top: 112, left: 0, right: 0, alignItems: 'center' });
  });

  it('fades with the presence the app uses for overlays, which cuts at once under Reduce Motion', () => {
    const tree = render(<NewPostsPill visible onPress={vi.fn()} />);
    renderer.act(() => tree.update(<NewPostsPill visible={false} onPress={vi.fn()} />));

    expect(presence.visibleSeen).toEqual([true, false]);
    expect(tree.toJSON()).toBeNull();
  });

  it('cannot be pressed or reached by a screen reader while it fades out', () => {
    presence.leaving = true;
    const onPress = vi.fn();
    const tree = render(<NewPostsPill visible onPress={onPress} />);
    renderer.act(() => tree.update(<NewPostsPill visible={false} onPress={onPress} />));
    const pill = button(tree);

    expect(pill.props.disabled).toBe(true);
    expect(pill.props.accessibilityElementsHidden).toBe(true);
    expect(pill.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(tree.root.findAll((node) => String(node.type) === 'motion-view')[0].props.pointerEvents).toBe('none');
  });
});
