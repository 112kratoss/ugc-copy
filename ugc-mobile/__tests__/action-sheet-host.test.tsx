import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; [key: string]: unknown };

const keyboard = vi.hoisted(() => ({ dismiss: vi.fn() }));

vi.mock('react-native', () => {
  const host = (name: string) => ({ children, ...props }: MockProps) => React.createElement(name, props, children);
  return {
    Alert: { alert: vi.fn() },
    Animated: { View: host('animated-view'), add: (value: unknown) => value, multiply: (value: unknown) => value },
    Keyboard: keyboard,
    Pressable: host('pressable'),
    Text: host('text'),
    View: host('view'),
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
vi.mock('@/components/overlay-host', () => ({
  Overlay: ({ visible, children }: MockProps) => (visible ? React.createElement('overlay', null, children) : null),
}));
vi.mock('@/components/sheet-chrome', () => ({
  SheetGrabber: () => null,
  SheetPanel: ({ children }: MockProps) => React.createElement('sheet-panel', null, children),
  sheetPanelStyle: () => ({}),
  useSheetDismissDrag: () => ({ translateY: null, backdropOpacity: null, contentPanHandlers: {} }),
  useSheetPresentation: () => ({ entryTranslateY: 0, backdropProgress: 1, onPanelLayout: () => undefined }),
}));
vi.mock('@/lib/haptics', () => ({ haptic: { light: vi.fn() } }));
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => false }));
vi.mock('@/lib/safe-area', () => ({ resolvedBottomInset: (inset: number) => inset }));
vi.mock('@/lib/theme-context', () => ({
  useAppTheme: () => ({ colors: { scrim: 'scrim', text: 'text', muted: 'muted', faint: 'faint', danger: 'danger', surface: 'surface', border: 'border' } }),
}));
vi.mock('@/lib/use-hardware-back', () => ({ useHardwareBack: () => undefined }));

import { ActionSheetHost } from '../components/action-sheet';
import { showActionSheet } from '../lib/action-sheet';

describe('ActionSheetHost', () => {
  beforeEach(() => { keyboard.dismiss.mockClear(); });

  // The sheet rises from the foot of the window, where the keyboard of the page it opens over
  // would cover its rows, with the keys still typing into the field behind its scrim. A Modal
  // took the focus by being a window of its own; an overlay is not, so it puts the keyboard away
  // itself, as the creator's own sheets do (the References tile opens one with the prompt's
  // keyboard up, 2026-10-21).
  it('puts the keyboard of the page it opens over away', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<ActionSheetHost />); });
    expect(keyboard.dismiss).not.toHaveBeenCalled();

    renderer.act(() => { showActionSheet({ title: 'Add a reference', actions: [{ label: 'Image', onPress: vi.fn() }] }); });
    expect(keyboard.dismiss).toHaveBeenCalledTimes(1);
    expect(tree.root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Image')).toHaveLength(1);
    renderer.act(() => { tree.unmount(); });
  });
});
