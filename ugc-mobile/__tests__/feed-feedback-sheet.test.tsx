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
          hideLabel="Hide @luna"
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

  function labels(root: renderer.ReactTestInstance) {
    return root.findAll((node) => String(node.type) === 'pressable' && typeof node.props.accessibilityLabel === 'string')
      .map((node) => node.props.accessibilityLabel as string)
      .filter((label) => label !== 'Close feed preferences');
  }

  function ownPostSheet(props: { canHideCreator: boolean; viewerIsOwner?: boolean; visible: boolean }) {
    return (
      <FeedFeedbackSheet
        creatorLabel="@me"
        hideLabel="Hide @me"
        onBlockUser={vi.fn()}
        onClose={vi.fn()}
        onHideCreator={vi.fn()}
        onNotInterested={vi.fn()}
        onReportContent={vi.fn()}
        onReportUser={vi.fn()}
        postTitle="My post"
        {...props}
      />
    );
  }

  // The rows of the card's menu (`lib/feed-feedback-menu.ts`): nothing can make
  // hiding, reporting or blocking yourself possible, and a report on your own
  // post reports no one, so none of them is offered and no Safety heading is left.
  it("leaves the creator rows and Report content out on the signed-in creator's own post", () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(ownPostSheet({ canHideCreator: false, viewerIsOwner: true, visible: true }));
    });

    expect(labels(tree!.root)).toEqual(['Not interested']);
    expect(tree!.root.findAll((node) => String(node.type) === 'text' && node.props.children === 'Safety')).toEqual([]);
  });

  it("keeps Report content on a post with no creator account, which is no one's own", () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(ownPostSheet({ canHideCreator: false, visible: true }));
    });

    expect(labels(tree!.root)).toEqual(['Not interested', 'Report content']);
    expect(tree!.root.findAll((node) => String(node.type) === 'text' && node.props.children === 'Safety')).toHaveLength(1);
  });

  // The screen clears its post (and so its creator) in the same render that
  // hides the sheet, which then slides away for a few hundred milliseconds.
  it('keeps the rows it was showing while it slides away', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(ownPostSheet({ canHideCreator: true, visible: true }));
    });
    const shown = labels(tree!.root);
    expect(shown).toEqual(['Not interested', 'Hide @me', 'Report content', 'Report user', 'Block user']);

    renderer.act(() => tree!.update(ownPostSheet({ canHideCreator: false, visible: false })));
    expect(labels(tree!.root)).toEqual(shown);

    // The next post it opens for is the viewer's own: now the rows go.
    renderer.act(() => tree!.update(ownPostSheet({ canHideCreator: false, viewerIsOwner: true, visible: true })));
    expect(labels(tree!.root)).toEqual(['Not interested']);

    // And a cleared post is no one's own: Report content does not come back
    // into a sheet that is on its way out.
    renderer.act(() => tree!.update(ownPostSheet({ canHideCreator: false, viewerIsOwner: false, visible: false })));
    expect(labels(tree!.root)).toEqual(['Not interested']);
  });

  it('words the Hide row as it is told to, whatever it calls the creator in its sentences', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <FeedFeedbackSheet
          creatorLabel="luna"
          hideLabel="Hide @luna"
          onClose={vi.fn()}
          onHideCreator={vi.fn()}
          onNotInterested={vi.fn()}
          postTitle="Serum reveal"
          visible
        />
      );
    });

    expect(pressable(tree!.root, 'Hide @luna').props.accessibilityHint).toContain('Remove posts from luna');
  });

  it('labels anonymous feedback as limited to this visit', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <FeedFeedbackSheet
          creatorLabel="@luna"
          hideLabel="Hide @luna"
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
