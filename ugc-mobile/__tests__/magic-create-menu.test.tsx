import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

vi.mock('react-native', () => ({
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', {
      ...props,
      style: resolvePressableStyle(style),
    }, children),
  Text: ({ children, ...props }: MockProps) =>
    React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) =>
    React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));

vi.mock('expo-blur', () => ({
  BlurView: ({ children, ...props }: MockProps) =>
    React.createElement('blur-view', props, children),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) =>
    React.createElement('linear-gradient', props, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('lucide-react-native', () => ({
  FilePlus2: (props: Record<string, unknown>) => React.createElement('file-plus-icon', props),
  Sparkles: (props: Record<string, unknown>) => React.createElement('sparkles-icon', props),
  X: (props: Record<string, unknown>) => React.createElement('x-icon', props),
}));

vi.mock('@/lib/create-menu-view-model', async () =>
  vi.importActual('../lib/create-menu-view-model')
);

vi.mock('@/lib/safe-area', () => ({
  resolvedBottomInset: (value: number) => value,
}));

vi.mock('@/lib/theme', () => ({
  appTheme: {
    colors: {
      muted: '#a1a1aa',
    },
  },
}));

import { MagicCreateMenu } from '../components/magic-create-menu';
import { CREATE_MENU_ACTIONS, getCreateMenuActionHref } from '../lib/create-menu-view-model';

describe('create menu view model', () => {
  it('exposes exactly Create and Post actions in create-first order', () => {
    expect(CREATE_MENU_ACTIONS.map((action) => action.id)).toEqual(['create', 'post']);
    expect(CREATE_MENU_ACTIONS.map((action) => action.label)).toEqual(['Create', 'Post']);
    expect(CREATE_MENU_ACTIONS.find((action) => action.id === 'post')?.body).toBe('Share finished media');
  });

  it('maps actions to their mobile routes', () => {
    expect(getCreateMenuActionHref('create')).toBe('/(tabs)/creator');
    expect(getCreateMenuActionHref('post')).toBe('/post/new');
  });
});

describe('MagicCreateMenu', () => {
  it('does not render when hidden', () => {
    let tree: { toJSON: () => unknown } | undefined;

    renderer.act(() => {
      tree = renderer.create(<MagicCreateMenu visible={false} onClose={vi.fn()} onAction={vi.fn()} />);
    });

    expect(tree!.toJSON()).toBeNull();
  });

  it('renders actions and closes from the close button', () => {
    const onClose = vi.fn();
    const onAction = vi.fn();
    let tree: ReturnType<typeof renderer.create> | undefined;

    renderer.act(() => {
      tree = renderer.create(<MagicCreateMenu visible onClose={onClose} onAction={onAction} />);
    });

    expect(tree!.root.findByProps({ accessibilityLabel: 'Create' })).toBeTruthy();
    expect(tree!.root.findByProps({ accessibilityLabel: 'Post' })).toBeTruthy();

    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Close create menu' }).props.onPress();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('emits the selected action', () => {
    const onAction = vi.fn();
    let tree: ReturnType<typeof renderer.create> | undefined;

    renderer.act(() => {
      tree = renderer.create(<MagicCreateMenu visible onClose={vi.fn()} onAction={onAction} />);
    });

    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Post' }).props.onPress();
    });

    expect(onAction).toHaveBeenCalledWith('post');
  });
});
