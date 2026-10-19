(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const native = vi.hoisted(() => ({
  os: 'android' as 'android' | 'ios',
  screenReader: false,
  announce: [] as string[],
  appStateListeners: [] as Array<(state: string) => void>,
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: (message: string) => native.announce.push(message),
    isScreenReaderEnabled: () => Promise.resolve(native.screenReader),
    addEventListener: () => ({ remove: () => undefined }),
  },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.appStateListeners.push(listener);
      return {
        remove: () => {
          native.appStateListeners = native.appStateListeners.filter((candidate) => candidate !== listener);
        },
      };
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
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) }));
vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
}));
vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  useOverlayPresence: (visible: boolean) => ({ mounted: visible, animatedStyle: undefined }),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ api: {}, user: null }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));

import { SaverNoticeBar } from '../components/saver-notice-bar';
import {
  SAVER_NOTICE_DURATION_MS,
  SAVER_NOTICE_MESSAGE,
  creatorSeesSaverFields,
  readSaverNotice,
  resetSaverNoticeForTests,
} from '../lib/saver-notice';

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(<SaverNoticeBar />);
  });
  return tree;
}

/** A save tapped by an account not told yet. */
function tapSave(accountId = 'user-1') {
  let fields: ReturnType<typeof creatorSeesSaverFields> = {};
  renderer.act(() => {
    fields = creatorSeesSaverFields(accountId, true);
  });
  return fields;
}

function okButton(tree: renderer.ReactTestRenderer) {
  return tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'OK');
}

function advance(ms: number) {
  renderer.act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('SaverNoticeBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    native.os = 'android';
    native.screenReader = false;
    native.announce = [];
    native.appStateListeners = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSaverNoticeForTests();
  });

  it('draws the one-line notice at the top, under the status bar, with an OK of a full touch size', async () => {
    const tree = await render();
    expect(tree.toJSON()).toBeNull();

    tapSave();

    const texts = tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
    expect(texts).toEqual([SAVER_NOTICE_MESSAGE, 'OK']);
    expect(tree.root.findAll((node) => String(node.type) === 'view')[0].props.style)
      .toMatchObject({ position: 'absolute', top: expect.any(Number) });
    expect(tree.root.findAll((node) => String(node.type) === 'view')[0].props.style.top).toBeGreaterThan(47);
    expect(okButton(tree).props.style.minHeight).toBeGreaterThanOrEqual(44);
    expect(tree.root.find((node) => String(node.type) === 'motion-view').props.accessibilityLiveRegion).toBe('polite');
  });

  it('tells the account at OK, and its next save may name it', async () => {
    const tree = await render();
    expect(tapSave()).toEqual({ saverNotYetTold: true });

    renderer.act(() => okButton(tree).props.onPress());

    expect(readSaverNotice()).toBeNull();
    expect(tapSave()).toEqual({ creatorSeesSaver: true });
  });

  it('leaves by itself after six seconds, which counts as read', async () => {
    await render();
    tapSave();

    advance(SAVER_NOTICE_DURATION_MS - 1);
    expect(readSaverNotice()).not.toBeNull();
    advance(1);
    expect(readSaverNotice()).toBeNull();
    expect(tapSave()).toEqual({ creatorSeesSaver: true });
  });

  it('counts nothing read when the app is left while it is up', async () => {
    await render();
    tapSave();

    renderer.act(() => native.appStateListeners.forEach((listener) => listener('background')));

    expect(readSaverNotice()).toBeNull();
    expect(tapSave()).toEqual({ saverNotYetTold: true });
  });

  it('waits for OK while a screen reader runs, and announces itself on iOS', async () => {
    native.os = 'ios';
    native.screenReader = true;
    const tree = await render();
    // The reader's state is read once, after mount.
    await renderer.act(async () => {});
    tapSave();

    advance(SAVER_NOTICE_DURATION_MS * 3);
    expect(readSaverNotice()).not.toBeNull();
    expect(native.announce).toEqual([SAVER_NOTICE_MESSAGE]);

    renderer.act(() => okButton(tree).props.onPress());
    expect(tapSave()).toEqual({ creatorSeesSaver: true });
  });
});
