// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const mocks = vi.hoisted(() => ({ dismissKeyboard: vi.fn() }));

vi.mock('react-native', () => {
  const host = (name: string) => ({ children, ...props }: MockProps) => React.createElement(name, props, children);
  return {
    Animated: { View: host('animated-view') },
    Keyboard: { dismiss: mocks.dismissKeyboard },
    Platform: { OS: 'ios' },
    Pressable: ({ children, style: _style, ...props }: MockProps) => React.createElement('pressable', props, children),
    StatusBar: { currentHeight: 0 },
    Text: host('text'),
    View: host('view'),
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 55, bottom: 24, left: 0, right: 0 }),
}));

// The sheet's motion and drag have tests of their own; here they only need to be there.
vi.mock('@/components/sheet-chrome', () => ({
  SheetGrabber: () => React.createElement('sheet-grabber'),
  SheetPanel: ({ children, ...props }: MockProps) => React.createElement('sheet-panel', props, children),
  sheetPanelStyle: () => ({}),
  useSheetDismissDrag: () => ({ contentPanHandlers: {}, translateY: null, backdropOpacity: null }),
  useSheetPresentation: () => ({ entryTranslateY: 0, backdropProgress: 1, onPanelLayout: () => undefined }),
}));
vi.mock('@/lib/use-hardware-back', () => ({ useHardwareBack: () => undefined }));
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => false }));
vi.mock('@/lib/haptics', () => ({ haptic: { light: () => undefined } }));

import { ActionSheetHost } from '../components/action-sheet';
import { showActionSheet } from '../lib/action-sheet';

function texts(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
}

beforeEach(() => {
  mocks.dismissKeyboard.mockClear();
});

describe('the action sheet', () => {
  it('puts the keyboard of the page under it away each time a sheet is asked for', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<ActionSheetHost />);
    });
    expect(mocks.dismissKeyboard).not.toHaveBeenCalled();

    // Report from a comment's ••• with the composer's keyboard up (Pixel_9a, 2026-10-22).
    act(() => showActionSheet({ title: 'Why are you reporting this?', actions: [{ label: 'Spam' }] }));
    expect(texts(tree)).toContain('Why are you reporting this?');
    expect(mocks.dismissKeyboard).toHaveBeenCalledTimes(1);

    // A row that opens the next sheet asks again, as Comment options asks for Report.
    act(() => showActionSheet({ title: 'Change visibility', actions: [{ label: 'Public' }] }));
    expect(texts(tree)).toContain('Change visibility');
    expect(mocks.dismissKeyboard).toHaveBeenCalledTimes(2);

    act(() => tree.unmount());
  });
});
