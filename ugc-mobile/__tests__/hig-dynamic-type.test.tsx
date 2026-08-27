// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { appTheme } from '../lib/theme';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

vi.mock('expo-router', () => ({
  Link: ({ children }: MockProps) => React.createElement('link', null, children),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', props, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: (props: MockProps) => React.createElement('text-input', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

import { AppText, AppTextInput, PrimaryButton } from '../components/ui';

function renderNode(node: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(node);
  });
  return tree;
}

/**
 * The Dynamic Type policy (F1). Typography: "all text styles scale
 * proportionally" — so nothing may opt out — and "not all content scales
 * equally: secondary items may remain smaller", which is what the per-tier
 * caps in `appTheme.typeScale` encode. A new variant lands in a tier here or
 * fails.
 */
describe('dynamic type policy (HIG F1)', () => {
  it('caps titles at the title tier so hierarchy survives giant sizes', () => {
    for (const variant of ['display', 'pageTitle', 'sectionTitle', 'metric'] as const) {
      const tree = renderNode(<AppText variant={variant}>Title</AppText>);
      expect(tree.root.findByType('text' as never).props.maxFontSizeMultiplier)
        .toBe(appTheme.typeScale.title);
    }
  });

  it('lets running text follow the reader furthest', () => {
    for (const variant of ['body', 'bodySm'] as const) {
      const tree = renderNode(<AppText variant={variant}>Body</AppText>);
      expect(tree.root.findByType('text' as never).props.maxFontSizeMultiplier)
        .toBe(appTheme.typeScale.body);
    }
  });

  it('keeps controls and metadata at the control tier', () => {
    for (const variant of ['cardTitle', 'label', 'caption', 'button'] as const) {
      const tree = renderNode(<AppText variant={variant}>Label</AppText>);
      expect(tree.root.findByType('text' as never).props.maxFontSizeMultiplier)
        .toBe(appTheme.typeScale.control);
    }
  });

  it('caps text inputs at the control tier', () => {
    const tree = renderNode(<AppTextInput label="Name" value="" onChangeText={() => undefined} />);
    expect(tree.root.findByType('text-input' as never).props.maxFontSizeMultiplier)
      .toBe(appTheme.typeScale.control);
  });

  it('scales button labels under the control cap so the 48pt target holds', () => {
    const tree = renderNode(<PrimaryButton label="Continue" />);
    const label = tree.root.findAll((node) => String(node.type) === 'text'
      && node.props.children === 'Continue')[0];
    expect(label?.props.maxFontSizeMultiplier).toBe(appTheme.typeScale.control);
  });

  it('never opts any text out of Dynamic Type', () => {
    const mobileRoot = path.resolve(__dirname, '..');
    const files: string[] = [];
    const walk = (root: string) => {
      for (const entry of readdirSync(root)) {
        const absolute = path.join(root, entry);
        if (statSync(absolute).isDirectory()) walk(absolute);
        else if (/\.tsx?$/.test(entry)) files.push(absolute);
      }
    };
    for (const root of ['app', 'components', 'lib']) walk(path.join(mobileRoot, root));

    const offenders = files.filter((file) => /allowFontScaling\s*=\s*\{?\s*false/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
