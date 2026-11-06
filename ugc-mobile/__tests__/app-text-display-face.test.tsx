// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { markDisplayFontLoaded } from '../lib/display-font-ready';
import { appTheme } from '../lib/theme';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

vi.mock('@/lib/haptics', () => ({ haptic: { select: vi.fn(), light: vi.fn() } }));

vi.mock('expo-router', () => ({
  Link: ({ children }: MockProps) => React.createElement('link', null, children),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: (props: MockProps) => React.createElement('text-input', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

import { AppText, BrandLockup } from '../components/ui';

type Style = Record<string, unknown>;
type Layout = { nativeEvent: { layout: { width: number } } };

/** The style a node draws with, flattened the way React Native flattens it. */
function flat(style: unknown): Style {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flat));
  return style && typeof style === 'object' ? (style as Style) : {};
}

function render(node: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(node);
  });
  return tree;
}

const layout = (width: number): Layout => ({ nativeEvent: { layout: { width } } });

// The face's loaded flag is process state, so these run in order: before, then after.
describe('display-face text before and after the face loads', () => {
  it('does not name the display face until it has loaded, so its first measurement is a true one', () => {
    const tree = render(<AppText variant="pageTitle">Magicbooklet</AppText>);
    const before = flat(tree.root.findByType('text' as never).props.style);
    expect('fontFamily' in before).toBe(true);
    expect(before.fontFamily).toBeUndefined();
    expect(before.fontSize).toBe(appTheme.type.pageTitle.fontSize);

    renderer.act(() => markDisplayFontLoaded());
    const after = flat(tree.root.findByType('text' as never).props.style);
    expect(after.fontFamily).toBe(appTheme.type.pageTitle.fontFamily);
  });

  it('leaves text outside the display roles alone', () => {
    const tree = render(<AppText variant="body" style={{ fontFamily: 'Menlo' }}>code</AppText>);
    expect(flat(tree.root.findByType('text' as never).props.style).fontFamily).toBe('Menlo');
  });

  it('sizes the hero wordmark down to the row it is given, and no further than the compact size', () => {
    const tree = render(<BrandLockup size="hero" />);
    const texts = () => tree.root.findAllByType('text' as never);
    const [visible, measurer] = texts();
    // The row: 258pt, of which the glyph and its gap take 40, leaving 218 for the name.
    const row = tree.root.findAll((node) => node.type === ('view' as never) && typeof node.props.onLayout === 'function')[0];
    renderer.act(() => {
      row.props.onLayout(layout(258));
      measurer.props.onLayout(layout(199));
    });
    // 199pt fits in 218: the full size.
    expect(flat(texts()[0].props.style).fontSize ?? appTheme.type.pageTitle.fontSize).toBe(appTheme.type.pageTitle.fontSize);
    expect(visible.props.numberOfLines).toBe(1);

    // A raised text size: the name is 269pt wide at the full size.
    renderer.act(() => texts()[1].props.onLayout(layout(269)));
    const fitted = flat(texts()[0].props.style).fontSize as number;
    expect(fitted).toBeLessThan(appTheme.type.pageTitle.fontSize);
    expect((269 * fitted) / appTheme.type.pageTitle.fontSize).toBeLessThanOrEqual(218);

    // Far too wide: held at the compact size, and cut with an ellipsis past it.
    renderer.act(() => texts()[1].props.onLayout(layout(600)));
    expect(flat(texts()[0].props.style).fontSize).toBe(appTheme.type.sectionTitle.fontSize);
  });

  it('keeps the compact lockup as it was', () => {
    const tree = render(<BrandLockup />);
    const texts = tree.root.findAllByType('text' as never);
    expect(texts).toHaveLength(1);
    expect(flat(texts[0].props.style).fontSize).toBe(appTheme.type.sectionTitle.fontSize);
  });
});
