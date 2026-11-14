import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

// What React Native's own keyboard module last heard: undefined leaves the area
// to the tracker, as a test that mocks the module down to `addListener` does.
// `tracker` is the Pixel 9a emulator's keyboard as Reanimated has it: 336dp with
// the navigation bar, and OPEN.
const reported = vi.hoisted(() => ({ visible: undefined as boolean | undefined, height: 0, tracker: 336 }));

vi.mock('react-native', () => ({
  Keyboard: {
    addListener: () => ({ remove: () => undefined }),
    isVisible: () => reported.visible,
    metrics: () => (reported.visible ? { height: reported.height } : undefined),
  },
  Platform: { OS: 'android' },
}));

vi.mock('react-native-reanimated', async () => {
  const actual = await vi.importActual<typeof import('./mocks/react-native-reanimated')>('./mocks/react-native-reanimated');
  return {
    ...actual,
    default: actual.default,
    useAnimatedKeyboard: () => ({ height: { value: reported.tracker }, state: { value: actual.KeyboardState.OPEN } }),
  };
});

afterEach(() => {
  reported.visible = undefined;
  reported.height = 0;
  reported.tracker = 336;
});

import { KeyboardAvoidingArea } from '../components/keyboard-aware';

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatStyle));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

function lift(element: React.ReactElement) {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  const area = tree!.root.findAll((node) => node.props.testID === 'keyboard-avoiding-area' && typeof node.type === 'string')[0];
  const padding = flatStyle(area.props.style).paddingBottom;
  renderer.act(() => tree!.unmount());
  return padding;
}

describe('KeyboardAvoidingArea', () => {
  it('gives way by the keyboard, less what the surface already keeps clear of the screen’s edge', () => {
    expect(lift(<KeyboardAvoidingArea><></></KeyboardAvoidingArea>)).toBe(336);
    // The resource editor's Save row pads for the navigation bar, and the keyboard covers that strip.
    expect(lift(<KeyboardAvoidingArea reservedBottomInset={48}><></></KeyboardAvoidingArea>)).toBe(288);
  });

  // A sheet that opens over the page's keyboard puts that keyboard away, and
  // the keys are still leaving when the sheet's area mounts. An area that
  // followed them moved and resized the sheet at every frame of its slide: it
  // came into view part-way up, sank and rose again (emulator films,
  // 2026-10-05). Mounted told not to follow, the area gives the old keyboard
  // nothing and the sheet opens at its resting shape.
  it('gives a keyboard nothing while it is mounted not following it', () => {
    expect(lift(<KeyboardAvoidingArea followsKeyboard={false}><></></KeyboardAvoidingArea>)).toBe(0);
    expect(lift(<KeyboardAvoidingArea followsKeyboard={false} reservedBottomInset={48}><></></KeyboardAvoidingArea>)).toBe(0);
  });

  // The tracker above says "open, 336", as Reanimated tells an area that
  // subscribes after a keyboard left with no area listening. React Native's own
  // module saw that keyboard go, so the area mounts believing it: the sign-in wall
  // and Withdraw otherwise drew a keyboard-sized band with no keyboard (Pixel 9a
  // emulator; the owner's S24, 2026-11-14).
  it('gives nothing to a keyboard React Native last saw leave', () => {
    reported.visible = false;
    expect(lift(<KeyboardAvoidingArea><></></KeyboardAvoidingArea>)).toBe(0);
  });

  it('lets the tracker lead while React Native says the keyboard is up', () => {
    reported.visible = true;
    expect(lift(<KeyboardAvoidingArea><></></KeyboardAvoidingArea>)).toBe(336);
  });

  // A height read as the area mounts may be a keyboard already leaving, whose hide
  // the area may never hear (iOS counts it down only at keyboardDidHide), so the
  // area takes only "up or down" from React Native at mount, never a height.
  it('takes no height from React Native as it mounts', () => {
    reported.visible = true;
    reported.height = 312;
    reported.tracker = 0;
    expect(lift(<KeyboardAvoidingArea><></></KeyboardAvoidingArea>)).toBe(0);
  });
});
