import { readFileSync } from 'node:fs';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExploreSearchOverlay } from '../components/explore-search-overlay';
import type { MagicbookletApiClient } from '../lib/api-client';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const mocks = vi.hoisted(() => {
  // Models React Native's BackHandler: listeners are consulted newest-first
  // and the first to return true ends the press.
  const listeners: Array<() => boolean> = [];
  return {
    listeners,
    focused: { value: true },
    keyboardDismiss: vi.fn(),
    addEventListener: vi.fn((_event: string, listener: () => boolean) => {
      listeners.push(listener);
      return {
        remove: () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
    }),
  };
});

function pressBack() {
  for (const listener of [...mocks.listeners].reverse()) {
    if (listener()) return true;
  }
  return false;
}

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => mocks.focused.value,
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  BackHandler: { addEventListener: mocks.addEventListener },
  Keyboard: { dismiss: mocks.keyboardDismiss },
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: resolvePressableStyle(style),
  }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: React.forwardRef((props: MockProps, ref: React.ForwardedRef<{ focus: () => void }>) => {
    React.useImperativeHandle(ref, () => ({ focus: () => {} }));
    return React.createElement('text-input', props);
  }),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
}));

vi.mock('lucide-react-native', () => ({
  BookOpen: (props: MockProps) => React.createElement('icon', props),
  Clock3: (props: MockProps) => React.createElement('icon', props),
  Search: (props: MockProps) => React.createElement('icon', props),
  X: (props: MockProps) => React.createElement('icon', props),
}));

vi.mock('@/components/keyboard-aware', () => ({
  KeyboardAvoidingArea: ({ children, ...props }: MockProps) =>
    React.createElement('keyboard-avoiding-area', props, children),
}));

vi.mock('@/components/ui', () => ({
  CreatorAvatar: (props: MockProps) => React.createElement('creator-avatar', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  useOverlayPresence: (visible: boolean) => ({ mounted: visible, animatedStyle: {} }),
}));

vi.mock('@/lib/platform-glyphs', () => ({
  BackGlyph: (props: MockProps) => React.createElement('icon', props),
}));

vi.mock('@/lib/search-history', () => ({
  normalizeSearchHistoryQuery: (value: string) => value.trim(),
  readSearchHistory: async () => [],
  rememberSearchQuery: async () => [],
  forgetSearchQuery: async () => [],
  clearSearchHistory: async () => {},
}));

const api = { searchPublicContent: vi.fn() } as unknown as MagicbookletApiClient;

async function render(props: { visible: boolean; onClose: () => void }) {
  let tree: renderer.ReactTestRenderer | null = null;
  await act(async () => {
    tree = renderer.create(React.createElement(ExploreSearchOverlay, { api, ...props }));
  });
  return tree!;
}

async function update(tree: renderer.ReactTestRenderer, props: { visible: boolean; onClose: () => void }) {
  await act(async () => {
    tree.update(React.createElement(ExploreSearchOverlay, { api, ...props }));
  });
}

describe('ExploreSearchOverlay hardware back', () => {
  beforeEach(() => {
    mocks.listeners.length = 0;
    mocks.focused.value = true;
    mocks.addEventListener.mockClear();
    mocks.keyboardDismiss.mockClear();
  });

  it('closes the open search on Android back while its screen is focused', async () => {
    const onClose = vi.fn();
    const tree = await render({ visible: true, onClose });

    expect(mocks.listeners).toHaveLength(1);
    expect(pressBack()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.keyboardDismiss).toHaveBeenCalledTimes(1);

    await act(async () => tree.unmount());
  });

  it('claims nothing while hidden', async () => {
    const tree = await render({ visible: false, onClose: vi.fn() });

    expect(mocks.addEventListener).not.toHaveBeenCalled();

    await act(async () => tree.unmount());
  });

  it('releases the key under a route pushed from a result and reclaims it on return', async () => {
    // A result tap pushes the post over the tabs with the search still open
    // underneath. Back must pop the post first; only then does it close the
    // search. Holding the key here made the first press close the search out
    // of sight and left the post on screen.
    const onClose = vi.fn();
    const tree = await render({ visible: true, onClose });
    expect(mocks.listeners).toHaveLength(1);

    mocks.focused.value = false;
    await update(tree, { visible: true, onClose });
    expect(mocks.listeners).toHaveLength(0);
    expect(pressBack()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    mocks.focused.value = true;
    await update(tree, { visible: true, onClose });
    expect(mocks.listeners).toHaveLength(1);
    expect(pressBack()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => tree.unmount());
  });

  it('claims the key through the focus-gated shared hook, never a raw subscription', () => {
    const source = readFileSync('components/explore-search-overlay.tsx', 'utf8');

    expect(source).toContain('useHardwareBack(visible && isFocused, requestClose)');
    expect(source).toContain('useIsFocused()');
    expect(source).not.toContain('BackHandler');
  });
});
