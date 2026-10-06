import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

// The Pixel 9a emulator's keyboard, as the tracker has it: 336dp with the navigation bar.
vi.mock('react-native', () => ({
  Keyboard: { addListener: () => ({ remove: () => undefined }) },
  Platform: { OS: 'android' },
}));

vi.mock('react-native-reanimated', async () => {
  const actual = await vi.importActual<typeof import('./mocks/react-native-reanimated')>('./mocks/react-native-reanimated');
  return {
    ...actual,
    default: actual.default,
    useAnimatedKeyboard: () => ({ height: { value: 336 }, state: { value: actual.KeyboardState.OPEN } }),
  };
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
});
