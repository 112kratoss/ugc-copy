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
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/lib/motion', () => ({
  useReducedMotion: () => false,
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
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedFeedbackSheet
          creatorLabel="@luna"
          onClose={vi.fn()}
          onHideCreator={onHideCreator}
          onNotInterested={onNotInterested}
          postTitle="Serum reveal"
          visible
        />
      );
    });

    renderer.act(() => pressable(tree!.root, 'Not interested').props.onPress());
    renderer.act(() => pressable(tree!.root, 'Hide @luna').props.onPress());

    expect(onNotInterested).toHaveBeenCalledOnce();
    expect(onHideCreator).toHaveBeenCalledOnce();
    expect(pressable(tree!.root, 'Not interested').props.accessibilityHint).toContain('Remove this post');
  });

  it('disables hiding the signed-in creator from their own feed', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <FeedFeedbackSheet
          creatorLabel="@me"
          hideCreatorDisabled
          onClose={vi.fn()}
          onHideCreator={vi.fn()}
          onNotInterested={vi.fn()}
          postTitle="My post"
          visible
        />
      );
    });

    const hide = pressable(tree!.root, 'Hide @me');
    expect(hide.props.disabled).toBe(true);
    expect(hide.props.accessibilityState).toEqual({ disabled: true });
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
