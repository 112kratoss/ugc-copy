(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const native = vi.hoisted(() => ({
  os: 'android' as 'android' | 'ios',
  screenReader: false,
  screenReaderListeners: [] as Array<(enabled: boolean) => void>,
  announce: [] as string[],
}));
const presence = vi.hoisted(() => ({ leaving: false }));

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: (message: string) => native.announce.push(message),
    isScreenReaderEnabled: () => Promise.resolve(native.screenReader),
    addEventListener: (_event: string, listener: (enabled: boolean) => void) => {
      native.screenReaderListeners.push(listener);
      return { remove: () => undefined };
    },
  },
  Platform: {
    get OS() {
      return native.os;
    },
  },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
  }, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
}));

vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  useOverlayPresence: (visible: boolean) => ({ mounted: visible || presence.leaving, animatedStyle: undefined }),
}));

import { FEED_UNDO_NOTICE_MS, FeedUndoNotice, type FeedUndoNoticeModel } from '../components/feed-undo-notice';

function notice(id: string, message = 'Post hidden') {
  return { id, message, onUndo: vi.fn<FeedUndoNoticeModel['onUndo']>() };
}

async function render(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(element);
  });
  return tree;
}

function undoButton(tree: renderer.ReactTestRenderer) {
  return tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Undo');
}

function message(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
}

function advance(ms: number) {
  renderer.act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('FeedUndoNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    native.os = 'android';
    native.screenReader = false;
    native.screenReaderListeners = [];
    native.announce = [];
    presence.leaving = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the message and an Undo, above the tab bar it is told to clear', async () => {
    const tree = await render(<FeedUndoNotice notice={notice('n1')} onDismiss={vi.fn()} bottomOffset={104} />);

    expect(message(tree)).toEqual(['Post hidden', 'Undo']);
    expect(undoButton(tree).props.accessibilityRole).toBe('button');
    expect(undoButton(tree).props.style.minHeight).toBeGreaterThanOrEqual(44);
    expect(tree.root.findAll((node) => String(node.type) === 'view')[0].props.style)
      .toMatchObject({ position: 'absolute', bottom: 104 });
    expect(tree.root.find((node) => String(node.type) === 'motion-view').props.accessibilityLiveRegion).toBe('polite');
  });

  it('draws nothing without a notice', async () => {
    const tree = await render(<FeedUndoNotice notice={null} onDismiss={vi.fn()} bottomOffset={104} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('leaves by itself at five seconds and the choice stands', async () => {
    const onDismiss = vi.fn();
    const shown = notice('n1');
    await render(<FeedUndoNotice notice={shown} onDismiss={onDismiss} bottomOffset={0} />);

    advance(FEED_UNDO_NOTICE_MS - 1);
    expect(onDismiss).not.toHaveBeenCalled();
    advance(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('n1');
    expect(shown.onUndo).not.toHaveBeenCalled();
  });

  it('runs Undo once however often it is pressed, and leaves', async () => {
    const onDismiss = vi.fn();
    const shown = notice('n1');
    const tree = await render(<FeedUndoNotice notice={shown} onDismiss={onDismiss} bottomOffset={0} />);

    renderer.act(() => {
      undoButton(tree).props.onPress();
      undoButton(tree).props.onPress();
    });

    expect(shown.onUndo).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('n1');
    // Undo pressed before the countdown ends: the countdown does not also run Undo.
    advance(FEED_UNDO_NOTICE_MS);
    expect(shown.onUndo).toHaveBeenCalledTimes(1);
  });

  it('replaces the notice showing with a new one, whose countdown starts over; the old choice is kept', async () => {
    const onDismiss = vi.fn();
    const first = notice('n1');
    const second = notice('n2', 'Creator hidden');
    const tree = await render(<FeedUndoNotice notice={first} onDismiss={onDismiss} bottomOffset={0} />);

    advance(3_000);
    renderer.act(() => tree.update(<FeedUndoNotice notice={second} onDismiss={onDismiss} bottomOffset={0} />));
    expect(message(tree)[0]).toBe('Creator hidden');

    advance(FEED_UNDO_NOTICE_MS - 1);
    expect(onDismiss).not.toHaveBeenCalled();
    advance(1);
    expect(onDismiss.mock.calls).toEqual([['n2']]);

    renderer.act(() => undoButton(tree).props.onPress());
    expect(first.onUndo).not.toHaveBeenCalled();
    expect(second.onUndo).toHaveBeenCalledTimes(1);
  });

  it('keeps its countdown when the screen re-renders it, and tells the latest handler', async () => {
    const shown = notice('n1');
    const firstHandler = vi.fn();
    const latestHandler = vi.fn();
    const tree = await render(<FeedUndoNotice notice={shown} onDismiss={firstHandler} bottomOffset={0} />);

    advance(3_000);
    renderer.act(() => tree.update(<FeedUndoNotice notice={{ ...shown }} onDismiss={latestHandler} bottomOffset={8} />));
    advance(2_000);

    expect(firstHandler).not.toHaveBeenCalled();
    expect(latestHandler).toHaveBeenCalledWith('n1');
  });

  it('waits for a screen reader, which can still dismiss it', async () => {
    native.screenReader = true;
    const onDismiss = vi.fn();
    const tree = await render(<FeedUndoNotice notice={notice('n1')} onDismiss={onDismiss} bottomOffset={0} />);

    advance(FEED_UNDO_NOTICE_MS * 4);
    expect(onDismiss).not.toHaveBeenCalled();

    renderer.act(() => tree.root.find((node) => String(node.type) === 'motion-view').props.onAccessibilityEscape());
    renderer.act(() => undoButton(tree).props.onAccessibilityAction({ nativeEvent: { actionName: 'dismiss' } }));
    expect(onDismiss.mock.calls).toEqual([['n1'], ['n1']]);
    expect(undoButton(tree).props.accessibilityActions).toEqual([{ name: 'dismiss', label: 'Dismiss' }]);
  });

  it('stops counting when a screen reader is turned on while it shows', async () => {
    const onDismiss = vi.fn();
    await render(<FeedUndoNotice notice={notice('n1')} onDismiss={onDismiss} bottomOffset={0} />);

    advance(2_000);
    renderer.act(() => native.screenReaderListeners.forEach((listener) => listener(true)));
    advance(FEED_UNDO_NOTICE_MS);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('announces each notice once on iOS, where there are no live regions', async () => {
    native.os = 'ios';
    const shown = notice('n1');
    const tree = await render(<FeedUndoNotice notice={shown} onDismiss={vi.fn()} bottomOffset={0} />);
    renderer.act(() => tree.update(<FeedUndoNotice notice={shown} onDismiss={vi.fn()} bottomOffset={12} />));
    renderer.act(() => tree.update(<FeedUndoNotice notice={notice('n2', 'Creator hidden')} onDismiss={vi.fn()} bottomOffset={12} />));

    expect(native.announce).toEqual(['Post hidden', 'Creator hidden']);
  });

  it('leaves the announcing to the live region on Android', async () => {
    await render(<FeedUndoNotice notice={notice('n1')} onDismiss={vi.fn()} bottomOffset={0} />);
    expect(native.announce).toEqual([]);
  });

  it('cannot be undone, pressed or reached by a screen reader while it fades out', async () => {
    presence.leaving = true;
    const onDismiss = vi.fn();
    const shown = notice('n1');
    const tree = await render(<FeedUndoNotice notice={shown} onDismiss={onDismiss} bottomOffset={0} />);
    renderer.act(() => tree.update(<FeedUndoNotice notice={null} onDismiss={onDismiss} bottomOffset={0} />));

    // Still drawn with its message while it fades.
    expect(message(tree)[0]).toBe('Post hidden');
    const card = tree.root.find((node) => String(node.type) === 'motion-view');
    expect(card.props.pointerEvents).toBe('none');
    expect(card.props.accessibilityElementsHidden).toBe(true);
    expect(undoButton(tree).props.disabled).toBe(true);
    renderer.act(() => undoButton(tree).props.onPress());
    expect(shown.onUndo).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
