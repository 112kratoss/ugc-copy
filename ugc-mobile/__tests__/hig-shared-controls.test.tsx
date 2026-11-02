// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MIN_HIT_TARGET_PT } from '../lib/hit-target';
import { appTheme, themes } from '../lib/theme';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const haptics = vi.hoisted(() => ({ select: vi.fn(), light: vi.fn() }));

vi.mock('@/lib/haptics', () => ({ haptic: haptics }));

vi.mock('expo-router', () => ({
  Link: ({ children }: MockProps) => React.createElement('link', null, children),
}));

// A pressable carries its style resolved at rest, and pressed beside it.
vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
    pressedStyle: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: true }) : style,
  }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: (props: MockProps) => React.createElement('text-input', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

import { IconButton, PrimaryButton, SecondaryButton, SegmentedControl } from '../components/ui';

const colors = themes.dark.colors;
type Style = Record<string, unknown>;

function renderNode(node: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(node);
  });
  return tree;
}

function hosts(tree: renderer.ReactTestRenderer, type: string) {
  return tree.root.findAll((node) => node.type === type);
}

function flatStyle(style: unknown): Style {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatStyle));
  return (style ?? {}) as Style;
}

function GlyphStub({ color, size }: { color?: string; size?: number }) {
  return React.createElement('glyph', { color, size });
}

const ORDERS = [
  { value: 'top', label: 'Top' },
  { value: 'newest', label: 'New' },
] as const;

beforeEach(() => {
  haptics.select.mockClear();
  haptics.light.mockClear();
});

/**
 * Segmented controls: "a segmented control offers a single choice from among a
 * set of options". The app draws it once (`SegmentedControl`); until November
 * 2026 it was drawn by hand seven times, with three track fills, three label
 * sizes and a haptic on two of them.
 */
describe('the segmented control', () => {
  function control(props: Partial<React.ComponentProps<typeof SegmentedControl<'top' | 'newest'>>> = {}) {
    const onChange = vi.fn();
    const tree = renderNode(
      <SegmentedControl accessibilityLabel="Sort comments" options={ORDERS} value="top" onChange={onChange} {...props} />,
    );
    const [track] = hosts(tree, 'view');
    const segments = hosts(tree, 'pressable');
    return { tree, onChange, track, segments };
  }

  it('draws a capsule track in the inset fill, its thumbs 4pt inside it', () => {
    const { track, segments } = control();
    const trackStyle = flatStyle(track.props.style);
    expect(trackStyle).toMatchObject({
      flexDirection: 'row',
      borderRadius: appTheme.radii.pill,
      padding: appTheme.spacing.unit,
      gap: appTheme.spacing.unit,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceInset,
    });
    // Capsules keep circular ends (design-mobile.md → Radius).
    expect(trackStyle).not.toHaveProperty('borderCurve');
    for (const segment of segments) {
      expect(segment.props.style.borderRadius).toBe(appTheme.radii.pill);
      expect(segment.props.style).not.toHaveProperty('borderCurve');
    }
  });

  it('is as tall as a button, and each segment answers to the whole track', () => {
    const { segments } = control();
    for (const segment of segments) {
      const { top, bottom } = segment.props.hitSlop as { top: number; bottom: number };
      const reach = segment.props.style.minHeight + top + bottom;
      expect(reach).toBe(appTheme.touch.default);
      expect(reach).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PT);
    }
  });

  it('fills the choice in use with coral and ink, the others with nothing', () => {
    const { segments, tree } = control();
    expect(segments[0].props.style.backgroundColor).toBe(colors.primaryFill);
    expect(segments[1].props.style.backgroundColor).toBe('transparent');
    expect(segments[1].props.pressedStyle.backgroundColor).toBe(colors.pressed);
    const labels = hosts(tree, 'text');
    expect(labels.map((label) => flatStyle(label.props.style).color)).toEqual([colors.onPrimary, colors.muted]);
    // One type role for every label: `label`, capped at the control tier.
    for (const label of labels) {
      expect(flatStyle(label.props.style)).toMatchObject(appTheme.type.label);
      expect(label.props.maxFontSizeMultiplier).toBe(appTheme.typeScale.control);
      expect(label.props.numberOfLines).toBe(1);
    }
  });

  it('is a radio group that picks a setting by default', () => {
    const { track, segments } = control();
    expect(track.props).toMatchObject({ accessibilityRole: 'radiogroup', accessibilityLabel: 'Sort comments' });
    expect(segments.map((segment) => [segment.props.accessibilityRole, segment.props.accessibilityLabel, segment.props.accessibilityState]))
      .toEqual([
        ['radio', 'Top', { checked: true, disabled: false }],
        ['radio', 'New', { checked: false, disabled: false }],
      ]);
  });

  it('is a tab list when it switches the view below it, and speaks a segment by its own name', () => {
    const { track, segments } = control({
      role: 'tab',
      options: [
        { value: 'top', label: 'Sign in', accessibilityLabel: 'Switch to sign in' },
        { value: 'newest', label: 'Sign up', accessibilityLabel: 'Switch to sign up' },
      ],
    });
    expect(track.props.accessibilityRole).toBe('tablist');
    expect(segments.map((segment) => [segment.props.accessibilityRole, segment.props.accessibilityLabel, segment.props.accessibilityState]))
      .toEqual([
        ['tab', 'Switch to sign in', { selected: true, disabled: false }],
        ['tab', 'Switch to sign up', { selected: false, disabled: false }],
      ]);
  });

  it('ticks and answers only for a real change', () => {
    const { segments, onChange } = control();
    renderer.act(() => { segments[0].props.onPress(); });
    expect(onChange).not.toHaveBeenCalled();
    expect(haptics.select).not.toHaveBeenCalled();

    renderer.act(() => { segments[1].props.onPress(); });
    expect(onChange).toHaveBeenCalledWith('newest');
    expect(haptics.select).toHaveBeenCalledTimes(1);
  });

  it('shares the row equally, or sizes each segment to its word beside a title', () => {
    expect(control().segments.map((segment) => segment.props.style.flex)).toEqual([1, 1]);
    const hugging = control({ fill: false }).segments;
    expect(hugging.map((segment) => segment.props.style.flex)).toEqual([undefined, undefined]);
    for (const segment of hugging) expect(segment.props.style.minWidth).toBe(appTheme.touch.default);
  });

  it('dims and refuses every segment while it is unavailable', () => {
    const { track, segments } = control({ disabled: true });
    expect(flatStyle(track.props.style).opacity).toBe(appTheme.opacity.disabled);
    for (const segment of segments) {
      expect(segment.props.disabled).toBe(true);
      expect(segment.props.accessibilityState.disabled).toBe(true);
    }
  });
});

/**
 * Buttons of one role have one height and one press feel: the hand-built
 * capsules this replaced were 44, 48, 50 and 54pt tall, most with no press
 * state but opacity.
 */
describe('the button primitives', () => {
  it('draws a glyph beside the label in its colour, sized to its type role', () => {
    const primary = renderNode(<PrimaryButton label="Edit profile" icon={GlyphStub} onPress={() => undefined} />);
    expect(hosts(primary, 'glyph')[0].props).toEqual({ color: colors.onPrimary, size: appTheme.icon.compact });

    const secondary = renderNode(<SecondaryButton label="Add shot" icon={GlyphStub} trailingIcon={GlyphStub} onPress={() => undefined} />);
    expect(hosts(secondary, 'glyph').map((glyph) => glyph.props)).toEqual([
      { color: colors.text, size: appTheme.icon.sm },
      { color: colors.text, size: appTheme.icon.sm },
    ]);
  });

  it('draws an element it is handed as it is, for a glyph with a motion of its own', () => {
    const tree = renderNode(<SecondaryButton label="Save" icon={<GlyphStub color="custom" size={1} />} onPress={() => undefined} />);
    expect(hosts(tree, 'glyph')[0].props).toEqual({ color: 'custom', size: 1 });
  });

  it('puts the activity indicator in the glyph\'s place while it waits, beside the waiting label', () => {
    const tree = renderNode(<PrimaryButton label="Publish" loadingLabel="Publishing…" loading icon={GlyphStub} trailingIcon={GlyphStub} />);
    expect(hosts(tree, 'glyph')).toHaveLength(0);
    expect(hosts(tree, 'activity-indicator')).toHaveLength(1);
    expect(hosts(tree, 'text').map((text) => text.props.children)).toEqual(['Publishing…']);
    expect(hosts(tree, 'pressable')[0].props.accessibilityState).toEqual({ busy: true, disabled: true });
  });

  it('takes the roomy height only when asked, for the action that closes a footer', () => {
    const minHeight = (node: React.ReactElement) => hosts(renderNode(node), 'pressable')[0].props.style.minHeight;
    expect(minHeight(<PrimaryButton label="Next" />)).toBe(appTheme.touch.default);
    expect(minHeight(<PrimaryButton label="Next" size="roomy" />)).toBe(appTheme.touch.roomy);
    expect(minHeight(<SecondaryButton label="Public" />)).toBe(appTheme.touch.default);
    expect(minHeight(<SecondaryButton label="Public" size="roomy" />)).toBe(appTheme.touch.roomy);
  });

  it('tints a supporting action in its tool\'s accent', () => {
    const tree = renderNode(<SecondaryButton label="Enhance shot" accent="primary" icon={GlyphStub} />);
    const style = hosts(tree, 'pressable')[0].props.style;
    expect(style.backgroundColor).toBe(`${colors.primary}1f`);
    expect(style.borderColor).toBe(`${colors.primary}55`);
    expect(hosts(tree, 'glyph')[0].props.color).toBe(colors.primary);
  });

  it('lays itself out from `style` without changing its look', () => {
    const tree = renderNode(<SecondaryButton label="Share profile" style={{ flex: 1 }} />);
    expect(flatStyle(hosts(tree, 'view')[0].props.style)).toMatchObject({ flex: 1 });
    expect(hosts(tree, 'pressable')[0].props.style.borderRadius).toBe(appTheme.radii.pill);
  });

  it('speaks a name of its own where the drawn label is a number', () => {
    const tree = renderNode(<SecondaryButton label="12" accessibilityLabel="Comments" accessibilityValue={{ text: '12 comments' }} />);
    expect(hosts(tree, 'pressable')[0].props).toMatchObject({ accessibilityLabel: 'Comments', accessibilityValue: { text: '12 comments' } });
  });

  it('draws an icon button as a filled 48pt circle, the glyph at Back and Close\'s size', () => {
    const tree = renderNode(<IconButton icon={GlyphStub} label="Close" onPress={() => undefined} />);
    const [pressable] = hosts(tree, 'pressable');
    expect(pressable.props.style).toMatchObject({
      minHeight: appTheme.touch.default,
      minWidth: appTheme.touch.default,
      borderRadius: appTheme.radii.pill,
      backgroundColor: colors.surfaceStrong,
    });
    expect(pressable.props.pressedStyle.backgroundColor).toBe(colors.pressed);
    expect(hosts(tree, 'glyph')[0].props).toEqual({ color: colors.text, size: appTheme.icon.feature });
  });

  it('leaves the circle out of a plain icon button until it is pressed', () => {
    const [pressable] = hosts(renderNode(<IconButton icon={GlyphStub} label="Go back" variant="plain" />), 'pressable');
    expect(pressable.props.style.backgroundColor).toBe('transparent');
    expect(pressable.props.pressedStyle.backgroundColor).toBe(colors.pressed);
  });
});

/**
 * The guard the corner-radius guards could not be: a shape a screen draws for
 * itself drifts from the one the primitive draws, as the sign-in switch did.
 * A segmented control is drawn only by `SegmentedControl`.
 */
const mobileRoot = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(name) ? [full] : [];
  });
}

function openingTags(source: string, tagName: string) {
  const found: Array<{ tag: string; start: number; end: number }> = [];
  const pattern = new RegExp(`<${tagName}\\b`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    let depth = 0;
    let end = -1;
    for (let index = match.index; index < source.length; index += 1) {
      const character = source[index];
      if (character === '{' || character === '(') depth += 1;
      else if (character === '}' || character === ')') depth -= 1;
      else if (character === '>' && depth === 0) { end = index; break; }
    }
    if (end !== -1) found.push({ tag: source.slice(match.index, end + 1), start: match.index, end: end + 1 });
  }
  return found;
}

/**
 * Two signatures: a tab or radio drawn as a capsule, and a capsule track whose
 * children are mapped choices with a selected or checked state (the shot mode
 * and Full/Light were buttons). Both were true of every copy this replaced.
 */
function handDrawnSegments(source: string) {
  const line = (index: number) => source.slice(0, index).split('\n').length;
  const capsuleChoices = openingTags(source, 'Pressable')
    .filter(({ tag }) => tag.includes('radii.pill') && /accessibilityRole=("(tab|radio)"|\{[^}]*'(tab|radio)')/.test(tag))
    .map(({ start }) => `${line(start)}: a tab or radio drawn as a capsule`);
  const tracks = ['View', 'ScrollView'].flatMap((tagName) => openingTags(source, tagName)
    .filter(({ tag, end }) => tag.includes('radii.pill')
      && /padding: (2|4|appTheme\.spacing\.unit)\b/.test(tag)
      && source.slice(end, end + 900).includes('.map(')
      && /accessibilityState=\{\{[^}]*\b(selected|checked)\b/.test(source.slice(end, end + 900)))
    .map(({ start }) => `${line(start)}: a capsule track of choices`));
  return [...capsuleChoices, ...tracks];
}

/** Capsule choices that are not segmented controls, each with its reason. Counted, so one more fails. */
const EXEMPT: Record<string, { count: number; reason: string }> = {
  'components/magic-tab-bar.tsx': { count: 1, reason: 'the dock: a tab bar, not a segmented control' },
  'components/profile-dashboard.tsx': { count: 1, reason: 'Active, Archived and Failed with counts: filter chips that wrap at large text sizes' },
  'components/explore-search-overlay.tsx': {
    count: 1,
    reason: "search's scope (Top, Creators, Posts, Recipes), a segmented control by the HIG and the next to move onto SegmentedControl; it needs a per-segment disabled state",
  },
};

describe('one segmented control (the shape lives in one place)', () => {
  it('finds the hand-drawn control this suite replaced', () => {
    // The sign-in switch as it was, so a green run below means "none found", not "none looked at".
    const modeTabs = `
      <View style={{ flexDirection: 'row', gap: 4, padding: 4, borderRadius: appTheme.radii.pill, backgroundColor: theme.colors.surfaceInset }}>
        {(['login', 'signup'] as const).map((item) => (
          <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: item === mode }}
            style={({ pressed }) => ({ flex: 1, minHeight: appTheme.touch.compact, borderRadius: appTheme.radii.pill })}>
            <Text>{item}</Text>
          </Pressable>
        ))}
      </View>`;
    expect(handDrawnSegments(modeTabs)).toEqual(['4: a tab or radio drawn as a capsule', '2: a capsule track of choices']);

    // And Full/Light as it was: a capsule track of buttons with a selected state.
    const enhanceLevel = `
      <View style={{ flexDirection: 'row', borderRadius: appTheme.radii.pill, borderWidth: 1, padding: 2 }}>
        {LEVELS.map(([value, label]) => (
          <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: level === value, disabled }}
            style={({ pressed }) => ({ minHeight: 32, borderRadius: appTheme.radii.pill })} />
        ))}
      </View>`;
    expect(handDrawnSegments(enhanceLevel)).toEqual(['2: a capsule track of choices']);
  });

  it('draws every segmented control in the app with SegmentedControl', () => {
    const found: Record<string, string[]> = {};
    for (const file of [...sourceFiles(path.join(mobileRoot, 'app')), ...sourceFiles(path.join(mobileRoot, 'components'))]) {
      const relative = path.relative(mobileRoot, file);
      if (relative === path.join('components', 'ui.tsx')) continue;
      const hits = handDrawnSegments(readFileSync(file, 'utf8'));
      if (hits.length > 0) found[relative] = hits;
    }

    const unexpected = Object.entries(found)
      .filter(([file, hits]) => hits.length !== EXEMPT[file]?.count)
      .map(([file, hits]) => `${file}: ${hits.join('; ')}`);
    expect(unexpected).toEqual([]);
    // An exemption whose control has gone is one to remove.
    expect(Object.keys(EXEMPT).filter((file) => !found[file])).toEqual([]);
  });
});
