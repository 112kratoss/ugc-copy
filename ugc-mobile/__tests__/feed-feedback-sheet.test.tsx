// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { FeedFeedbackSheet } from '../components/feed-feedback-sheet';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

vi.mock('react-native', () => ({
  Modal: ({ children, ...props }: MockProps) => React.createElement('modal', props, children),
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: resolvePressableStyle(style),
  }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scrollview', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/lib/motion', () => ({
  useReducedMotion: () => false,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('@/lib/safe-area', () => ({
  resolvedBottomInset: (value: number) => value,
}));

vi.mock('lucide-react-native', () => ({
  Ban: (props: Record<string, unknown>) => React.createElement('ban-icon', props),
  EyeOff: (props: Record<string, unknown>) => React.createElement('eye-off-icon', props),
  Flag: (props: Record<string, unknown>) => React.createElement('flag-icon', props),
  ShieldAlert: (props: Record<string, unknown>) => React.createElement('shield-alert-icon', props),
  UserRoundX: (props: Record<string, unknown>) => React.createElement('user-round-x-icon', props),
}));

function pressable(root: renderer.ReactTestInstance, label: string) {
  const match = root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === label)[0];
  if (!match) throw new Error(`Missing pressable ${label}`);
  return match;
}

describe('feed feedback sheet', () => {
  it('exposes accessible post and creator feedback actions', () => {
    const onNotInterested = vi.fn();
    const onHideCreator = vi.fn();
    const onBlockUser = vi.fn();
    const onReportContent = vi.fn();
    const onReportUser = vi.fn();
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedFeedbackSheet
          creatorLabel="@luna"
          onClose={vi.fn()}
          onBlockUser={onBlockUser}
          onHideCreator={onHideCreator}
          onNotInterested={onNotInterested}
          onReportContent={onReportContent}
          onReportUser={onReportUser}
          postTitle="Serum reveal"
          visible
        />
      );
    });

    renderer.act(() => pressable(tree!.root, 'Not interested').props.onPress());
    renderer.act(() => pressable(tree!.root, 'Hide @luna').props.onPress());
    renderer.act(() => pressable(tree!.root, 'Report content').props.onPress());
    renderer.act(() => pressable(tree!.root, 'Report user').props.onPress());
    renderer.act(() => pressable(tree!.root, 'Block user').props.onPress());

    expect(onNotInterested).toHaveBeenCalledOnce();
    expect(onHideCreator).toHaveBeenCalledOnce();
    expect(onReportContent).toHaveBeenCalledOnce();
    expect(onReportUser).toHaveBeenCalledOnce();
    expect(onBlockUser).toHaveBeenCalledOnce();
    expect(pressable(tree!.root, 'Not interested').props.accessibilityHint).toContain('Remove this post');
  });

  it('disables hiding the signed-in creator from their own feed', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <FeedFeedbackSheet
          creatorLabel="@me"
          hideCreatorDisabled
          onBlockUser={vi.fn()}
          onClose={vi.fn()}
          onHideCreator={vi.fn()}
          onNotInterested={vi.fn()}
          onReportUser={vi.fn()}
          postTitle="My post"
          visible
        />
      );
    });

    const hide = pressable(tree!.root, 'Hide @me');
    expect(hide.props.disabled).toBe(true);
    expect(hide.props.accessibilityState).toEqual({ disabled: true });
    expect(pressable(tree!.root, 'Report user').props.disabled).toBe(true);
    expect(pressable(tree!.root, 'Block user').props.disabled).toBe(true);
  });

  it('labels anonymous feedback as limited to this visit', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <FeedFeedbackSheet
          creatorLabel="@luna"
          onClose={vi.fn()}
          onHideCreator={vi.fn()}
          onNotInterested={vi.fn()}
          postTitle="Serum reveal"
          sessionOnly
          visible
        />
      );
    });

    expect(pressable(tree!.root, 'Not interested').props.accessibilityHint).toContain('for this visit');
    expect(pressable(tree!.root, 'Hide @luna').props.accessibilityHint).toContain('for this visit');
  });
});
