// Define React Native development global.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;
type Motion = { kind: 'spring' | 'timing'; toValue: number; duration?: number; stiffness?: number; useNativeDriver?: boolean };

const mocks = vi.hoisted(() => {
  // Models React Native's BackHandler: listeners are consulted newest-first.
  const backListeners: Array<() => boolean> = [];
  return {
    backListeners,
    motions: [] as Motion[],
    order: [] as string[],
    haptic: vi.fn(),
    focus: vi.fn(),
    reducedMotion: false,
    keyboardHeight: 0,
  };
});

vi.mock('react-native', () => {
  const host = (name: string) => ({ children, ...props }: MockProps) => React.createElement(name, props, children);
  class Value {
    constructor(public value: number, public config?: { useNativeDriver: boolean }) {}
    interpolate(config: unknown) {
      return { interpolated: config };
    }
  }
  // An animation that is over the moment it starts: what is asserted is which
  // one was asked for, and what follows it.
  const run = (kind: Motion['kind']) => (value: Value, config: Omit<Motion, 'kind'>) => ({
    start(done?: (result: { finished: boolean }) => void) {
      mocks.motions.push({ kind, ...config });
      value.value = config.toValue;
      done?.({ finished: true });
    },
    stop: () => undefined,
  });
  return {
    AccessibilityInfo: { sendAccessibilityEvent: mocks.focus },
    Animated: { Value, View: host('animated-view'), spring: run('spring'), timing: run('timing') },
    BackHandler: {
      addEventListener: (_event: string, listener: () => boolean) => {
        mocks.backListeners.push(listener);
        return { remove: () => mocks.backListeners.splice(mocks.backListeners.indexOf(listener), 1) };
      },
    },
    Easing: { out: (curve: unknown) => curve, cubic: 'cubic' },
    Keyboard: {
      isVisible: () => mocks.keyboardHeight > 0,
      metrics: () => (mocks.keyboardHeight > 0 ? { height: mocks.keyboardHeight } : undefined),
    },
    Platform: { OS: 'android' },
    Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
      ...props,
      style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
    }, children),
    ScrollView: host('scroll-view'),
    StyleSheet: { absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } },
    Text: host('text'),
    View: host('view'),
    useWindowDimensions: () => ({ width: 411, height: 923, scale: 2.625, fontScale: 1 }),
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 55, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('@/lib/appearance', () => ({ useResolvedColorScheme: () => 'light' }));
vi.mock('@/lib/haptics', () => ({ haptic: { light: mocks.haptic } }));
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => mocks.reducedMotion }));

import { AnchoredMenu, type AnchoredMenuProps } from '../components/anchored-menu';
import { menuAction, type NativeMenuModel } from '../lib/native-menu';
import { appTheme } from '../lib/theme';

const select = (id: string) => () => mocks.order.push(`select:${id}`);

const model: NativeMenuModel = {
  quickActions: [
    menuAction({ id: 'save', label: 'Save', systemImage: 'bookmark', onSelect: select('save') }),
    menuAction({ id: 'share', label: 'Share', systemImage: 'square.and.arrow.up', onSelect: select('share') }),
  ],
  sections: [
    {
      id: 'post',
      items: [
        menuAction({ id: 'details', label: 'View details', systemImage: 'info.circle', onSelect: select('details') }),
        menuAction({
          id: 'download',
          label: 'Download media',
          subtitle: 'This post is archived',
          systemImage: 'arrow.down.circle',
          disabled: true,
          onSelect: select('download'),
        }),
      ],
    },
    {
      id: 'safety',
      items: [
        menuAction({ id: 'report', label: 'Report content', systemImage: 'flag', destructive: true, onSelect: select('report') }),
      ],
    },
  ],
};

/** The button, at the right edge of a Pixel 9a, a third of the way down. */
const anchor = { x: 355, y: 300, width: 48, height: 48 };

/** What a device answers when a view is measured: the layer fills the window, the panel is 248 x 260. */
const measurable = {
  createNodeMock: () => ({
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 411, 923),
    measure: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 248, 260),
  }),
};

function menu(overrides: Partial<AnchoredMenuProps> = {}) {
  return (
    <AnchoredMenu
      anchor={anchor}
      model={model}
      open
      accessibilityLabel="More options"
      onDismiss={() => mocks.order.push('dismiss')}
      onExited={() => mocks.order.push('exited')}
      {...overrides}
    />
  );
}

function render(element: React.ReactElement, options?: Parameters<typeof renderer.create>[1]) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(element, options);
  });
  return tree;
}

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatStyle));
  return (style as Record<string, unknown> | null | undefined) ?? {};
}

const panelStyle = (tree: renderer.ReactTestRenderer) => flatStyle(tree.root.findByType('animated-view' as never).props.style);
const items = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => (
  (node.type as unknown) === 'pressable' && node.props.accessibilityRole === 'menuitem'
));
const item = (tree: renderer.ReactTestRenderer, label: string) => {
  const found = items(tree).find((node) => node.props.accessibilityLabel === label);
  if (!found) throw new Error(`no menu item labelled ${label}`);
  return found;
};

beforeEach(() => {
  mocks.motions.length = 0;
  mocks.order.length = 0;
  mocks.backListeners.length = 0;
  mocks.haptic.mockClear();
  mocks.focus.mockClear();
  mocks.reducedMotion = false;
  mocks.keyboardHeight = 0;
});

describe("Android's menu", () => {
  it("draws the quick actions as one row of icons, then each section's rows after a divider", () => {
    const tree = render(menu(), measurable);

    expect(items(tree).map((node) => node.props.accessibilityLabel))
      .toEqual(['Save', 'Share', 'View details', 'Download media', 'Report content']);
    // The icon row's cells share its width; a section row is as wide as the panel.
    expect(flatStyle(item(tree, 'Save').props.style).flex).toBe(1);
    expect(flatStyle(item(tree, 'View details').props.style).flex).toBeUndefined();
    // Every row draws its icon, at the size the icon ramp gives a control.
    for (const node of items(tree)) {
      const icon = node.findAll((child) => child.props.size === appTheme.icon.default);
      expect(icon.length, String(node.props.accessibilityLabel)).toBeGreaterThan(0);
    }
  });

  it('keeps a row that cannot be chosen in view, with its reason, and takes no press on it', () => {
    const tree = render(menu(), measurable);
    const download = item(tree, 'Download media');

    expect(download.props.disabled).toBe(true);
    expect(download.props.accessibilityState).toEqual({ disabled: true });
    expect(download.props.accessibilityHint).toBe('This post is archived');
    expect(flatStyle(download.props.style).opacity).toBe(appTheme.opacity.disabled);
  });

  it('marks the current value of a pick-one list for TalkBack and on the leading edge', () => {
    const tree = render(menu({
      model: {
        quickActions: [],
        sections: [{
          id: 'visibility',
          items: [
            menuAction({ id: 'public', label: 'Public', checked: false, onSelect: select('public') }),
            menuAction({ id: 'private', label: 'Private', checked: true, onSelect: select('private') }),
          ],
        }],
      },
    }), measurable);

    expect(item(tree, 'Public').props.accessibilityState).toEqual({ disabled: false, checked: false });
    expect(item(tree, 'Private').props.accessibilityState).toEqual({ disabled: false, checked: true });
    const marks = (label: string) => item(tree, label).findAll((child) => child.props.size === appTheme.icon.default).length;
    expect(marks('Public')).toBe(0);
    expect(marks('Private')).toBeGreaterThan(0);
  });

  it('waits out of sight until it has been measured, then grows out of its button', () => {
    const unmeasured = render(menu());
    expect(panelStyle(unmeasured).left).toBeLessThan(-1000);
    expect(mocks.motions).toEqual([]);

    const tree = render(menu(), measurable);
    const style = panelStyle(tree);
    // Under the button, sharing its right edge; growing from the point under its centre.
    expect(style.left).toBe(355 + 48 - 248);
    expect(style.top).toBe(300 + 48 + 4);
    expect(style.transformOrigin).toEqual([224, 0, 0]);
    expect(mocks.motions).toEqual([{ kind: 'spring', toValue: 1, useNativeDriver: true, ...appTheme.motion.spring.menu }]);
    // TalkBack's focus follows it in.
    expect(mocks.focus).toHaveBeenCalledWith(expect.anything(), 'focus');
  });

  it('is native-driven from its first value, on scale and opacity alone', () => {
    const tree = render(menu(), measurable);
    const style = panelStyle(tree);

    expect(Object.keys(flatStyle((style.transform as unknown[])[0]))).toEqual(['scale']);
    expect((style.transform as unknown[]).length).toBe(1);
    expect(style.opacity).toBeDefined();
    expect(mocks.motions.every((motion) => motion.useNativeDriver === true)).toBe(true);
  });

  it('runs a chosen row once the menu has been told to close, with a tick', () => {
    const tree = render(menu(), measurable);

    act(() => item(tree, 'View details').props.onPress());
    expect(mocks.order).toEqual(['dismiss', 'select:details']);
    expect(mocks.haptic).toHaveBeenCalledTimes(1);

    mocks.order.length = 0;
    act(() => item(tree, 'Share').props.onPress());
    expect(mocks.order).toEqual(['dismiss', 'select:share']);
  });

  it('closes on a touch outside as the finger lands, and on the back key', () => {
    const tree = render(menu(), measurable);
    const backdrop = tree.root.findByProps({ accessibilityLabel: 'Close menu' });

    act(() => backdrop.props.onPressIn());
    expect(mocks.order).toEqual(['dismiss']);

    mocks.order.length = 0;
    expect(mocks.backListeners).toHaveLength(1);
    let handled = false;
    act(() => {
      handled = mocks.backListeners[0]();
    });
    expect(handled).toBe(true);
    expect(mocks.order).toEqual(['dismiss']);
  });

  it('plays a shorter exit, takes no touch while it leaves, and then says it has gone', () => {
    const tree = render(menu(), measurable);
    mocks.motions.length = 0;

    act(() => tree.update(menu({ open: false })));

    expect(mocks.motions).toEqual([
      expect.objectContaining({ kind: 'timing', toValue: 0, duration: appTheme.motion.duration.menuExit, useNativeDriver: true }),
    ]);
    expect(mocks.order).toEqual(['exited']);
    expect(tree.root.findByType('view' as never).props.pointerEvents).toBe('none');
    // The back key is the navigator's again.
    expect(mocks.backListeners).toHaveLength(0);
  });

  it('has no exit to play when it was closed before it was ever drawn', () => {
    const tree = render(menu());
    act(() => tree.update(menu({ open: false })));

    expect(mocks.motions).toEqual([]);
    expect(mocks.order).toEqual(['exited']);
  });

  it('fades in place under Reduce Motion: nothing grows', () => {
    mocks.reducedMotion = true;
    const tree = render(menu(), measurable);

    expect(panelStyle(tree).transform).toBeUndefined();
    expect(mocks.motions).toEqual([expect.objectContaining({ kind: 'timing', toValue: 1 })]);
  });

  it('stays out from under the status bar, the navigation bar and the keys', () => {
    const margin = appTheme.spacing.compact;
    expect(panelStyle(render(menu(), measurable)).maxHeight).toBe(923 - 24 - margin - (55 + margin));

    // Android reports the keys' height from the top of the navigation bar.
    mocks.keyboardHeight = 300;
    expect(panelStyle(render(menu(), measurable)).maxHeight).toBe(923 - (24 + 300) - margin - (55 + margin));
  });
});
