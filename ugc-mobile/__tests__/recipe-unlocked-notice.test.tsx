(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const native = vi.hoisted(() => ({
  screenReader: false,
  screenReaderListeners: [] as Array<(running: boolean) => void>,
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: vi.fn(),
    announceForAccessibilityWithOptions: vi.fn(),
    isScreenReaderEnabled: () => Promise.resolve(native.screenReader),
    addEventListener: (_event: string, listener: (running: boolean) => void) => {
      native.screenReaderListeners.push(listener);
      return { remove: () => undefined };
    },
  },
  Platform: { OS: 'android' },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
  }, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({ router }));
vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
}));
vi.mock('@/components/saver-notice-overlay', () => ({
  SaverNoticeOverlay: ({ children }: MockProps) => React.createElement('overlay', null, children),
}));
vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  useOverlayPresence: (visible: boolean) => ({ mounted: visible, animatedStyle: undefined }),
}));

import { RecipeUnlockedNotice } from '../components/recipe-unlocked-notice';
import {
  RECIPE_UNLOCKED_NOTICE_MS,
  announceRecipeUnlocked,
  dismissRecipeUnlockedNotice,
  readRecipeUnlockedNotice,
} from '../lib/recipe-unlocked-notice';
import { viewerTopBadgeTop } from '../lib/viewer-chrome';

// Every tree a case draws, unmounted after it: the store is the module's, and
// a notice left mounted would count down and end the next case's notice.
const mounted: renderer.ReactTestRenderer[] = [];

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(<RecipeUnlockedNotice />);
  });
  mounted.push(tree);
  return tree;
}

function texts(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
}

function action(tree: renderer.ReactTestRenderer) {
  return tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Unlocked recipes');
}

/**
 * B-F9 / B-F20: after buying, nothing said where the recipe went, and paying
 * through the remix sheet went straight on to the editor.
 */
describe('RecipeUnlockedNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    native.screenReader = false;
    native.screenReaderListeners = [];
    router.push.mockClear();
    const shown = readRecipeUnlockedNotice();
    if (shown) dismissRecipeUnlockedNotice(shown.id);
  });

  afterEach(() => {
    renderer.act(() => mounted.splice(0).forEach((tree) => tree.unmount()));
    vi.useRealTimers();
  });

  it('draws nothing until an unlock is announced', async () => {
    const tree = await render();
    expect(tree.toJSON()).toBeNull();
  });

  it('says "Recipe unlocked" with the way to Unlocked recipes, under the top controls of any screen', async () => {
    const tree = await render();
    renderer.act(() => announceRecipeUnlocked());

    expect(texts(tree)).toEqual(['Recipe unlocked', 'Unlocked recipes']);
    expect(action(tree).props.accessibilityRole).toBe('button');
    expect(action(tree).props.style.minHeight).toBeGreaterThanOrEqual(44);
    // Drawn where the saver notice is, below every screen's top control row.
    expect(tree.root.findAll((node) => String(node.type) === 'view')[0].props.style)
      .toMatchObject({ position: 'absolute', top: viewerTopBadgeTop(47) });
  });

  it('opens Unlocked recipes and leaves', async () => {
    const tree = await render();
    renderer.act(() => announceRecipeUnlocked());

    renderer.act(() => action(tree).props.onPress());
    expect(router.push).toHaveBeenCalledWith('/unlocks');
    expect(readRecipeUnlockedNotice()).toBeNull();
    expect(tree.toJSON()).toBeNull();
  });

  it('leaves by itself after five seconds', async () => {
    const tree = await render();
    renderer.act(() => announceRecipeUnlocked());

    renderer.act(() => { vi.advanceTimersByTime(RECIPE_UNLOCKED_NOTICE_MS - 1); });
    expect(texts(tree)).toContain('Recipe unlocked');
    renderer.act(() => { vi.advanceTimersByTime(1); });
    expect(readRecipeUnlockedNotice()).toBeNull();
    expect(tree.toJSON()).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('starts its time over for a second unlock', async () => {
    const tree = await render();
    renderer.act(() => announceRecipeUnlocked());
    renderer.act(() => { vi.advanceTimersByTime(RECIPE_UNLOCKED_NOTICE_MS - 1_000); });
    renderer.act(() => announceRecipeUnlocked());
    renderer.act(() => { vi.advanceTimersByTime(RECIPE_UNLOCKED_NOTICE_MS - 1); });
    expect(texts(tree)).toContain('Recipe unlocked');
    renderer.act(() => { vi.advanceTimersByTime(1); });
    expect(tree.toJSON()).toBeNull();
  });

  it('waits for the reader with VoiceOver or TalkBack running', async () => {
    native.screenReader = true;
    const tree = await render();
    renderer.act(() => announceRecipeUnlocked());

    renderer.act(() => { vi.advanceTimersByTime(RECIPE_UNLOCKED_NOTICE_MS * 3); });
    expect(texts(tree)).toContain('Recipe unlocked');
    // A reader's Dismiss action ends it.
    renderer.act(() => action(tree).props.onAccessibilityAction({ nativeEvent: { actionName: 'dismiss' } }));
    expect(readRecipeUnlockedNotice()).toBeNull();
  });
});
