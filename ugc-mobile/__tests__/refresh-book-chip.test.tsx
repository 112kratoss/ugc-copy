(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
const platform = vi.hoisted(() => ({ OS: 'ios' as string }));

vi.mock('@/lib/motion', () => ({ useReducedMotion: () => false }));

vi.mock('react-native', () => ({
  Platform: platform,
  RefreshControl: (props: MockProps) => React.createElement('refresh-control', props, props.children),
  StyleSheet: { hairlineWidth: 0.5 },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

import { BookPullArea, PageFlipBook, RefreshBookChip, useBookPull, type BookPull } from '../components/refresh-book';
import {
  ANDROID_PULL_TRIGGER,
  PULL_ACTIVATE_DISTANCE,
  REFRESH_BOOK_MIN_VISIBLE_MS,
  androidSystemPullOffset,
  refreshBookChipTop,
} from '../lib/refresh-book';

const advance = (ms: number) => renderer.act(() => {
  vi.advanceTimersByTime(ms);
});

type MockGesture = { kind: string; callbacks: Record<string, (...args: unknown[]) => void>; config: Record<string, unknown[]> };

let pull!: BookPull;
let listMounts = 0;
function List() {
  React.useEffect(() => {
    listMounts += 1;
  }, []);
  return React.createElement('list');
}

function PullHarness({
  refreshing,
  onRefresh,
  enabled,
  paused,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  enabled?: boolean;
  paused?: boolean;
}) {
  const screenPull = useBookPull({ refreshing, onRefresh, enabled, paused });
  pull = screenPull;
  return (
    <BookPullArea pull={screenPull}>
      <List />
    </BookPullArea>
  );
}

function renderPull(refreshing: boolean, onRefresh: () => void, enabled?: boolean) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<PullHarness refreshing={refreshing} onRefresh={onRefresh} enabled={enabled} />);
  });
  return tree;
}

function touch(x: number, y: number) {
  return { allTouches: [{ id: 0, x, y, absoluteX: x, absoluteY: y }] };
}

describe('the pull on iOS', () => {
  it('keeps the platform pull, its spinner drawn clear, and adds no gesture over the list', () => {
    const onRefresh = vi.fn();
    const tree = renderPull(true, onRefresh);
    const control = pull.refreshControl!;
    expect(control.props.refreshing).toBe(true);
    expect(pull.gesture).toBeNull();
    expect(tree.root.findAll((node) => String(node.type) === 'gesture-detector')).toHaveLength(0);

    let controlTree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      controlTree = renderer.create(control);
    });
    expect(controlTree.root.findByType('refresh-control' as never).props.tintColor).toBe('transparent');
  });

  it('refreshes through the screen handler when the platform pull fires', () => {
    const onRefresh = vi.fn();
    renderPull(false, onRefresh);
    renderer.act(() => pull.refreshControl!.props.onRefresh!());
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the platform control while paused: taking it away builds the list content again', () => {
    const onRefresh = vi.fn();
    const tree = renderPull(false, onRefresh);
    // Explore pauses the pull for every swipe through a card's pictures.
    renderer.act(() => tree.update(<PullHarness refreshing={false} onRefresh={onRefresh} paused />));
    expect(pull.refreshControl).toBeDefined();
    renderer.act(() => tree.update(<PullHarness refreshing={false} onRefresh={onRefresh} />));
    expect(pull.refreshControl).toBeDefined();
  });
});

describe('the list the pull reads', () => {
  it('reads a list attached anew as at its top, and leaves a list attached again as it is', () => {
    renderPull(false, () => {});
    const firstList = {};
    renderer.act(() => pull.attachScroll(firstList));
    pull.offset.value = 800;

    // Home builds a new list for each lane: no scroll event says the new one is at its top.
    const laneList = {};
    renderer.act(() => pull.attachScroll(laneList));
    expect(pull.offset.value).toBe(0);

    pull.offset.value = 300;
    renderer.act(() => pull.attachScroll(laneList));
    renderer.act(() => pull.attachScroll(null));
    expect(pull.offset.value).toBe(300);
  });
});

describe('the pull on Android', () => {
  beforeEach(() => {
    platform.OS = 'android';
    vi.useFakeTimers();
  });

  afterEach(() => {
    platform.OS = 'ios';
    vi.useRealTimers();
  });

  function gestureOf(tree: renderer.ReactTestRenderer) {
    return tree.root.find((node) => String(node.type) === 'gesture-detector').props.gesture as MockGesture;
  }

  function pullDown(gesture: MockGesture, by: number, { atTop = true, success = true } = {}) {
    pull.offset.value = atTop ? 0 : 300;
    const manager = { activate: vi.fn(), fail: vi.fn(), begin: vi.fn(), end: vi.fn() };
    gesture.callbacks.onTouchesDown(touch(200, 300), manager);
    gesture.callbacks.onTouchesMove(touch(200, 300 + PULL_ACTIVATE_DISTANCE), manager);
    if (manager.activate.mock.calls.length > 0) {
      gesture.callbacks.onUpdate({ translationY: PULL_ACTIVATE_DISTANCE + by });
      gesture.callbacks.onEnd({}, success);
    }
    return manager;
  }

  it('puts its own pan over the list, which waits for the finger to decide', () => {
    const tree = renderPull(false, vi.fn());
    const gesture = gestureOf(tree);
    expect(gesture.kind).toBe('pan');
    expect(gesture.config.manualActivation).toEqual([true]);
    expect(tree.root.findAll((node) => String(node.type) === 'list')).toHaveLength(1);
  });

  it('keeps the platform control under it for a drag that runs on past the top, its circle the book\'s', () => {
    const onRefresh = vi.fn();
    renderPull(false, onRefresh);
    const control = pull.refreshControl!;
    // Never told it refreshes, so it lets go at release; the book's circle, coral and the same size, takes its place.
    expect(control.props.refreshing).toBe(false);
    expect(control.props.enabled).toBe(true);
    expect(control.props.size).toBe('large');
    expect(control.props.progressViewOffset).toBe(androidSystemPullOffset(refreshBookChipTop('android', 0)));

    renderer.act(() => control.props.onRefresh!());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(pull.released.value).toBe(true);
  });

  it('switches the platform control off, never takes it away, while refreshing or switched off', () => {
    renderPull(true, () => {});
    expect(pull.refreshControl!.props.enabled).toBe(false);
    renderPull(false, () => {}, false);
    expect(pull.refreshControl).toBeDefined();
    expect(pull.refreshControl!.props.enabled).toBe(false);
  });

  it('takes a pull down at the list top, and refreshes when let go past the trigger', () => {
    const onRefresh = vi.fn();
    const tree = renderPull(false, onRefresh);
    const manager = pullDown(gestureOf(tree), ANDROID_PULL_TRIGGER + 10);
    expect(manager.activate).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    // The circle is held at rest until the screen says it is refreshing.
    expect(pull.released.value).toBe(true);
  });

  it('goes back up without refreshing when let go short of the trigger', () => {
    const onRefresh = vi.fn();
    const tree = renderPull(false, onRefresh);
    pullDown(gestureOf(tree), ANDROID_PULL_TRIGGER - 10);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(pull.released.value).toBe(false);
  });

  it('leaves a touch to the list once it is scrolled away from its top', () => {
    const onRefresh = vi.fn();
    const tree = renderPull(false, onRefresh);
    const manager = pullDown(gestureOf(tree), 200, { atTop: false });
    expect(manager.fail).toHaveBeenCalledTimes(1);
    expect(manager.activate).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('never refreshes from a pull the system took back past the trigger', () => {
    const onRefresh = vi.fn();
    const tree = renderPull(false, onRefresh);
    const manager = pullDown(gestureOf(tree), ANDROID_PULL_TRIGGER + 40, { success: false });
    expect(manager.activate).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(pull.released.value).toBe(false);
  });

  it('leaves every touch to the list while switched off', () => {
    const onRefresh = vi.fn();
    const tree = renderPull(false, onRefresh, false);
    const manager = pullDown(gestureOf(tree), 200);
    expect(manager.fail).toHaveBeenCalledTimes(1);
    expect(manager.activate).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('takes no touch while paused, with its pan and control both still there', () => {
    const onRefresh = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<PullHarness refreshing={false} onRefresh={onRefresh} paused />);
    });
    const manager = pullDown(gestureOf(tree), 200);
    expect(manager.fail).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(pull.refreshControl!.props.enabled).toBe(false);
  });

  it('keeps the list mounted where it is as the pull is switched off and on', () => {
    listMounts = 0;
    const onRefresh = vi.fn();
    const tree = renderPull(false, onRefresh, true);
    // Explore switches the pull off for each swipe through a card's pictures.
    renderer.act(() => tree.update(<PullHarness refreshing={false} onRefresh={onRefresh} enabled={false} />));
    renderer.act(() => tree.update(<PullHarness refreshing={false} onRefresh={onRefresh} enabled />));
    expect(listMounts).toBe(1);
    expect(tree.root.findAll((node) => String(node.type) === 'gesture-detector')).toHaveLength(1);
  });

  it('takes no second pull while a refresh runs', () => {
    const onRefresh = vi.fn();
    const tree = renderPull(true, onRefresh);
    const manager = pullDown(gestureOf(tree), 200);
    expect(manager.fail).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('lets the circle go if the screen turns the refresh down', () => {
    const tree = renderPull(false, () => {});
    pullDown(gestureOf(tree), ANDROID_PULL_TRIGGER + 10);
    expect(pull.released.value).toBe(true);
    advance(400);
    expect(pull.released.value).toBe(false);
  });
});

describe('RefreshBookChip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const chipIn = (tree: renderer.ReactTestRenderer) => tree.root.findAllByType(PageFlipBook);

  it('is always there under a pull, to be pulled down', () => {
    renderPull(false, () => {});
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<RefreshBookChip refreshing={false} pull={pull} contentTop={59} />);
    });
    expect(chipIn(tree)).toHaveLength(1);
  });

  it('without a pull, is not drawn while nothing refreshes', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<RefreshBookChip refreshing={false} contentTop={59} />);
    });
    expect(chipIn(tree)).toHaveLength(0);
  });

  it('without a pull, comes up with a refresh below the content inset and stays at least one page turn', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<RefreshBookChip refreshing contentTop={59} />);
    });
    expect(chipIn(tree)).toHaveLength(1);
    const placed = tree.root.findAll((node) => node.type === 'view' && node.props.style?.position === 'absolute' && node.props.style?.top !== undefined)[0];
    expect(placed.props.style.top).toBe(refreshBookChipTop('ios', 59));

    // An answer straight from the cache ends the refresh almost at once.
    advance(50);
    renderer.act(() => tree.update(<RefreshBookChip refreshing={false} contentTop={59} />));
    advance(REFRESH_BOOK_MIN_VISIBLE_MS - 100);
    expect(chipIn(tree)).toHaveLength(1);

    // Held long enough, then out through its exit.
    advance(100);
    advance(400);
    expect(chipIn(tree)).toHaveLength(0);
  });

  it('takes the place it is given for a refresh no pull started', () => {
    renderPull(false, () => {});
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<RefreshBookChip refreshing pull={pull} contentTop={59} top={140} />);
    });
    const placed = tree.root.findAll((node) => node.type === 'view' && node.props.style?.top === 140);
    expect(placed).toHaveLength(1);
  });

  it('keeps that place through its linger and exit after the screen stops naming it, then waits for a pull', () => {
    renderPull(false, () => {});
    const placedTop = (tree: renderer.ReactTestRenderer) =>
      tree.root.findAll((node) => node.type === 'view' && node.props.style?.position === 'absolute' && node.props.style?.top !== undefined)[0]
        ?.props.style.top;
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<RefreshBookChip refreshing pull={pull} contentTop={59} top={140} />);
    });

    // A "New posts" refresh answered at once: the screen drops `top` with `refreshing`.
    advance(50);
    renderer.act(() => tree.update(<RefreshBookChip refreshing={false} pull={pull} contentTop={59} />));
    expect(placedTop(tree)).toBe(140);
    advance(REFRESH_BOOK_MIN_VISIBLE_MS);
    expect(placedTop(tree)).toBe(140);

    // Out through the exit, then back under the pull, where the next pull finds it.
    advance(400);
    expect(placedTop(tree)).toBe(refreshBookChipTop('ios', 59));
    expect(chipIn(tree)).toHaveLength(1);
  });

  const placedTopOf = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll((node) => node.type === 'view' && node.props.style?.position === 'absolute' && node.props.style?.top !== undefined)[0]
      ?.props.style.top;

  it('gives up the pill\'s place to a pull that starts while it lingers', () => {
    renderPull(false, () => {});
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<RefreshBookChip refreshing pull={pull} contentTop={59} top={140} />);
    });
    advance(50);
    renderer.act(() => tree.update(<RefreshBookChip refreshing={false} pull={pull} contentTop={59} />));
    expect(placedTopOf(tree)).toBe(140);
    advance(200);
    // A pull refresh, with no place named, while the pill's circle still lingers.
    renderer.act(() => tree.update(<RefreshBookChip refreshing pull={pull} contentTop={59} />));
    expect(placedTopOf(tree)).toBe(refreshBookChipTop('ios', 59));
  });

  it('leaves the pill\'s place on time though the screen draws again through the exit', () => {
    renderPull(false, () => {});
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<RefreshBookChip refreshing pull={pull} contentTop={59} top={140} />);
    });
    advance(50);
    renderer.act(() => tree.update(<RefreshBookChip refreshing={false} pull={pull} contentTop={59} />));
    // The screen's pull is a new object at every render (useBookPull returns one).
    for (let step = 0; step < 12; step += 1) {
      advance(100);
      renderer.act(() => tree.update(<RefreshBookChip refreshing={false} pull={{ ...pull }} contentTop={59} />));
    }
    expect(placedTopOf(tree)).toBe(refreshBookChipTop('ios', 59));
  });
});
